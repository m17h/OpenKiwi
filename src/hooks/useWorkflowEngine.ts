import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import { commandSandbox, threadStartParams, turnStartParams } from "../lib/turnConfig";
import {
  interpolateWorkflowText,
  nextWorkflowRunAt,
  normalizeWorkflow,
  shouldRunWorkflowStep,
  validateWorkflow,
  workflowPrompt,
  workflowStepRetries,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type WorkflowRunSource,
  type WorkflowRunStepRecord,
} from "../lib/workflows";
import type { CustomAgentProfile, Project, Thread, Turn } from "../types";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "interrupted", "error"]);

class WorkflowStoppedError extends Error {
  constructor() {
    super("Workflow was stopped.");
  }
}

interface ActiveWorkflowRun {
  runId: string;
  stopRequested: boolean;
  threadId?: string;
  turnId?: string;
  processId?: string;
  cancelWait?: () => void;
  publish: (patch: Partial<WorkflowRunRecord>) => void;
}

function replaceStep(
  steps: WorkflowRunStepRecord[],
  stepId: string,
  patch: Partial<WorkflowRunStepRecord>,
): WorkflowRunStepRecord[] {
  return steps.map((step) => step.stepId === stepId ? { ...step, ...patch } : step);
}

function workflowVariables(
  workflow: WorkflowDefinition,
  project: Project,
  source: WorkflowRunSource,
  runId: string,
  startedAt: number,
  overrides: Record<string, string>,
): Record<string, string> {
  const configured = Object.fromEntries((workflow.variables ?? []).map((variable) => [
    variable.name,
    overrides[variable.name] ?? variable.value,
  ]));
  return {
    ...configured,
    workflowName: workflow.name,
    projectName: project.name,
    projectPath: project.path,
    trigger: source,
    runId,
    timestamp: new Date(startedAt).toISOString(),
    date: new Date(startedAt).toISOString().slice(0, 10),
    previousStepStatus: "none",
    previousStepOutput: "",
  };
}

function waitForRetry(active: ActiveWorkflowRun, seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      active.cancelWait = undefined;
      resolve();
    }, seconds * 1_000);
    active.cancelWait = () => {
      window.clearTimeout(timer);
      active.cancelWait = undefined;
      reject(new WorkflowStoppedError());
    };
  });
}

export function waitForWorkflowTurn(threadId: string, timeoutMs = 2 * 60 * 60_000): Promise<TaskStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status: TaskStatus) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      if (status === "completed") resolve(status);
      else reject(new Error(status === "interrupted" ? "Workflow was stopped." : "The agent step failed."));
    };
    const inspect = () => {
      const status = useTaskStore.getState().statuses[threadId];
      if (status && TERMINAL_STATUSES.has(status)) finish(status);
    };
    const unsubscribe = useTaskStore.subscribe(inspect);
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("The workflow step timed out."));
    }, timeoutMs);
    inspect();
  });
}

