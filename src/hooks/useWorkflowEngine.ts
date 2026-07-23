import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import { commandSandbox, threadStartParams, turnStartParams } from "../lib/turnConfig";
import {
  nextWorkflowRunAt,
  validateWorkflow,
  workflowPrompt,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type WorkflowRunSource,
} from "../lib/workflows";
import type { CustomAgentProfile, Project, Thread, Turn } from "../types";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "interrupted", "error"]);

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
  const runningRef = useRef(new Set<string>());
  const appStartRef = useRef(new Set<string>());

  const runWorkflow = useCallback(async (
    workflowId: string,
    source: WorkflowRunSource = "manual",
  ): Promise<string | undefined> => {
    const current = depsRef.current;
    const workflow = current.workflows.find((item) => item.id === workflowId);
    if (!workflow || runningRef.current.has(workflowId)) return undefined;

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
    let threadId: string | undefined;
    const runRecord = (patch: Partial<WorkflowRunRecord>) => current.recordRun({
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: workflow.projectId,
      source,
      startedAt,
      currentStep: 0,
      stepCount: workflow.steps.length,
      status: "running",
      ...patch,
    });

    runningRef.current.add(workflowId);
    runRecord({});
    try {
      await current.ensureSkillRoots();
      const started = await rpc<{ thread: Thread }>("thread/start", threadStartParams(workflow.run, project.path, {
        serviceName: `OpenKiwi Workflow: ${workflow.name}`,
        customAgents: current.customAgents,
        interactive: source === "manual",
      }));
      threadId = started.thread.id;
      current.bindThreadToProject(threadId, project.path);
      useTaskStore.getState().ensureTask(threadId, project.path);
      await rpc("thread/name/set", { threadId, name: `Workflow: ${workflow.name}` }).catch(() => {});
      current.onThreadStarted(project, threadId, source);
      runRecord({ threadId });

      for (const [index, step] of workflow.steps.entries()) {
        runRecord({ threadId, currentStep: index + 1 });
        try {
          if (step.type === "command") {
            const activityId = `workflow-${runId}-${step.id}`;
            useTaskStore.getState().upsertActivity(threadId, {
              id: activityId,
              kind: "command",
              title: step.command,
              detail: step.name,
              status: "inProgress",
            });
            const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
              command: ["/bin/zsh", "-lc", step.command],
              cwd: project.path,
              timeoutMs: 30 * 60_000,
              sandboxPolicy: commandSandbox(workflow.run.permission, project.path),
            });
            const output = `${result.stdout}${result.stderr}`.trim();
            useTaskStore.getState().upsertActivity(threadId, {
              id: activityId,
              kind: "command",
              title: step.command,
              detail: output ? output.slice(-12_000) : step.name,
              status: result.exitCode === 0 ? "completed" : "failed",
            });
            if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}.`);
          } else {
            const prompt = workflowPrompt(workflow, step, index);
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
            if (result.turn?.id) useTaskStore.getState().setActiveTurn(threadId, result.turn.id);
            await waitForWorkflowTurn(threadId);
          }
        } catch (reason) {
          if (!step.continueOnError) throw reason;
          useTaskStore.getState().upsertActivity(threadId, {
            id: `workflow-warning-${runId}-${step.id}`,
            kind: "warning",
            title: `${step.name} failed; workflow continued`,
            detail: friendlyError(reason),
            status: "failed",
          });
        }
      }

      const finishedAt = Date.now();
      runRecord({
        threadId,
        currentStep: workflow.steps.length,
        finishedAt,
        status: "completed",
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
      const message = friendlyError(reason);
      const status = /stopped|interrupt/i.test(message) ? "interrupted" : "failed";
      const finishedAt = Date.now();
      runRecord({
        threadId,
        finishedAt,
        status,
        error: message.slice(0, 300),
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
      void auditEvent("workflow.failed", {
        workflowId: workflow.id,
        source,
        error: message,
      }, threadId).catch(() => {});
      if (source === "manual") current.onError(message);
      return threadId;
    } finally {
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

  return { runWorkflow };
}
