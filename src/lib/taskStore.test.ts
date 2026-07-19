import { beforeEach, describe, expect, it } from "vitest";
import { resetTaskStore, useTaskStore } from "./taskStore";

describe("task store", () => {
  beforeEach(() => resetTaskStore());

  it("routes streamed output to the correct thread", () => {
    const store = useTaskStore.getState();
    store.ensureTask("thread-a", "/a");
    store.ensureTask("thread-b", "/b");
    store.setActiveThread("thread-a");
    store.queueAssistantDelta("thread-b", "message-1", "hello");
    store.queueAssistantDelta("thread-b", "message-1", " world");
    store.flushDeltas();

    const state = useTaskStore.getState();
    expect(state.tasks["thread-a"].messages).toEqual([]);
    expect(state.tasks["thread-b"].messages[0].text).toBe("hello world");
    expect(state.tasks["thread-b"].unread).toBe(true);
  });

  it("queues concurrent approvals without replacing them", () => {
    const store = useTaskStore.getState();
    store.enqueueApproval({ id: 1, method: "item/commandExecution/requestApproval", params: {}, threadId: "thread-a", receivedAt: 1 });
    store.enqueueApproval({ id: 2, method: "item/fileChange/requestApproval", params: {}, threadId: "thread-a", receivedAt: 2 });

    expect(useTaskStore.getState().tasks["thread-a"].approvals).toHaveLength(2);
    useTaskStore.getState().resolveApproval("thread-a", 1);
    expect(useTaskStore.getState().tasks["thread-a"].approvals.map((entry) => entry.id)).toEqual([2]);
  });

  it("tracks per-thread status independently", () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("thread-a", "running");
    store.setTaskStatus("thread-b", "completed");
    expect(useTaskStore.getState().statuses).toEqual({ "thread-a": "running", "thread-b": "completed" });
  });

  it("tracks the active runtime turn independently for each thread", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-a");
    store.setActiveTurn("thread-b", "turn-b");
    store.setActiveTurn("thread-a", undefined);

    expect(useTaskStore.getState().tasks["thread-a"].activeTurnId).toBeUndefined();
    expect(useTaskStore.getState().tasks["thread-b"].activeTurnId).toBe("turn-b");
  });

  it("assigns chronology once and preserves it when activity completes", () => {
    const store = useTaskStore.getState();
    store.appendUserMessage("thread-a", { id: "user", role: "user", text: "Check it" });
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "git status", status: "inProgress" });
    store.upsertActivity("thread-a", { id: "command", kind: "command", title: "git status", detail: "clean", status: "completed" });
    store.completeMessage("thread-a", { id: "assistant", role: "assistant", text: "Done" });

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.messages[0].timelineOrder).toBeLessThan(task.activities[0].timelineOrder!);
    expect(task.activities[0].timelineOrder).toBeLessThan(task.messages[1].timelineOrder!);
  });
});
