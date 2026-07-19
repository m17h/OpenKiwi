import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import { forgetSidebarThread, optimisticStartedThread, reconcileWorkspaceThreads, rememberSidebarThread, upsertThread } from "./threadList";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    name: null,
    preview: "",
    cwd: "/workspace",
    updatedAt: 10,
    modelProvider: "openai",
    ...overrides,
  };
}

describe("thread sidebar list", () => {
  it("shows a newly started thread immediately with its first message", () => {
    const started = optimisticStartedThread(makeThread("normal-chat"), "A normal chat", 20);
    const threads = upsertThread([], started);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "normal-chat", preview: "A normal chat", updatedAt: 20 });
  });

  it("reconciles indexed metadata without duplicating the thread", () => {
    const optimistic = optimisticStartedThread(makeThread("normal-chat"), "A normal chat", 20);
    const indexed = makeThread("normal-chat", { name: "Saved chat", preview: "A normal chat", updatedAt: 25 });

    expect(upsertThread([optimistic], indexed)).toEqual([indexed]);
  });

  it("keeps a newly started OpenRouter chat while the runtime index catches up", () => {
    const chat = makeThread("router-chat", { cwd: "/normal-chats", modelProvider: "openrouter" });
    const remembered = rememberSidebarThread({}, optimisticStartedThread(chat, "Hello OpenRouter", 20));

    expect(reconcileWorkspaceThreads([], remembered, "/normal-chats", { "router-chat": "/normal-chats" }))
      .toEqual([expect.objectContaining({ id: "router-chat", preview: "Hello OpenRouter", modelProvider: "openrouter" })]);
  });

  it("merges runtime metadata into remembered chats and removes forgotten chats", () => {
    const optimistic = optimisticStartedThread(makeThread("chat", { cwd: "/normal-chats" }), "Hello", 20);
    const remembered = rememberSidebarThread({}, optimistic);
    const indexed = makeThread("chat", { cwd: "/normal-chats", name: "Saved chat", preview: "Hello", updatedAt: 25 });

    expect(reconcileWorkspaceThreads([indexed], remembered, "/normal-chats", {})).toEqual([indexed]);
    expect(forgetSidebarThread(remembered, "chat")).toEqual({});
  });
});
