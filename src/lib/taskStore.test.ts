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
});