interface WorkflowEngineDeps {
  workflows: WorkflowDefinition[];
  projects: Project[];
  runtimeAvailable: boolean;
  chatGptConnected: boolean;
  openRouterReady: boolean;
  customAgents: CustomAgentProfile[];
  ensureSkillRoots: () => Promise<void>;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  updateWorkflow: (id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  recordRun: (run: WorkflowRunRecord) => void;
  onThreadStarted: (project: Project, threadId: string, source: WorkflowRunSource) => void;
  onError: (message: string) => void;
}

export function useWorkflowEngine(deps: WorkflowEngineDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const runningRef = useRef(new Map<string, ActiveWorkflowRun>());
  const appStartRef = useRef(new Set<string>());

  const stopWorkflow = useCallback(async (workflowId: string): Promise<boolean> => {
    const active = runningRef.current.get(workflowId);
    if (!active || active.stopRequested) return false;
    active.stopRequested = true;
    active.publish({ stopRequestedAt: Date.now() });
    active.cancelWait?.();
    const requests: Array<Promise<unknown>> = [];
    if (active.processId) {
      requests.push(rpc("command/exec/terminate", { processId: active.processId }).catch(() => undefined));
    }
    if (active.threadId && active.turnId) {
      requests.push(rpc("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined));
    }
    await Promise.all(requests);
    return true;
  }, []);

  const runWorkflow = useCallback(async (
    workflowId: string,
    source: WorkflowRunSource = "manual",
    variableOverrides: Record<string, string> = {},
  ): Promise<string | undefined> => {
    const current = depsRef.current;
    const storedWorkflow = current.workflows.find((item) => item.id === workflowId);
    if (!storedWorkflow || runningRef.current.has(workflowId)) return undefined;
    const workflow = normalizeWorkflow(storedWorkflow);

    const validationError = validateWorkflow(workflow);
    if (validationError) {
      current.onError(validationError);
      return undefined;
    }
    const project = current.projects.find((item) => item.id === workflow.projectId);
    if (!project) {
      current.onError("The workflow project is no longer available.");
      return undefined;
    }
    if (!current.runtimeAvailable) {
      current.onError("Install or reconnect the Codex runtime before running workflows.");
      return undefined;
    }
    if (workflow.run.provider === "openai" && !current.chatGptConnected) {
      current.onError("Sign in to ChatGPT before running this OpenAI workflow.");
      return undefined;
    }
    if (workflow.run.provider === "openrouter" && !current.openRouterReady) {
      current.onError("Add an OpenRouter API key before running this workflow.");
      return undefined;
    }

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const variables = workflowVariables(workflow, project, source, runId, startedAt, variableOverrides);
    let threadId: string | undefined;
    let steps: WorkflowRunStepRecord[] = workflow.steps.map((step) => ({
      stepId: step.id,
      name: step.name,
      type: step.type,
      status: "pending",
      attempts: 0,
    }));
    let runState: WorkflowRunRecord = {
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: workflow.projectId,
      source,
      startedAt,
      currentStep: 0,
      stepCount: workflow.steps.length,
      status: "running",
      variables,
      steps,
    };
    const publish = (patch: Partial<WorkflowRunRecord>) => {
      runState = { ...runState, ...patch };
      current.recordRun(runState);
    };
    const active: ActiveWorkflowRun = { runId, stopRequested: false, publish };

    runningRef.current.set(workflowId, active);
    publish({});
    try {
      await current.ensureSkillRoots();
      const started = await rpc<{ thread: Thread }>("thread/start", threadStartParams(workflow.run, project.path, {
        serviceName: `OpenKiwi Workflow: ${workflow.name}`,
        customAgents: current.customAgents,
        interactive: source === "manual",
      }));
      threadId = started.thread.id;
      active.threadId = threadId;
      if (active.stopRequested) throw new WorkflowStoppedError();
      current.bindThreadToProject(threadId, project.path);
      useTaskStore.getState().ensureTask(threadId, project.path);
      await rpc("thread/name/set", { threadId, name: `Workflow: ${workflow.name}` }).catch(() => {});
      current.onThreadStarted(project, threadId, source);
      publish({ threadId });

      let previousStatus: "none" | "completed" | "failed" | "skipped" = "none";
      for (const [index, step] of workflow.steps.entries()) {
        if (active.stopRequested) throw new WorkflowStoppedError();
        variables.previousStepStatus = previousStatus;
        if (!shouldRunWorkflowStep(step, previousStatus, variables)) {
          previousStatus = "skipped";
          variables.previousStepStatus = "skipped";
          steps = replaceStep(steps, step.id, {
            status: "skipped",
            finishedAt: Date.now(),
            output: "Condition was not met.",
          });
          publish({ threadId, currentStep: index + 1, variables: { ...variables }, steps });
          continue;
        }

        publish({ threadId, currentStep: index + 1 });
        const retry = workflowStepRetries(step);
        let stepError: unknown;
        let stepOutput = "";
        for (let attempt = 1; attempt <= retry.count + 1; attempt += 1) {
          if (active.stopRequested) throw new WorkflowStoppedError();
          const attemptStartedAt = Date.now();
          steps = replaceStep(steps, step.id, {
            status: "running",
            attempts: attempt,
            startedAt: steps.find((item) => item.stepId === step.id)?.startedAt ?? attemptStartedAt,
            finishedAt: undefined,
            output: undefined,
            error: undefined,
          });
          publish({ steps });
          try {
            if (step.type === "command") {
              const command = interpolateWorkflowText(step.command, variables);
              const activityId = `workflow-${runId}-${step.id}`;
              const processId = `workflow-${runId}-${step.id}-${attempt}`;
              active.processId = processId;
              useTaskStore.getState().upsertActivity(threadId, {
                id: activityId,
                kind: "command",
                title: command,
                detail: attempt > 1 ? `${step.name} · attempt ${attempt}` : step.name,
                status: "inProgress",
              });
              const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
                command: ["/bin/zsh", "-lc", command],
                processId,
                cwd: project.path,
                timeoutMs: 30 * 60_000,
                sandboxPolicy: commandSandbox(workflow.run.permission, project.path),
              });
              active.processId = undefined;
              stepOutput = `${result.stdout}${result.stderr}`.trim().slice(-12_000);
              useTaskStore.getState().upsertActivity(threadId, {
                id: activityId,
                kind: "command",
                title: command,
                detail: stepOutput || step.name,
                status: result.exitCode === 0 ? "completed" : "failed",
              });
              variables.previousExitCode = String(result.exitCode);
              if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}.`);
            } else {
              const prompt = workflowPrompt(workflow, step, index, variables);
              const beforeMessages = useTaskStore.getState().tasks[threadId]?.messages.length ?? 0;
              useTaskStore.getState().appendUserMessage(threadId, {
                id: `workflow-${runId}-${step.id}`,
                role: "user",
                text: prompt,
              });
              useTaskStore.getState().setTaskStatus(threadId, "starting");
              const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(
                workflow.run,
                threadId,
                project.path,
                [{ type: "text", text: prompt, text_elements: [] }],
              ));
              active.turnId = result.turn?.id;
              if (active.turnId) useTaskStore.getState().setActiveTurn(threadId, active.turnId);
              await waitForWorkflowTurn(threadId);
              active.turnId = undefined;
              const messages = useTaskStore.getState().tasks[threadId]?.messages.slice(beforeMessages) ?? [];
              stepOutput = [...messages].reverse().find((message) => message.role === "assistant")?.text.trim().slice(-12_000) ?? "";
            }
            if (active.stopRequested) throw new WorkflowStoppedError();
            steps = replaceStep(steps, step.id, {
              status: "completed",
              finishedAt: Date.now(),
              output: stepOutput,
              error: undefined,
            });
            publish({ steps });
            stepError = undefined;
            break;
          } catch (reason) {
            active.processId = undefined;
            active.turnId = undefined;
            stepError = reason;
            if (active.stopRequested || reason instanceof WorkflowStoppedError || /stopped|interrupt/i.test(friendlyError(reason))) {
              throw new WorkflowStoppedError();
            }
            if (attempt <= retry.count) {
              steps = replaceStep(steps, step.id, {
                status: "running",
                error: `${friendlyError(reason)} Retrying…`,
              });
              publish({ steps });
              await waitForRetry(active, retry.delaySeconds);
              continue;
            }
            steps = replaceStep(steps, step.id, {
              status: "failed",
              finishedAt: Date.now(),
              output: stepOutput,
              error: friendlyError(reason),
            });
            publish({ steps });
          }
        }

        if (stepError) {
          previousStatus = "failed";
          variables.previousStepStatus = "failed";
          variables.previousStepOutput = stepOutput || friendlyError(stepError);
          publish({ variables: { ...variables } });
          if (!step.continueOnError) throw stepError;
          useTaskStore.getState().upsertActivity(threadId, {
            id: `workflow-warning-${runId}-${step.id}`,
            kind: "warning",
            title: `${step.name} failed; workflow continued`,
            detail: friendlyError(stepError),
            status: "failed",
          });
        } else {
          previousStatus = "completed";
          variables.previousStepStatus = "completed";
          variables.previousStepOutput = stepOutput;
          publish({ variables: { ...variables }, steps });
        }
      }

      const finishedAt = Date.now();
      publish({
        threadId,
        currentStep: workflow.steps.length,
        finishedAt,
        status: "completed",
        variables: { ...variables },
        steps,
      });
      current.updateWorkflow(workflow.id, (item) => ({
        ...item,
        lastRunAt: finishedAt,
        lastThreadId: threadId,
        nextRunAt: nextWorkflowRunAt(item.trigger, finishedAt),
        updatedAt: finishedAt,
      }));
      void auditEvent("workflow.completed", {
        workflowId: workflow.id,
        source,
        stepCount: workflow.steps.length,
      }, threadId).catch(() => {});
      return threadId;
    } catch (reason) {
      const stopped = active.stopRequested || reason instanceof WorkflowStoppedError || /stopped|interrupt/i.test(friendlyError(reason));
      const message = stopped ? "Workflow was stopped." : friendlyError(reason);
      const finishedAt = Date.now();
      if (stopped) {
        steps = steps.map((step) => step.status !== "running" ? step : {
          ...step,
          status: "interrupted",
          finishedAt,
          error: message,
        });
      }
      publish({
        threadId,
        finishedAt,
        status: stopped ? "interrupted" : "failed",
        error: message.slice(0, 300),
        variables: { ...variables },
        steps,
      });
      current.updateWorkflow(workflow.id, (item) => ({
        ...item,
        lastRunAt: finishedAt,
        lastThreadId: threadId ?? item.lastThreadId,
        nextRunAt: item.trigger.type === "interval"
          ? finishedAt + 5 * 60_000
          : item.nextRunAt,
        updatedAt: finishedAt,
      }));
      void auditEvent(stopped ? "workflow.interrupted" : "workflow.failed", {
        workflowId: workflow.id,
        source,
        error: message,
      }, threadId).catch(() => {});
      if (source === "manual" && !stopped) current.onError(message);
      return threadId;
    } finally {
      active.cancelWait?.();
      runningRef.current.delete(workflowId);
    }
  }, []);

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      for (const workflow of depsRef.current.workflows) {
        if (!workflow.enabled) continue;
        if (workflow.trigger.type === "interval" && (workflow.nextRunAt ?? 0) <= now) {
          void runWorkflow(workflow.id, "interval");
        }
        if (workflow.trigger.type === "app-start" && !appStartRef.current.has(workflow.id)) {
          appStartRef.current.add(workflow.id);
          void runWorkflow(workflow.id, "app-start").then((threadId) => {
            if (!threadId) appStartRef.current.delete(workflow.id);
          });
        }
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [runWorkflow]);

  return { runWorkflow, stopWorkflow };
}
