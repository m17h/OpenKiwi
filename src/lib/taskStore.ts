import { create } from "zustand";
import type { Activity, ChatMessage, PendingApproval } from "../types";
import type { AgentRecord, TokenUsageView } from "../components/StudioDock";

export type TaskStatus = "idle" | "starting" | "running" | "completed" | "interrupted" | "error";

export interface ThreadTaskState {
  threadId: string;
  activeTurnId?: string;
  workspacePath?: string;
  status: TaskStatus;
  messages: ChatMessage[];
  activities: Activity[];
  approvals: PendingApproval[];
  agents: AgentRecord[];
  diff: string;
  usage: TokenUsageView | null;
  unread: boolean;
  error?: string;
  updatedAt: number;
}

interface TaskStoreState {
  activeThreadId: string | null;
  tasks: Record<string, ThreadTaskState>;
  statuses: Record<string, TaskStatus>;
  setActiveThread: (threadId: string | null) => void;
  ensureTask: (threadId: string, workspacePath?: string) => void;
  hydrateTask: (threadId: string, messages: ChatMessage[], activities: Activity[], workspacePath?: string) => void;
  appendUserMessage: (threadId: string, message: ChatMessage) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  queueAssistantDelta: (threadId: string, itemId: string, delta: string) => void;
  queueReasoningDelta: (threadId: string, itemId: string, delta: string, source: "summary" | "content") => void;
  flushDeltas: () => void;
  completeMessage: (threadId: string, message: ChatMessage) => void;
  upsertActivity: (threadId: string, activity: Activity) => void;
  setActiveTurn: (threadId: string, turnId?: string) => void;
  setTaskStatus: (threadId: string, status: TaskStatus, error?: string) => void;
  setDiff: (threadId: string, diff: string) => void;
  setUsage: (threadId: string, usage: TokenUsageView | null) => void;
  upsertAgent: (threadId: string, agent: AgentRecord) => void;
  enqueueApproval: (approval: PendingApproval) => void;
  resolveApproval: (threadId: string, approvalId: string | number) => void;
  clearUnread: (threadId: string) => void;
  removeTask: (threadId: string) => void;
}

const pendingDeltas = new Map<string, Map<string, string>>();
const pendingReasoningItems = new Map<string, Set<string>>();
const reasoningStreams = new Map<string, { summary: string; content: string }>();
let deltaFrame: number | ReturnType<typeof setTimeout> | null = null;
let timelineSequence = 0;

function withTimelineOrder<T extends { timelineOrder?: number }>(entry: T): T {
  if (entry.timelineOrder !== undefined) {
    timelineSequence = Math.max(timelineSequence, entry.timelineOrder);
    return entry;
  }
  return { ...entry, timelineOrder: ++timelineSequence };
}

function emptyTask(threadId: string, workspacePath?: string): ThreadTaskState {
  return {
    threadId,
    workspacePath,
    status: "idle",
    messages: [],
    activities: [],
    approvals: [],
    agents: [],
    diff: "",
    usage: null,
    unread: false,
    updatedAt: Date.now(),
  };
}

