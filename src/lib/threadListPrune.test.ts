import { describe, expect, it } from "vitest";
import { MAX_REMEMBERED_THREADS, pruneSidebarIndex, rememberSidebarThread, type ThreadSidebarIndex } from "./threadList";
import type { Thread } from "../types";

function thread(id: string, updatedAt: number): Thread {
  return { id, name: null, preview: id, cwd: "/p", updatedAt, modelProvider: "openai" };
}

describe("sidebar index pruning", () => {
  it("keeps the most recently updated threads when over the cap", () => {
    let index: ThreadSidebarIndex = {};
    for (let value = 0; value < MAX_REMEMBERED_THREADS + 40; value += 1) {
      index[`t${value}`] = thread(`t${value}`, value);
    }
    index = pruneSidebarIndex(index);
    expect(Object.keys(index).length).toBe(MAX_REMEMBERED_THREADS);
    expect(index["t0"]).toBeUndefined();
    expect(index[`t${MAX_REMEMBERED_THREADS + 39}`]).toBeDefined();
  });

  it("returns the same object when under the cap", () => {
    const index: ThreadSidebarIndex = { a: thread("a", 1) };
    expect(pruneSidebarIndex(index)).toBe(index);
  });

  it("remember keeps the index bounded", () => {
    let index: ThreadSidebarIndex = {};
    for (let value = 0; value < MAX_REMEMBERED_THREADS + 5; value += 1) {
      index = rememberSidebarThread(index, thread(`t${value}`, value));
    }
    expect(Object.keys(index).length).toBe(MAX_REMEMBERED_THREADS);
  });
});
