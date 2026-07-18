import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import { threadSearchParams, threadsForWorkspace, type ThreadSearchResult } from "./threadSearch";

function makeThread(id: string, cwd: string): Thread {
  return {
    id,
    name: null,
    preview: "",
    cwd,
    updatedAt: 0,
    modelProvider: "openai",
  };
}

describe("thread search protocol", () => {
  it("uses the App Server searchTerm parameter", () => {
    expect(threadSearchParams("needle")).toEqual({ searchTerm: "needle", limit: 50 });
  });

  it("unwraps search results and keeps only the active workspace", () => {
    const results: ThreadSearchResult[] = [
      { thread: makeThread("same-cwd", "/projects/kiwi/"), snippet: "first match" },
      { thread: makeThread("bound", "/old/location"), snippet: "second match" },
      { thread: makeThread("elsewhere", "/projects/other"), snippet: "third match" },
    ];

    expect(threadsForWorkspace(results, "/projects/kiwi", { bound: "/projects/kiwi" }).map((thread) => thread.id))
      .toEqual(["same-cwd", "bound"]);
  });
});
