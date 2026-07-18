import type { Thread } from "../types";

export interface ThreadSearchResult {
  thread: Thread;
  snippet: string;
}

export interface ThreadSearchResponse {
  data: ThreadSearchResult[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export function threadSearchParams(searchTerm: string, limit = 50) {
  return { searchTerm, limit };
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function threadsForWorkspace(
  results: ThreadSearchResult[],
  workspacePath: string,
  bindings: Record<string, string>,
): Thread[] {
  const normalizedWorkspacePath = normalizedPath(workspacePath);
  return results
    .map((result) => result.thread)
    .filter((thread) => normalizedPath(bindings[thread.id] || thread.cwd) === normalizedWorkspacePath);
}
