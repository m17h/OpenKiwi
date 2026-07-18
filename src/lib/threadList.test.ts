import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import { optimisticStartedThread, upsertThread } from "./threadList";

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
});
