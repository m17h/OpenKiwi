import type { CustomAgentProfile, PermissionMode, ScheduleRunSettings } from "../types";
import type { JsonObject } from "./codex";

export function commandSandbox(permission: PermissionMode, cwd: string): JsonObject {
  if (permission === "full") return { type: "dangerFullAccess" };
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function sandboxMode(permission: PermissionMode): string {
  if (permission === "read-only") return "read-only";
  if (permission === "full") return "danger-full-access";
  return "workspace-write";
}

export function customAgentConfig(agents: CustomAgentProfile[]): Record<string, JsonObject> {
  return Object.fromEntries(agents.filter((agent) => agent.enabled).map((agent) => [
    agent.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || agent.id,
    {
      description: agent.description,
      instructions: agent.instructions,
      model: agent.model,
      model_reasoning_effort: agent.reasoningEffort,
    },
  ]));
}

export interface ThreadStartOptions {
  serviceName?: string;
  customAgents?: CustomAgentProfile[];
  /** Non-interactive threads (scheduled runs) never issue approval requests,
   *  because nobody is guaranteed to be present to answer them. */
  interactive: boolean;
}

export function threadStartParams(run: ScheduleRunSettings, cwd: string, options: ThreadStartOptions): JsonObject {
  const params: JsonObject = {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    sandbox: sandboxMode(run.permission),
    approvalPolicy: options.interactive && run.permission === "ask" ? "on-request" : "never",
    baseInstructions: run.systemPrompt,
    developerInstructions: "",
    config: {
      project_doc_max_bytes: run.projectInstructionsEnabled ? 32_768 : 0,
      project_doc_fallback_filenames: [],
      developer_instructions: "",
      model_reasoning_effort: run.ultra ? "ultra" : run.reasoningEffort,
      agents: {
        max_threads: run.subagentMax,
        max_depth: 1,
        ...customAgentConfig(options.customAgents ?? []),
      },
      features: {
        multi_agent: run.subagentsEnabled,
      },
    },
    serviceName: options.serviceName ?? "OpenKiwi",
    serviceTier: run.serviceTier,
  };
  if (run.model.trim()) params.model = run.model.trim();
  if (run.provider === "openrouter") params.modelProvider = "openrouter";
  return params;
}

export function turnStartParams(run: ScheduleRunSettings, threadId: string, cwd: string, input: JsonObject[]): JsonObject {
  return {
    threadId,
    input,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    sandboxPolicy: commandSandbox(run.permission, cwd),
    model: run.model.trim() || undefined,
    effort: run.ultra ? "ultra" : run.reasoningEffort,
    serviceTier: run.serviceTier,
  };
}

export function scheduleRunSnapshot(settings: ScheduleRunSettings): ScheduleRunSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    permission: settings.permission,
    systemPrompt: settings.systemPrompt,
    projectInstructionsEnabled: settings.projectInstructionsEnabled,
    subagentsEnabled: settings.subagentsEnabled,
    subagentMax: settings.subagentMax,
    reasoningEffort: settings.reasoningEffort,
    ultra: settings.ultra,
    serviceTier: settings.serviceTier,
  };
}
