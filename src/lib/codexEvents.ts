import type { CodexEvent, JsonObject } from "./codex";
import type { ThreadItem, Turn } from "../types";
import { useTaskStore } from "./taskStore";
import type { TokenUsageView } from "../components/StudioDock";

/**
 * Events that arrive without a threadId are routed to this bucket instead of
 * whichever thread happens to be active, so a background thread's output can
 * never be misattributed to the thread the user is looking at.
 */
export const RUNTIME_THREAD_ID = "runtime";

export function decodeBase64Utf8(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export interface CodexEventContext {
  bindingFor: (threadId: string) => string | undefined;
  respond: (id: number | string, result: JsonObject) => Promise<void>;
  audit: (kind: string, payload: JsonObject, threadId?: string) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
  onDiffReset: () => void;
  onRateSummary: (summary: string) => void;
  onTerminalOutput: (delta: string) => void;
  onTurnCompleted: (threadId: string, turn: Turn | null) => void;
  onAccountUpdated: () => void;
  onLoginFailed: (message: string) => void;
}

export function handleThreadItem(threadId: string, item: ThreadItem, ctx: CodexEventContext): void {
  const taskStore = useTaskStore.getState();
  taskStore.ensureTask(threadId, ctx.bindingFor(threadId));
  const id = item.id ?? crypto.randomUUID();
  if (item.type === "agentMessage" || item.type === "plan") {
    taskStore.completeMessage(threadId, { id, role: "assistant", text: item.text ?? "", streaming: false });
    return;
  }
  if (item.type === "commandExecution") {
    taskStore.upsertActivity(threadId, {
      id,
      kind: "command",
      title: item.command ?? "Run command",
      detail: item.aggregatedOutput ?? item.cwd,
      status: item.status,
    });
    return;
  }
  if (item.type === "fileChange") {
    taskStore.upsertActivity(threadId, {
      id,
      kind: "file",
      title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`,
      status: item.status,
    });
    return;
  }
  if (item.type === "reasoning" && item.summary?.length) {
    taskStore.upsertActivity(threadId, { id, kind: "reasoning", title: item.summary.join(" ") });
    return;
  }
  if (item.type === "collabAgentToolCall") {
    const titles: Record<string, string> = {
      spawnAgent: `Spawn sub-agent${item.receiverThreadIds?.length === 1 ? "" : "s"}`,
      sendInput: "Send input to sub-agent",
      resumeAgent: "Resume sub-agent",
      wait: "Wait for sub-agents",
      closeAgent: "Close sub-agent",
    };
    taskStore.upsertActivity(threadId, {
      id,
      kind: "agent",
      title: titles[item.tool ?? ""] ?? "Sub-agent activity",
      detail: item.prompt ?? undefined,
      status: item.status,
    });
    if (item.receiverThreadIds?.length) {
      for (const childThreadId of item.receiverThreadIds) {
        taskStore.upsertAgent(threadId, { id: childThreadId, prompt: item.prompt ?? "Delegated task", status: item.status ?? "inProgress" });
        taskStore.ensureTask(childThreadId, ctx.bindingFor(threadId));
      }
    }
    return;
  }
  if (item.type === "subAgentActivity") {
    const action = item.kind === "started" ? "started" : item.kind === "interrupted" ? "interrupted" : "working";
    taskStore.upsertActivity(threadId, {
      id,
      kind: "agent",
      title: `Sub-agent ${action}`,
      detail: item.agentPath || item.agentThreadId,
      status: item.kind,
    });
    if (item.agentThreadId) {
      taskStore.upsertAgent(threadId, { id: item.agentThreadId, prompt: "Delegated task", status: item.kind ?? "working", path: item.agentPath });
    }
  }
}

export function routeCodexEvent(event: CodexEvent, ctx: CodexEventContext): void {
  if (event.stream === "stderr") {
    const line = event.line?.toLowerCase() ?? "";
    if (line.includes("401 unauthorized")) {
      ctx.onStatus("Sign-in required");
      ctx.onError("Sign in to your ChatGPT account in Settings before using OpenAI models.");
      ctx.onAuthRequired();
    } else if (line.includes("error")) {
      ctx.onStatus("Runtime issue");
    }
    return;
  }

  const method = event.method ?? "";
  const params = event.params ?? {};
  const eventThreadId = typeof params.threadId === "string" ? params.threadId : RUNTIME_THREAD_ID;
  if (event.id !== undefined && method === "currentTime/read") {
    void ctx.respond(event.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (event.id !== undefined && (
    method.includes("requestApproval")
    || method.endsWith("Approval")
    || method === "item/tool/requestUserInput"
    || method === "mcpServer/elicitation/request"
  )) {
    useTaskStore.getState().enqueueApproval({
      id: event.id,
      method,
      params,
      threadId: eventThreadId,
      receivedAt: Date.now(),
    });
    ctx.audit("approval.requested", { method, params }, eventThreadId);
    return;
  }
  if (method === "item/agentMessage/delta") {
    useTaskStore.getState().queueAssistantDelta(eventThreadId, String(params.itemId), String(params.delta ?? ""));
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    if (params.item && typeof params.item === "object") handleThreadItem(eventThreadId, params.item as ThreadItem, ctx);
    return;
  }
  if (method === "turn/diff/updated") {
    useTaskStore.getState().setDiff(eventThreadId, String(params.diff ?? ""));
    ctx.onDiffReset();
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage as { total?: Partial<TokenUsageView>; modelContextWindow?: number | null } | undefined;
    if (usage?.total) {
      useTaskStore.getState().setUsage(eventThreadId, {
        totalTokens: Number(usage.total.totalTokens ?? 0),
        inputTokens: Number(usage.total.inputTokens ?? 0),
        cachedInputTokens: Number(usage.total.cachedInputTokens ?? 0),
        outputTokens: Number(usage.total.outputTokens ?? 0),
        reasoningOutputTokens: Number(usage.total.reasoningOutputTokens ?? 0),
        contextWindow: usage.modelContextWindow,
      });
    }
    return;
  }
  if (method === "command/exec/outputDelta") {
    ctx.onTerminalOutput(decodeBase64Utf8(params.deltaBase64));
    return;
  }
  if (method === "account/rateLimits/updated") {
    const limits = params.rateLimits as { primary?: { usedPercent?: number } } | undefined;
    if (limits?.primary) ctx.onRateSummary(`${Math.round(limits.primary.usedPercent ?? 0)}% used`);
    return;
  }
  if (method === "turn/started") {
    useTaskStore.getState().setTaskStatus(eventThreadId, "running");
    ctx.audit("turn.started", {}, eventThreadId);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus("Working");
    return;
  }
  if (method === "turn/completed") {
    useTaskStore.getState().setTaskStatus(eventThreadId, "completed");
    ctx.audit("turn.completed", {}, eventThreadId);
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as unknown as Turn) : null;
    ctx.onTurnCompleted(eventThreadId, turn);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus("Ready");
    return;
  }
  if (method === "thread/status/changed") {
    const statusValue = params.status as { type?: string } | undefined;
    const nextStatus = statusValue?.type === "active" ? "running" : statusValue?.type === "systemError" ? "error" : "idle";
    useTaskStore.getState().setTaskStatus(eventThreadId, nextStatus);
    return;
  }
  if (method === "error" || method === "warning" || method === "guardianWarning" || method === "configWarning") {
    useTaskStore.getState().upsertActivity(eventThreadId, {
      id: `${method}-${Date.now()}`,
      kind: "warning",
      title: String(params.message ?? params.error ?? "Runtime warning"),
      detail: typeof params.details === "string" ? params.details : undefined,
    });
    return;
  }
  if (method === "account/updated") {
    ctx.onAccountUpdated();
    return;
  }
  if (method === "account/login/completed" && params.success === false) {
    ctx.onLoginFailed(String(params.error ?? "Sign in did not complete"));
  }
}
