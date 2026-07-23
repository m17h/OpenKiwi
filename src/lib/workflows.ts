import type { ProjectAction, ScheduleRunSettings, ScheduledTask } from "../types";

export type WorkflowTrigger =
  | { type: "manual" }
  | { type: "interval"; intervalMinutes: number }
  | { type: "app-start" };

export type WorkflowStep =
  | {
      id: string;
      type: "agent";
      name: string;
      prompt: string;
      continueOnError: boolean;
    }
  | {
      id: string;
      type: "command";
      name: string;
      command: string;
      continueOnError: boolean;
    };

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  projectId: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  skillNames: string[];
  run: ScheduleRunSettings;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastThreadId?: string;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "interrupted";
export type WorkflowRunSource = "manual" | "interval" | "app-start";

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  threadId?: string;
  source: WorkflowRunSource;
  startedAt: number;
  finishedAt?: number;
  currentStep: number;
  stepCount: number;
  status: WorkflowRunStatus;
  error?: string;
}

export function nextWorkflowRunAt(trigger: WorkflowTrigger, now = Date.now()): number | undefined {
  return trigger.type === "interval"
    ? now + Math.max(5, trigger.intervalMinutes) * 60_000
    : undefined;
}

export function workflowTriggerLabel(trigger: WorkflowTrigger): string {
  if (trigger.type === "interval") return `Every ${Math.max(5, trigger.intervalMinutes)} min`;
  if (trigger.type === "app-start") return "When OpenKiwi starts";
  return "Manual";
}

export function workflowStepText(step: WorkflowStep): string {
  return step.type === "agent" ? step.prompt : step.command;
}

export function validateWorkflow(workflow: WorkflowDefinition): string | null {
  if (!workflow.name.trim()) return "Give the workflow a name.";
  if (!workflow.projectId) return "Choose a project.";
  if (!workflow.steps.length) return "Add at least one workflow step.";
  if (workflow.trigger.type === "interval" && workflow.trigger.intervalMinutes < 5) {
    return "Intervals must be at least five minutes.";
  }
  for (const [index, step] of workflow.steps.entries()) {
    if (!step.name.trim()) return `Step ${index + 1} needs a name.`;
    if (!workflowStepText(step).trim()) return `Step ${index + 1} is empty.`;
  }
  return null;
}

export function workflowPrompt(
  workflow: WorkflowDefinition,
  step: Extract<WorkflowStep, { type: "agent" }>,
  stepIndex: number,
): string {
  const skills = workflow.skillNames.length
    ? `\n\nSkills available for this step: ${workflow.skillNames.map((name) => `$${name}`).join(", ")}. Use them when relevant.`
    : "";
  return `[Workflow: ${workflow.name} · Step ${stepIndex + 1}/${workflow.steps.length}: ${step.name}]\n\n${step.prompt.trim()}${skills}`;
}

export function workflowFromSchedule(
  scheduled: ScheduledTask,
  run: ScheduleRunSettings,
  now = Date.now(),
): WorkflowDefinition {
  return {
    id: crypto.randomUUID(),
    name: scheduled.name,
    description: "Imported from a simple scheduled task.",
    projectId: scheduled.projectId ?? "",
    enabled: scheduled.enabled,
    trigger: { type: "interval", intervalMinutes: Math.max(5, scheduled.intervalMinutes) },
    steps: [{
      id: crypto.randomUUID(),
      type: "agent",
      name: "Run prompt",
      prompt: scheduled.prompt,
      continueOnError: false,
    }],
    skillNames: [],
    run: scheduled.run ?? run,
    createdAt: now,
    updatedAt: now,
    nextRunAt: scheduled.nextRunAt || nextWorkflowRunAt({ type: "interval", intervalMinutes: scheduled.intervalMinutes }, now),
    lastRunAt: scheduled.lastRunAt,
    lastThreadId: scheduled.lastThreadId,
  };
}

export function workflowFromAction(
  action: ProjectAction,
  projectId: string,
  run: ScheduleRunSettings,
  now = Date.now(),
): WorkflowDefinition {
  return {
    id: crypto.randomUUID(),
    name: action.name,
    description: "Imported from a project action.",
    projectId,
    enabled: true,
    trigger: { type: "manual" },
    steps: [{
      id: crypto.randomUUID(),
      type: "command",
      name: action.name,
      command: action.command,
      continueOnError: false,
    }],
    skillNames: [],
    run,
    createdAt: now,
    updatedAt: now,
  };
}
