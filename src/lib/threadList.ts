import type { Thread } from "../types";

export type ThreadSidebarIndex = Record<string, Thread>;

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function sidebarThread(thread: Thread): Thread {
  const { turns: _turns, ...summary } = thread;
  return summary;
}

/** The remembered index is rewritten on every turn — keep it bounded. */
export const MAX_REMEMBERED_THREADS = 500;

export function pruneSidebarIndex(index: ThreadSidebarIndex, max = MAX_REMEMBERED_THREADS): ThreadSidebarIndex {
  const entries = Object.values(index);
  if (entries.length <= max) return index;
  const kept = entries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, max);
  const next: ThreadSidebarIndex = {};
  for (const thread of kept) next[thread.id] = thread;
  return next;
}

export function rememberSidebarThread(index: ThreadSidebarIndex, thread: Thread): ThreadSidebarIndex {
  return pruneSidebarIndex({ ...index, [thread.id]: sidebarThread(thread) });
}

export function forgetSidebarThread(index: ThreadSidebarIndex, threadId: string): ThreadSidebarIndex {
  if (!index[threadId]) return index;
  const next = { ...index };
  delete next[threadId];
  return next;
}

export function reconcileWorkspaceThreads(
  runtimeThreads: Thread[],
  rememberedThreads: ThreadSidebarIndex,
  workspacePath: string,
  bindings: Record<string, string>,
): Thread[] {
  const targetPath = normalizedPath(workspacePath);
  const belongsToWorkspace = (thread: Thread) => normalizedPath(bindings[thread.id] || thread.cwd) === targetPath;
  const merged = new Map<string, Thread>();
  for (const thread of Object.values(rememberedThreads)) {
    if (belongsToWorkspace(thread)) merged.set(thread.id, thread);
  }
  for (const thread of runtimeThreads) {
    if (belongsToWorkspace(thread)) merged.set(thread.id, sidebarThread(thread));
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const index = threads.findIndex((entry) => entry.id === thread.id);
  if (index === -1) return [...threads, thread];
  return threads.map((entry, entryIndex) => entryIndex === index ? thread : entry);
}

export function optimisticStartedThread(thread: Thread, firstMessage: string, nowSeconds = Math.floor(Date.now() / 1000)): Thread {
  return {
    ...thread,
    preview: thread.preview || firstMessage,
    updatedAt: Math.max(thread.updatedAt || 0, nowSeconds),
  };
}
