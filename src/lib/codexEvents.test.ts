import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_THREAD_ID, decodeBase64Utf8, routeCodexEvent, type CodexEventContext } from "./codexEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";

function makeContext(overrides: Partial<CodexEventContext> = {}): CodexEventContext {
  return {
    bindingFor: () => undefined,
    respond: vi.fn(async () => {}),
    audit: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onAuthRequired: vi.fn(),
    onDiffReset: vi.fn(),
    onRateSummary: vi.fn(),
    onTerminalOutput: vi.fn(),
    onTurnCompleted: vi.fn(),
    onAccountUpdated: vi.fn(),
    onLoginFailed: vi.fn(),
    ...overrides,
  };
}

describe("routeCodexEvent", () => {
  beforeEach(() => resetTaskStore());

  it("routes deltas to the thread named in the event", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-active");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-b", itemId: "item-1", delta: "hello" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks["thread-b"]?.messages[0]?.text).toBe("hello");
    expect(useTaskStore.getState().tasks["thread-active"]?.messages ?? []).toHaveLength(0);
  });

  it("never attributes threadless events to the active thread", () => {
    const ctx = makeContext();
    useTaskStore.getState().ensureTask("thread-active");
    useTaskStore.getState().setActiveThread("thread-active");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "item-1", delta: "orphan" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks["thread-active"].messages).toHaveLength(0);
    expect(useTaskStore.getState().tasks[RUNTIME_THREAD_ID]?.messages[0]?.text).toBe("orphan");
  });

  it("enqueues approvals under their own thread and audits them", () => {
    const ctx = makeContext();
    routeCodexEvent({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-bg", command: "rm -rf" } }, ctx);
    const approvals = useTaskStore.getState().tasks["thread-bg"]?.approvals ?? [];
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe(7);
    expect(ctx.audit).toHaveBeenCalledWith("approval.requested", expect.anything(), "thread-bg");
  });

  it("answers currentTime/read directly", () => {
    const ctx = makeContext();
    routeCodexEvent({ id: 3, method: "currentTime/read", params: {} }, ctx);
    expect(ctx.respond).toHaveBeenCalledWith(3, expect.objectContaining({ currentTimeAt: expect.any(Number) }));
  });

  it("marks turn lifecycle and only reports status for the active thread", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-a");
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-b" } }, ctx);
    expect(useTaskStore.getState().statuses["thread-b"]).toBe("running");
    expect(ctx.onStatus).not.toHaveBeenCalled();

    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-a" } }, ctx);
    expect(ctx.onStatus).toHaveBeenCalledWith("Working");

    routeCodexEvent({ method: "turn/completed", params: { threadId: "thread-b", turn: { id: "t1", items: [] } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-b"]).toBe("completed");
    expect(ctx.onTurnCompleted).toHaveBeenCalledWith("thread-b", { id: "t1", items: [] });
  });

  it("surfaces sign-in problems from stderr", () => {
    const ctx = makeContext();
    routeCodexEvent({ stream: "stderr", line: "request failed: 401 Unauthorized" }, ctx);
    expect(ctx.onAuthRequired).toHaveBeenCalled();
    expect(ctx.onStatus).toHaveBeenCalledWith("Sign-in required");
  });

  it("decodes terminal output deltas", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "command/exec/outputDelta", params: { deltaBase64: btoa("ok\n") } }, ctx);
    expect(ctx.onTerminalOutput).toHaveBeenCalledWith("ok\n");
  });

  it("records runtime warnings as activities", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "guardianWarning", params: { threadId: "thread-w", message: "careful" } }, ctx);
    expect(useTaskStore.getState().tasks["thread-w"]?.activities[0]?.title).toBe("careful");
  });
});

describe("decodeBase64Utf8", () => {
  it("decodes utf-8 payloads and tolerates garbage", () => {
    expect(decodeBase64Utf8(btoa("plain"))).toBe("plain");
    expect(decodeBase64Utf8("&&& not base64 &&&")).toBe("");
    expect(decodeBase64Utf8(undefined)).toBe("");
  });
});