function scheduleDeltaFlush(flush: () => void): void {
  if (deltaFrame !== null) return;
  if (typeof requestAnimationFrame === "function") {
    deltaFrame = requestAnimationFrame(() => {
      deltaFrame = null;
      flush();
    });
  } else {
    deltaFrame = setTimeout(() => {
      deltaFrame = null;
      flush();
    }, 16);
  }
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  activeThreadId: null,
  tasks: {},
  statuses: {},
  setActiveThread: (threadId) => set((state) => {
    if (!threadId || !state.tasks[threadId]) return { activeThreadId: threadId };
    return {
      activeThreadId: threadId,
      tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], unread: false } },
    };
  }),
  ensureTask: (threadId, workspacePath) => set((state) => {
    if (state.tasks[threadId]) {
      if (!workspacePath || state.tasks[threadId].workspacePath === workspacePath) return state;
      return { tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], workspacePath } } };
    }
    return {
      tasks: { ...state.tasks, [threadId]: emptyTask(threadId, workspacePath) },
      statuses: { ...state.statuses, [threadId]: "idle" },
    };
  }),
  hydrateTask: (threadId, messages, activities, workspacePath) => set((state) => {
    const existing = state.tasks[threadId];
    const hydratedMessages = messages.map(withTimelineOrder);
    // The turns-derived history excludes the incomplete turn's partially
    // streamed assistant message. Keep it, so re-opening a running thread does
    // not truncate the stream to whatever deltas arrive after the hydrate.
    const inFlight = (existing?.messages ?? [])
      .filter((message) => message.streaming && !hydratedMessages.some((entry) => entry.id === message.id))
      .map(({ timelineOrder: _order, ...message }) => withTimelineOrder(message as ChatMessage));
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...(existing ?? emptyTask(threadId, workspacePath)),
          workspacePath,
          messages: [...hydratedMessages, ...inFlight],
          activities: activities.map(withTimelineOrder),
          unread: false,
          updatedAt: Date.now(),
        },
      },
      statuses: { ...state.statuses, [threadId]: state.statuses[threadId] ?? "idle" },
    };
  }),
  appendUserMessage: (threadId, message) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, messages: [...task.messages, withTimelineOrder(message)], updatedAt: Date.now() } } };
  }),
  removeMessage: (threadId, messageId) => set((state) => {
    const task = state.tasks[threadId];
    if (!task || !task.messages.some((message) => message.id === messageId)) return state;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: { ...task, messages: task.messages.filter((message) => message.id !== messageId), updatedAt: Date.now() },
      },
    };
  }),
  queueAssistantDelta: (threadId, itemId, delta) => {
    const byItem = pendingDeltas.get(threadId) ?? new Map<string, string>();
    byItem.set(itemId, `${byItem.get(itemId) ?? ""}${delta}`);
    pendingDeltas.set(threadId, byItem);
    scheduleDeltaFlush(get().flushDeltas);
  },
  queueReasoningDelta: (threadId, itemId, delta, source) => {
    const key = `${threadId}\0${itemId}`;
    const stream = reasoningStreams.get(key) ?? { summary: "", content: "" };
    stream[source] = `${stream[source]}${delta}`;
    reasoningStreams.set(key, stream);
    const items = pendingReasoningItems.get(threadId) ?? new Set<string>();
    items.add(itemId);
    pendingReasoningItems.set(threadId, items);
    scheduleDeltaFlush(get().flushDeltas);
  },
  flushDeltas: () => {
    if (!pendingDeltas.size && !pendingReasoningItems.size) return;
    const batch = new Map(pendingDeltas);
    const reasoningBatch = new Map(pendingReasoningItems);
    pendingDeltas.clear();
    pendingReasoningItems.clear();
    set((state) => {
      const tasks = { ...state.tasks };
      const threadIds = new Set([...batch.keys(), ...reasoningBatch.keys()]);
      for (const threadId of threadIds) {
        const task = tasks[threadId] ?? emptyTask(threadId);
        let messages = task.messages;
        let messagesCopied = false;
        for (const [itemId, delta] of batch.get(threadId) ?? []) {
          const index = messages.findIndex((message) => message.id === itemId);
          if (index < 0) {
            messages = [...messages, withTimelineOrder<ChatMessage>({ id: itemId, role: "assistant", text: delta, streaming: true })];
            messagesCopied = true;
          } else {
            if (!messagesCopied) {
              messages = [...messages];
              messagesCopied = true;
            }
            const message = messages[index];
            messages[index] = { ...message, text: `${message.text}${delta}`, streaming: true };
          }
        }
        let activities = task.activities;
        let activitiesCopied = false;
        for (const itemId of reasoningBatch.get(threadId) ?? []) {
          const stream = reasoningStreams.get(`${threadId}\0${itemId}`);
          const detail = (stream?.content || stream?.summary || "").trim();
          if (!detail) continue;
          const index = activities.findIndex((activity) => activity.id === itemId);
          const activity: Activity = { id: itemId, kind: "reasoning", title: "Model thinking", detail, status: "inProgress" };
          if (index < 0) {
            activities = [...activities, withTimelineOrder(activity)];
            activitiesCopied = true;
          } else {
            if (!activitiesCopied) {
              activities = [...activities];
              activitiesCopied = true;
            }
            activities[index] = { ...activities[index], ...activity, timelineOrder: activities[index].timelineOrder };
          }
        }
        tasks[threadId] = { ...task, messages, activities, unread: state.activeThreadId !== threadId, updatedAt: Date.now() };
      }
      return { tasks };
    });
  },
  completeMessage: (threadId, message) => {
    // Drop any queued deltas for this item so a flush scheduled before the
    // completion event cannot re-append the tail of the finalized text.
    pendingDeltas.get(threadId)?.delete(message.id);
    return set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const exists = task.messages.some((entry) => entry.id === message.id);
    const messages = exists
      ? task.messages.map((entry) => entry.id === message.id ? { ...message, streaming: false, timelineOrder: entry.timelineOrder } : entry)
      : [...task.messages, withTimelineOrder({ ...message, streaming: false })];
    return { tasks: { ...state.tasks, [threadId]: { ...task, messages, unread: state.activeThreadId !== threadId, updatedAt: Date.now() } } };
    });
  },
  upsertActivity: (threadId, activity) => {
    if (activity.kind === "reasoning" && activity.status === "completed") reasoningStreams.delete(`${threadId}\0${activity.id}`);
    set((state) => {
      const task = state.tasks[threadId] ?? emptyTask(threadId);
      const exists = task.activities.some((entry) => entry.id === activity.id);
      const activities = exists
        ? task.activities.map((entry) => entry.id === activity.id ? { ...activity, timelineOrder: entry.timelineOrder } : entry)
        : [...task.activities, withTimelineOrder(activity)];
      return { tasks: { ...state.tasks, [threadId]: { ...task, activities, unread: state.activeThreadId !== threadId, updatedAt: Date.now() } } };
    });
  },
  setActiveTurn: (threadId, turnId) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, activeTurnId: turnId, updatedAt: Date.now() } } };
  }),
  setTaskStatus: (threadId, status, error) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return {
      tasks: { ...state.tasks, [threadId]: { ...task, status, error, unread: state.activeThreadId !== threadId && status === "completed" ? true : task.unread, updatedAt: Date.now() } },
      statuses: { ...state.statuses, [threadId]: status },
    };
  }),
  setDiff: (threadId, diff) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, diff, updatedAt: Date.now() } } };
  }),
  setUsage: (threadId, usage) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, usage, updatedAt: Date.now() } } };
  }),
  upsertAgent: (threadId, agent) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const exists = task.agents.some((entry) => entry.id === agent.id);
    const agents = exists ? task.agents.map((entry) => entry.id === agent.id ? { ...entry, ...agent } : entry) : [...task.agents, agent];
    return { tasks: { ...state.tasks, [threadId]: { ...task, agents, updatedAt: Date.now() } } };
  }),
  enqueueApproval: (approval) => set((state) => {
    const task = state.tasks[approval.threadId] ?? emptyTask(approval.threadId);
    if (task.approvals.some((entry) => entry.id === approval.id)) return state;
    return { tasks: { ...state.tasks, [approval.threadId]: { ...task, approvals: [...task.approvals, approval], unread: state.activeThreadId !== approval.threadId, updatedAt: Date.now() } } };
  }),
  resolveApproval: (threadId, approvalId) => set((state) => {
    const task = state.tasks[threadId];
    if (!task) return state;
    return { tasks: { ...state.tasks, [threadId]: { ...task, approvals: task.approvals.filter((entry) => entry.id !== approvalId), updatedAt: Date.now() } } };
  }),
  clearUnread: (threadId) => set((state) => state.tasks[threadId] ? { tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], unread: false } } } : state),
  removeTask: (threadId) => {
    // Clear queued streaming buffers so a pending flush cannot resurrect the
    // deleted thread as a ghost task.
    pendingDeltas.delete(threadId);
    pendingReasoningItems.delete(threadId);
    for (const key of reasoningStreams.keys()) {
      if (key.startsWith(`${threadId}\0`)) reasoningStreams.delete(key);
    }
    return set((state) => {
      const tasks = { ...state.tasks };
      const statuses = { ...state.statuses };
      delete tasks[threadId];
      delete statuses[threadId];
      return { tasks, statuses, activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId };
    });
  },
}));

export function resetTaskStore(): void {
  pendingDeltas.clear();
  pendingReasoningItems.clear();
  reasoningStreams.clear();
  timelineSequence = 0;
  useTaskStore.setState({ activeThreadId: null, tasks: {}, statuses: {} });
}
