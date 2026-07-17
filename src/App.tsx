import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleStop,
  Code2,
  Command,
  Download,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Menu,
  MessageSquare,
  Minus,
  Paperclip,
  Palette,
  PanelRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Pin,
  PinOff,
  Play,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import {
  getCodexRuntimeStatus,
  auditEvent,
  exportDiagnostics,
  getNormalChatWorkspace,
  hasOpenRouterKey,
  listOpenRouterModels,
  onCodexEvent,
  respond,
  restartRuntime,
  rpc,
  saveOpenRouterKey,
  type CodexEvent,
  type CodexRuntimeStatus,
  type JsonObject,
} from "./lib/codex";
import { loadStored, storeValue } from "./lib/storage";
import {
  ModelPowerControl,
  type ReasoningEffort,
  type RuntimeModel,
} from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import { ApprovalCenter } from "./components/ApprovalCenter";
import { CommandPalette } from "./components/CommandPalette";
import { HarnessSettings } from "./components/HarnessSettings";
import type {
  AgentRecord,
  AttachmentRecord,
  CheckpointRecord,
  McpView,
  SkillView,
  StudioTab,
  TokenUsageView,
} from "./components/StudioDock";
import type {
  Account,
  Activity,
  AppSettings,
  ChatMessage,
  CustomAgentProfile,
  PendingApproval,
  PermissionMode,
  Project,
  ProjectAction,
  PromptProfile,
  ScheduledTask,
  ThemeName,
  Thread,
  ThreadItem,
  Turn,
  WorkspaceMode,
} from "./types";
import { useTaskStore } from "./lib/taskStore";
import { friendlyError } from "./lib/errors";

const ChatTimeline = lazy(() => import("./components/ChatTimeline").then((module) => ({ default: module.ChatTimeline })));
const StudioDock = lazy(() => import("./components/StudioDock").then((module) => ({ default: module.StudioDock })));

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Activity[] = [];
const EMPTY_AGENTS: AgentRecord[] = [];

const THEMES: Array<{ id: ThemeName; name: string; description: string; swatches: [string, string, string] }> = [
  { id: "kiwi", name: "OpenKiwi", description: "The original charcoal and electric green", swatches: ["#0c0d0f", "#171a1d", "#a7e26f"] },
  { id: "midnight", name: "Midnight", description: "Deep navy with a crisp cyan signal", swatches: ["#080c14", "#111a28", "#73d7ff"] },
  { id: "ember", name: "Ember", description: "Warm graphite with a copper glow", swatches: ["#100c0a", "#211712", "#f0a566"] },
  { id: "violet", name: "Violet", description: "Ink black with an ultraviolet pulse", swatches: ["#0c0912", "#1b1428", "#c39bff"] },
];

const DEFAULT_SETTINGS: AppSettings = {
  provider: "openai",
  model: "gpt-5.6-sol",
  permission: "ask",
  systemPrompt: "",
  promptProfileId: "empty",
  projectInstructionsEnabled: false,
  subagentsEnabled: false,
  subagentMax: 3,
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
  theme: "kiwi",
  notificationsEnabled: true,
  terminalScrollback: 100_000,
};

const DEFAULT_PROMPT_PROFILES: PromptProfile[] = [
  { id: "empty", name: "Empty", prompt: "", builtIn: true },
  { id: "concise", name: "Concise builder", prompt: "Be concise, make progress autonomously, verify important changes, and clearly report results.", builtIn: true },
  { id: "reviewer", name: "Careful reviewer", prompt: "Prioritize correctness, security, and maintainability. Inspect evidence before conclusions and flag uncertainty explicitly.", builtIn: true },
];

const initialProjects = loadStored<Project[]>("kiwi.projects", []).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
const initialWorkspaceMode: WorkspaceMode = loadStored<WorkspaceMode>("kiwi.workspaceMode", initialProjects.length ? "project" : "chat");
const storedSettings = loadStored<Partial<AppSettings>>("kiwi.settings", {});
const initialSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  ...storedSettings,
  subagentMax: Math.min(24, Math.max(1, Number(storedSettings.subagentMax) || DEFAULT_SETTINGS.subagentMax)),
  model: storedSettings.provider === "openrouter"
    ? ((storedSettings.model || "").includes("/") ? storedSettings.model! : "")
    : (storedSettings.model || DEFAULT_SETTINGS.model),
  theme: THEMES.some((theme) => theme.id === storedSettings.theme) ? storedSettings.theme! : DEFAULT_SETTINGS.theme,
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function normalizedProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function decodeBase64Utf8(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function textFromUserContent(content: ThreadItem["content"]): string {
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function messagesFromTurns(turns: Turn[] = []): ChatMessage[] {
  return turns.flatMap((turn) =>
    turn.items.flatMap((item): ChatMessage[] => {
      if (item.type === "userMessage") {
        return [{ id: item.id ?? crypto.randomUUID(), role: "user", text: textFromUserContent(item.content) }];
      }
      if (item.type === "agentMessage" || item.type === "plan") {
        return [{ id: item.id ?? crypto.randomUUID(), role: "assistant", text: item.text ?? "" }];
      }
      return [];
    }),
  );
}

function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }) {
  if (mode === "read-only") return <Shield size={size} />;
  if (mode === "full") return <ShieldAlert size={size} />;
  return <ShieldCheck size={size} />;
}

function commandSandbox(permission: PermissionMode, cwd: string): JsonObject {
  if (permission === "full") return { type: "dangerFullAccess" };
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialProjects[0]?.id ?? null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialWorkspaceMode);
  const [chatWorkspacePath, setChatWorkspacePath] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  const [startingTurn, setStartingTurn] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [promptProfiles, setPromptProfiles] = useState<PromptProfile[]>(() => loadStored("kiwi.promptProfiles", DEFAULT_PROMPT_PROFILES));
  const [customAgents, setCustomAgents] = useState<CustomAgentProfile[]>(() => loadStored("kiwi.customAgents", []));
  const [projectActions, setProjectActions] = useState<ProjectAction[]>(() => loadStored("kiwi.projectActions", []));
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(() => loadStored("kiwi.scheduledTasks", []));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>(() => loadStored("kiwi.pinnedThreads", []));
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadNameDraft, setThreadNameDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [status, setStatus] = useState("Checking runtime");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(null);
  const [runtimeSetupOpen, setRuntimeSetupOpen] = useState(false);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [authRequiredOpen, setAuthRequiredOpen] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const threadProjectBindingsRef = useRef<Record<string, string> | null>(null);
  const [openRouterReady, setOpenRouterReady] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<StudioTab>("review");
  const [approvedDiff, setApprovedDiff] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalProcessId, setTerminalProcessId] = useState<string | null>(null);
  const terminalSizeRef = useRef({ cols: 100, rows: 30 });
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>(() => loadStored("kiwi.checkpoints", []));
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [rateSummary, setRateSummary] = useState("");
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [gitOutput, setGitOutput] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false);
  const [openRouterModelsError, setOpenRouterModelsError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  if (threadProjectBindingsRef.current === null) {
    threadProjectBindingsRef.current = loadStored("kiwi.threadProjects", {});
  }

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const activeProject = workspaceMode === "project" ? selectedProject : null;
  const chatWorkspace = useMemo<Project | null>(() => chatWorkspacePath ? ({ id: "openkiwi-normal-chats", name: "Chats", path: chatWorkspacePath, isChat: true }) : null, [chatWorkspacePath]);
  const activeWorkspace = workspaceMode === "chat" ? chatWorkspace : activeProject;
  const activeThreadId = activeThread?.id ?? null;
  const messages = useTaskStore((state) => activeThreadId ? state.tasks[activeThreadId]?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES);
  const activities = useTaskStore((state) => activeThreadId ? state.tasks[activeThreadId]?.activities ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES);
  const diff = useTaskStore((state) => activeThreadId ? state.tasks[activeThreadId]?.diff ?? "" : "");
  const agentRecords = useTaskStore((state) => activeThreadId ? state.tasks[activeThreadId]?.agents ?? EMPTY_AGENTS : EMPTY_AGENTS);
  const tokenUsage = useTaskStore((state) => activeThreadId ? state.tasks[activeThreadId]?.usage ?? null : null);
  const taskStatus = useTaskStore((state) => activeThreadId ? state.statuses[activeThreadId] ?? "idle" : "idle");
  const running = startingTurn || taskStatus === "starting" || taskStatus === "running";
  const pendingApproval = useTaskStore((state) => {
    let earliest: PendingApproval | null = null;
    for (const task of Object.values(state.tasks)) {
      const candidate = task.approvals[0];
      if (candidate && (!earliest || candidate.receivedAt < earliest.receivedAt)) earliest = candidate;
    }
    return earliest;
  });
  const threadTasks = useTaskStore((state) => state.tasks);
  const displayedThreads = useMemo(() => threads
    .filter((thread) => `${thread.name ?? ""} ${thread.preview}`.toLowerCase().includes(threadSearch.toLowerCase()))
    .sort((a, b) => Number(pinnedThreadIds.includes(b.id)) - Number(pinnedThreadIds.includes(a.id)) || b.updatedAt - a.updatedAt), [pinnedThreadIds, threadSearch, threads]);

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    storeValue("kiwi.settings", next);
  }, []);

  const bindThreadToProject = useCallback((threadId: string, projectPath: string) => {
    const current = threadProjectBindingsRef.current ?? {};
    if (current[threadId] && normalizedProjectPath(current[threadId]) === normalizedProjectPath(projectPath)) return;
    const next = { ...current, [threadId]: projectPath };
    threadProjectBindingsRef.current = next;
    storeValue("kiwi.threadProjects", next);
  }, []);

  const checkRuntime = useCallback(async (showSetupWhenMissing = true): Promise<CodexRuntimeStatus> => {
    setRuntimeChecking(true);
    try {
      const result = await getCodexRuntimeStatus();
      setRuntimeStatus(result);
      if (result.available) {
        setStatus("Ready");
      } else {
        setStatus("Setup required");
        if (showSetupWhenMissing) setRuntimeSetupOpen(true);
      }
      return result;
    } catch (reason) {
      const result: CodexRuntimeStatus = {
        available: false,
        source: null,
        path: null,
        version: null,
        compatible: false,
        warning: null,
      };
      setRuntimeStatus(result);
      setStatus("Setup required");
      setError(friendlyError(reason));
      if (showSetupWhenMissing) setRuntimeSetupOpen(true);
      return result;
    } finally {
      setRuntimeChecking(false);
    }
  }, []);

  const loadThreads = useCallback(async (project: Project | null) => {
    if (!project) {
      setThreads([]);
      return;
    }
    try {
      const allThreads: Thread[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result: { data: Thread[]; nextCursor?: string | null } = await rpc("thread/list", { cwd: project.path, limit: 100, cursor });
        allThreads.push(...(result.data ?? []));
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      const projectPath = normalizedProjectPath(project.path);
      setThreads(allThreads.filter((thread) => {
        const boundPath = threadProjectBindingsRef.current?.[thread.id];
        return normalizedProjectPath(boundPath || thread.cwd) === projectPath;
      }));
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    try {
      const result = await rpc<{ account: Account | null }>("account/read", { refreshToken: false });
      setAccount(result.account);
      if (result.account?.type === "chatgpt") {
        setAuthRequiredOpen(false);
        setError(null);
        setStatus("Ready");
      }
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const allModels: RuntimeModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result: { data: RuntimeModel[]; nextCursor?: string | null } = await rpc("model/list", { limit: 100, includeHidden: false, cursor });
        allModels.push(...(result.data ?? []));
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      setRuntimeModels(allModels);
    } catch {
      setRuntimeModels([]);
    }
  }, []);

  const refreshOpenRouterModels = useCallback(async () => {
    setOpenRouterModelsLoading(true);
    setOpenRouterModelsError("");
    try {
      const result = await listOpenRouterModels<{ data?: OpenRouterModel[] }>();
      const models = (result.data ?? [])
        .filter((entry) => entry.id && entry.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      setOpenRouterModels(models);
      if (!models.length) setOpenRouterModelsError("OpenRouter returned an empty catalog");
    } catch (reason) {
      setOpenRouterModelsError(friendlyError(reason));
    } finally {
      setOpenRouterModelsLoading(false);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const result = await rpc<{ rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number } } }>("account/rateLimits/read");
      const primary = result.rateLimits?.primary;
      setRateSummary(primary ? `${Math.round(primary.usedPercent ?? 0)}% used${primary.resetsAt ? ` · resets ${new Date(primary.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "No active limit window");
    } catch {
      setRateSummary("");
    }
  }, []);

  const refreshTools = useCallback(async (project: Project | null) => {
    if (!project) return;
    const [skillResult, mcpResult] = await Promise.allSettled([
      rpc<{ data: Array<{ skills?: Array<{ name: string; description?: string; path?: string; enabled?: boolean }> }> }>("skills/list", { cwds: [project.path], forceReload: true }),
      rpc<{ data: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }> }>("mcpServerStatus/list", { detail: "full" }),
    ]);
    if (skillResult.status === "fulfilled") {
      setSkills((skillResult.value.data ?? []).flatMap((entry) => entry.skills ?? []).map((skill) => ({ name: skill.name, description: skill.description, path: skill.path, enabled: skill.enabled !== false })));
    }
    if (mcpResult.status === "fulfilled") {
      setMcpServers((mcpResult.value.data ?? []).map((server) => ({ name: server.name, status: server.authStatus || "ready", tools: Object.keys(server.tools ?? {}).length })));
    }
  }, []);

  const executeCommand = useCallback(async (command: string[], cwd: string) => {
    return rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", { command, cwd, timeoutMs: 120000, sandboxPolicy: commandSandbox(settings.permission, cwd) });
  }, [settings.permission]);

  const refreshDiffFor = useCallback(async (threadId: string, projectPath: string) => {
    setApprovedDiff(false);
    try {
      const result = await rpc<{ diff: string }>("gitDiffToRemote", { cwd: projectPath });
      useTaskStore.getState().setDiff(threadId, result.diff ?? "");
    } catch {
      try {
        const result = await executeCommand(["git", "diff", "--no-ext-diff", "--"], projectPath);
        useTaskStore.getState().setDiff(threadId, `${result.stdout}${result.stderr}`);
      } catch (reason) {
        setError(friendlyError(reason));
      }
    }
  }, [executeCommand]);

  const refreshDiff = useCallback(async () => {
    if (!activeProject || !activeThreadId) return;
    await refreshDiffFor(activeThreadId, activeProject.path);
  }, [activeProject, activeThreadId, refreshDiffFor]);

  const handleItem = useCallback((threadId: string, item: ThreadItem) => {
    const taskStore = useTaskStore.getState();
    taskStore.ensureTask(threadId, threadProjectBindingsRef.current?.[threadId]);
    const id = item.id ?? crypto.randomUUID();
    if (item.type === "agentMessage" || item.type === "plan") {
      taskStore.completeMessage(threadId, { id, role: "assistant", text: item.text ?? "", streaming: false });
      return;
    }
    if (item.type === "commandExecution") {
      taskStore.upsertActivity(threadId, {
        id,
        kind: "command",
        title: item.command ?? "Run command",
        detail: item.aggregatedOutput ?? item.cwd,
        status: item.status,
      });
      return;
    }
    if (item.type === "fileChange") {
      taskStore.upsertActivity(threadId, {
        id,
        kind: "file",
        title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`,
        status: item.status,
      });
      return;
    }
    if (item.type === "reasoning" && item.summary?.length) {
      taskStore.upsertActivity(threadId, { id, kind: "reasoning", title: item.summary.join(" ") });
      return;
    }
    if (item.type === "collabAgentToolCall") {
      const titles: Record<string, string> = {
        spawnAgent: `Spawn sub-agent${item.receiverThreadIds?.length === 1 ? "" : "s"}`,
        sendInput: "Send input to sub-agent",
        resumeAgent: "Resume sub-agent",
        wait: "Wait for sub-agents",
        closeAgent: "Close sub-agent",
      };
      taskStore.upsertActivity(threadId, {
        id,
        kind: "agent",
        title: titles[item.tool ?? ""] ?? "Sub-agent activity",
        detail: item.prompt ?? undefined,
        status: item.status,
      });
      if (item.receiverThreadIds?.length) {
        for (const childThreadId of item.receiverThreadIds) {
          taskStore.upsertAgent(threadId, { id: childThreadId, prompt: item.prompt ?? "Delegated task", status: item.status ?? "inProgress" });
          taskStore.ensureTask(childThreadId, threadProjectBindingsRef.current?.[threadId]);
        }
      }
      return;
    }
    if (item.type === "subAgentActivity") {
      const action = item.kind === "started" ? "started" : item.kind === "interrupted" ? "interrupted" : "working";
      taskStore.upsertActivity(threadId, {
        id,
        kind: "agent",
        title: `Sub-agent ${action}`,
        detail: item.agentPath || item.agentThreadId,
        status: item.kind,
      });
      if (item.agentThreadId) {
        taskStore.upsertAgent(threadId, { id: item.agentThreadId, prompt: "Delegated task", status: item.kind ?? "working", path: item.agentPath });
      }
    }
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void onCodexEvent((event: CodexEvent) => {
      if (event.stream === "stderr") {
        const line = event.line?.toLowerCase() ?? "";
        if (line.includes("401 unauthorized")) {
          setStatus("Sign-in required");
          setError("Sign in to your ChatGPT account in Settings before using OpenAI models.");
          setAuthRequiredOpen(true);
        } else if (line.includes("error")) {
          setStatus("Runtime issue");
        }
        return;
      }

      const method = event.method ?? "";
      const params = event.params ?? {};
      const eventThreadId = typeof params.threadId === "string"
        ? params.threadId
        : useTaskStore.getState().activeThreadId ?? "runtime";
      if (event.id !== undefined && method === "currentTime/read") {
        void respond(event.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      }
      if (event.id !== undefined && (
        method.includes("requestApproval")
        || method.endsWith("Approval")
        || method === "item/tool/requestUserInput"
        || method === "mcpServer/elicitation/request"
      )) {
        useTaskStore.getState().enqueueApproval({
          id: event.id,
          method,
          params,
          threadId: eventThreadId,
          receivedAt: Date.now(),
        });
        void auditEvent("approval.requested", { method, params }, eventThreadId).catch(() => {});
        return;
      }
      if (method === "item/agentMessage/delta") {
        useTaskStore.getState().queueAssistantDelta(eventThreadId, String(params.itemId), String(params.delta ?? ""));
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        if (params.item && typeof params.item === "object") handleItem(eventThreadId, params.item as ThreadItem);
        return;
      }
      if (method === "turn/diff/updated") {
        useTaskStore.getState().setDiff(eventThreadId, String(params.diff ?? ""));
        setApprovedDiff(false);
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = params.tokenUsage as { total?: Partial<TokenUsageView>; modelContextWindow?: number | null } | undefined;
        if (usage?.total) {
          useTaskStore.getState().setUsage(eventThreadId, {
            totalTokens: Number(usage.total.totalTokens ?? 0),
            inputTokens: Number(usage.total.inputTokens ?? 0),
            cachedInputTokens: Number(usage.total.cachedInputTokens ?? 0),
            outputTokens: Number(usage.total.outputTokens ?? 0),
            reasoningOutputTokens: Number(usage.total.reasoningOutputTokens ?? 0),
            contextWindow: usage.modelContextWindow,
          });
        }
        return;
      }
      if (method === "command/exec/outputDelta") {
        const delta = decodeBase64Utf8(params.deltaBase64);
        setTerminalOutput((current) => `${current}${delta}`.slice(-settings.terminalScrollback));
        return;
      }
      if (method === "account/rateLimits/updated") {
        const limits = params.rateLimits as { primary?: { usedPercent?: number } } | undefined;
        if (limits?.primary) setRateSummary(`${Math.round(limits.primary.usedPercent ?? 0)}% used`);
        return;
      }
      if (method === "turn/started") {
        useTaskStore.getState().setTaskStatus(eventThreadId, "running");
        void auditEvent("turn.started", {}, eventThreadId).catch(() => {});
        if (useTaskStore.getState().activeThreadId === eventThreadId) setStatus("Working");
        return;
      }
      if (method === "turn/completed") {
        if (params.turn && typeof params.turn === "object") {
          const completedTurn = params.turn as unknown as Turn;
          setActiveThread((current) => current && current.id === String(params.threadId) ? { ...current, turns: [...(current.turns ?? []).filter((turn) => turn.id !== completedTurn.id), completedTurn] } : current);
        }
        useTaskStore.getState().setTaskStatus(eventThreadId, "completed");
        void auditEvent("turn.completed", {}, eventThreadId).catch(() => {});
        if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== eventThreadId) {
          void (async () => {
            let granted = await isPermissionGranted();
            if (!granted) granted = (await requestPermission()) === "granted";
            if (granted) sendNotification({ title: "OpenKiwi task complete", body: "A background coding task finished." });
          })().catch(() => {});
        }
        if (useTaskStore.getState().activeThreadId === eventThreadId) setStatus("Ready");
        const projectPath = threadProjectBindingsRef.current?.[eventThreadId];
        if (projectPath && !projectPath.includes("normal-chats")) void refreshDiffFor(eventThreadId, projectPath);
        return;
      }
      if (method === "thread/status/changed") {
        const statusValue = params.status as { type?: string } | undefined;
        const nextStatus = statusValue?.type === "active" ? "running" : statusValue?.type === "systemError" ? "error" : "idle";
        useTaskStore.getState().setTaskStatus(eventThreadId, nextStatus);
        return;
      }
      if (method === "error" || method === "warning" || method === "guardianWarning" || method === "configWarning") {
        useTaskStore.getState().upsertActivity(eventThreadId, {
          id: `${method}-${Date.now()}`,
          kind: "warning",
          title: String(params.message ?? params.error ?? "Runtime warning"),
          detail: typeof params.details === "string" ? params.details : undefined,
        });
        return;
      }
      if (method === "account/updated") {
        void refreshAccount();
        return;
      }
      if (method === "account/login/completed" && params.success === false) {
        setError(String(params.error ?? "Sign in did not complete"));
        setAuthRequiredOpen(true);
      }
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [handleItem, refreshAccount, refreshDiffFor, settings.notificationsEnabled, settings.terminalScrollback]);

  useEffect(() => {
    void getNormalChatWorkspace().then(setChatWorkspacePath).catch((reason) => setError(friendlyError(reason)));
    void checkRuntime(true).then((runtime) => {
      if (!runtime.available) return;
      void refreshAccount();
      void refreshModels();
      void refreshUsage();
    });
    void refreshOpenRouterModels();
    void hasOpenRouterKey().then(setOpenRouterReady).catch(() => setOpenRouterReady(false));
  }, [checkRuntime, refreshAccount, refreshModels, refreshOpenRouterModels, refreshUsage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (runtimeStatus?.available) {
      void loadThreads(activeWorkspace);
      if (activeProject) void refreshTools(activeProject);
    } else {
      setThreads([]);
    }
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setAttachments([]);
    setApprovedDiff(false);
    if (!activeProject) setStudioOpen(false);
  }, [activeProject, activeWorkspace, loadThreads, refreshTools, runtimeStatus?.available]);

  const addProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (!selected || Array.isArray(selected)) return;
    const existing = projects.find((project) => project.path === selected);
    if (existing) {
      setActiveProjectId(existing.id);
      setWorkspaceMode("project");
      storeValue("kiwi.workspaceMode", "project");
      return;
    }
    const project: Project = { id: crypto.randomUUID(), name: basename(selected), path: selected };
    const next = [...projects, project];
    setProjects(next);
    setActiveProjectId(project.id);
    setWorkspaceMode("project");
    storeValue("kiwi.workspaceMode", "project");
    storeValue("kiwi.projects", next);
  };

  const toggleProjectPin = (project: Project) => {
    const next = projects
      .map((entry) => entry.id === project.id ? { ...entry, pinned: !entry.pinned } : entry)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    setProjects(next);
    storeValue("kiwi.projects", next);
  };

  const removeProject = (project: Project) => {
    const confirmed = window.confirm(`Remove “${project.name}” from OpenKiwi?\n\nIts folder and every file inside it will remain untouched on your Mac.`);
    if (!confirmed) return;
    const next = projects.filter((entry) => entry.id !== project.id);
    setProjects(next);
    storeValue("kiwi.projects", next);
    if (activeProjectId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      if (!next.length) {
        setWorkspaceMode("chat");
        storeValue("kiwi.workspaceMode", "chat");
      }
    }
  };

  const selectThread = async (thread: Thread) => {
    if (!activeWorkspace) return;
    const projectPath = normalizedProjectPath(activeWorkspace.path);
    const threadPath = normalizedProjectPath(threadProjectBindingsRef.current?.[thread.id] || thread.cwd);
    if (threadPath !== projectPath) {
      setError("That thread belongs to a different chat or project and cannot be opened here.");
      return;
    }
    setError(null);
    setStatus("Loading thread");
    try {
      const result = await rpc<{ thread: Thread }>("thread/resume", {
        threadId: thread.id,
        cwd: activeWorkspace.path,
        runtimeWorkspaceRoots: [activeWorkspace.path],
      });
      bindThreadToProject(result.thread.id, activeWorkspace.path);
      setActiveThread(result.thread);
      useTaskStore.getState().hydrateTask(result.thread.id, messagesFromTurns(result.thread.turns), activeWorkspace.path);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStatus("Ready");
    } catch (reason) {
      setError(friendlyError(reason));
      setStatus("Ready");
    }
  };

  const newThread = () => {
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraft("");
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || !activeWorkspace) return;
    if (!runtimeStatus?.available) {
      setRuntimeSetupOpen(true);
      return;
    }
    if (settings.provider === "openai" && account?.type !== "chatgpt") {
      setAuthRequiredOpen(true);
      return;
    }
    if (settings.provider === "openrouter" && !openRouterReady) {
      setSettingsOpen(true);
      setError("Add an OpenRouter API key before using OpenRouter.");
      return;
    }
    if (settings.provider === "openrouter" && !settings.model.trim()) {
      setError("Choose an OpenRouter model before starting this thread.");
      return;
    }

    if (running && activeThread) {
      setDraft("");
      setError(null);
      useTaskStore.getState().appendUserMessage(activeThread.id, { id: `local-${crypto.randomUUID()}`, role: "user", text });
      try {
        await rpc("turn/steer", {
          threadId: activeThread.id,
          input: [{ type: "text", text, text_elements: [] }],
        });
        setStatus("Direction added");
      } catch (reason) {
        setDraft(text);
        setError(friendlyError(reason));
      }
      return;
    }

    setDraft("");
    setError(null);
    setStartingTurn(true);
    setStatus("Starting");

    try {
      const fileContext = attachments.filter((item) => item.kind === "file").map((item) => `@${item.path}`).join("\n");
      const input: Array<JsonObject> = [
        { type: "text", text: fileContext ? `${text}\n\nAttached context:\n${fileContext}` : text, text_elements: [] },
        ...attachments.filter((item) => item.kind === "image").map((item) => ({ type: "localImage", path: item.path, detail: "auto" })),
      ];
      let threadId = activeThread?.id;
      if (!threadId) {
        const sandbox = settings.permission === "read-only" ? "read-only" : settings.permission === "full" ? "danger-full-access" : "workspace-write";
        const approvalPolicy = settings.permission === "ask" ? "on-request" : "never";
        const startParams: JsonObject = {
          cwd: activeWorkspace.path,
          runtimeWorkspaceRoots: [activeWorkspace.path],
          sandbox,
          approvalPolicy,
          baseInstructions: settings.systemPrompt,
          developerInstructions: "",
          config: {
            project_doc_max_bytes: settings.projectInstructionsEnabled ? 32_768 : 0,
            project_doc_fallback_filenames: [],
            developer_instructions: "",
            model_reasoning_effort: settings.ultra ? "ultra" : settings.reasoningEffort,
            agents: {
              max_threads: settings.subagentMax,
              max_depth: 1,
              ...Object.fromEntries(customAgents.filter((agent) => agent.enabled).map((agent) => [
                agent.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || agent.id,
                {
                  description: agent.description,
                  instructions: agent.instructions,
                  model: agent.model,
                  model_reasoning_effort: agent.reasoningEffort,
                },
              ])),
            },
            features: {
              multi_agent: settings.subagentsEnabled,
            },
          },
          serviceName: activeWorkspace.isChat ? "OpenKiwi Chat" : "OpenKiwi",
          serviceTier: settings.serviceTier,
        };
        if (settings.model.trim()) startParams.model = settings.model.trim();
        if (settings.provider === "openrouter") startParams.modelProvider = "openrouter";

        const result = await rpc<{ thread: Thread }>("thread/start", startParams);
        threadId = result.thread.id;
        bindThreadToProject(result.thread.id, activeWorkspace.path);
        setActiveThread(result.thread);
        useTaskStore.getState().ensureTask(result.thread.id, activeWorkspace.path);
        useTaskStore.getState().setActiveThread(result.thread.id);
      }

      useTaskStore.getState().ensureTask(threadId, activeWorkspace.path);
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      useTaskStore.getState().appendUserMessage(threadId, { id: `local-${crypto.randomUUID()}`, role: "user", text });

      await rpc("turn/start", {
        threadId,
        input,
        cwd: activeWorkspace.path,
        runtimeWorkspaceRoots: [activeWorkspace.path],
        sandboxPolicy: commandSandbox(settings.permission, activeWorkspace.path),
        model: settings.model.trim() || undefined,
        effort: settings.ultra ? "ultra" : settings.reasoningEffort,
        serviceTier: settings.serviceTier,
      });
      setStartingTurn(false);
      setAttachments([]);
      void loadThreads(activeWorkspace);
    } catch (reason) {
      setStartingTurn(false);
      if (activeThread?.id) useTaskStore.getState().setTaskStatus(activeThread.id, "error", friendlyError(reason));
      setStatus("Ready");
      setError(friendlyError(reason));
    }
  };

  const stopTurn = async () => {
    if (!activeThread || !running) return;
    try {
      await rpc("turn/interrupt", { threadId: activeThread.id });
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      setStartingTurn(false);
      setStatus("Stopped");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const retryRuntime = async () => {
    const runtime = await checkRuntime(false);
    if (!runtime.available) {
      setRuntimeSetupOpen(true);
      return;
    }
    try {
      await restartRuntime();
      setRuntimeSetupOpen(false);
      setError(null);
      await Promise.all([refreshAccount(), refreshModels(), refreshUsage()]);
      if (activeWorkspace) await loadThreads(activeWorkspace);
      if (activeProject) await refreshTools(activeProject);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const beginChatGptLogin = async () => {
    if (!runtimeStatus?.available) {
      setAuthRequiredOpen(false);
      setRuntimeSetupOpen(true);
      return;
    }
    setLoginStarting(true);
    setError(null);
    try {
      const result = await rpc<{ authUrl?: string }>("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      });
      if (!result.authUrl) throw new Error("Codex did not return a ChatGPT sign-in URL.");
      setAuthRequiredOpen(false);
      setStatus("Waiting for sign-in");
      await openUrl(result.authUrl);
      window.setTimeout(() => void refreshAccount(), 1800);
    } catch (reason) {
      setError(friendlyError(reason));
      setAuthRequiredOpen(true);
    } finally {
      setLoginStarting(false);
    }
  };

  const answerApproval = async (result: JsonObject) => {
    if (!pendingApproval) return;
    try {
      await respond(pendingApproval.id, result);
      void auditEvent("approval.resolved", { method: pendingApproval.method, responseRecorded: true }, pendingApproval.threadId).catch(() => {});
      useTaskStore.getState().resolveApproval(pendingApproval.threadId, pendingApproval.id);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const startThreadRename = (thread: Thread) => {
    setRenamingThreadId(thread.id);
    setThreadNameDraft(thread.name || thread.preview || "Untitled thread");
  };

  const renameThread = async (thread: Thread) => {
    const name = threadNameDraft.trim();
    setRenamingThreadId(null);
    if (!name || name === thread.name) return;
    try {
      await rpc("thread/name/set", { threadId: thread.id, name });
      setThreads((current) => current.map((entry) => entry.id === thread.id ? { ...entry, name } : entry));
      setActiveThread((current) => current?.id === thread.id ? { ...current, name } : current);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const deleteThread = async (thread: Thread) => {
    const label = thread.name || thread.preview || "Untitled thread";
    if (!window.confirm(`Delete “${label}” from OpenKiwi's thread list?`)) return;
    try {
      await rpc("thread/archive", { threadId: thread.id });
      if (activeThread?.id === thread.id) newThread();
      setThreads((current) => current.filter((entry) => entry.id !== thread.id));
      void loadThreads(activeWorkspace);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const toggleThreadPin = (threadId: string) => {
    const next = pinnedThreadIds.includes(threadId) ? pinnedThreadIds.filter((id) => id !== threadId) : [...pinnedThreadIds, threadId];
    setPinnedThreadIds(next);
    storeValue("kiwi.pinnedThreads", next);
  };

  const openStudio = (tab: StudioTab) => {
    setStudioTab(tab);
    setStudioOpen(true);
  };

  const startReview = async () => {
    if (!activeThread) return;
    try {
      await rpc("review/start", { threadId: activeThread.id, target: { type: "uncommittedChanges" }, delivery: "inline" });
      setStatus("Reviewing");
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const openAgent = async (threadId: string) => {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setActiveThread(result.thread);
      useTaskStore.getState().hydrateTask(result.thread.id, messagesFromTurns(result.thread.turns), result.thread.cwd);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const stopAgent = async (threadId: string) => {
    try {
      await rpc("turn/interrupt", { threadId });
      useTaskStore.getState().setTaskStatus(threadId, "interrupted");
      if (activeThreadId) useTaskStore.getState().upsertAgent(activeThreadId, { id: threadId, prompt: "Delegated task", status: "interrupted" });
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const runTerminal = async () => {
    const command = terminalCommand.trim();
    if (!command || !activeProject || terminalRunning) return;
    const processId = crypto.randomUUID();
    setTerminalProcessId(processId);
    setTerminalRunning(true);
    setTerminalOutput((current) => `${current}${current ? "\n" : ""}$ ${command}\n`);
    setTerminalCommand("");
    try {
      const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
        command: ["/bin/zsh", "-lc", command],
        processId,
        tty: true,
        streamStdoutStderr: true,
        streamStdin: true,
        size: terminalSizeRef.current,
        cwd: activeProject.path,
        timeoutMs: 300000,
        sandboxPolicy: commandSandbox(settings.permission, activeProject.path),
      });
      if (result.stdout || result.stderr) setTerminalOutput((current) => current + result.stdout + result.stderr);
      setTerminalOutput((current) => `${current}\n[exit ${result.exitCode}]\n`);
    } catch (reason) {
      setTerminalOutput((current) => `${current}\n${friendlyError(reason)}\n`);
    } finally {
      setTerminalRunning(false);
      setTerminalProcessId(null);
    }
  };

  const stopTerminal = async () => {
    if (!terminalProcessId) return;
    try { await rpc("command/exec/terminate", { processId: terminalProcessId }); } catch (reason) { setError(friendlyError(reason)); }
  };

  const writeTerminal = useCallback((value: string) => {
    if (!terminalProcessId || !terminalRunning) return;
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    void rpc("command/exec/write", { processId: terminalProcessId, deltaBase64: btoa(binary) })
      .catch((reason) => setError(friendlyError(reason)));
  }, [terminalProcessId, terminalRunning]);

  const resizeTerminal = useCallback((columns: number, rows: number) => {
    terminalSizeRef.current = { cols: columns, rows };
    if (!terminalProcessId || !terminalRunning) return;
    void rpc("command/exec/resize", { processId: terminalProcessId, size: { cols: columns, rows } }).catch(() => {});
  }, [terminalProcessId, terminalRunning]);

  const createCheckpoint = () => {
    if (!activeThread) return;
    const turnId = activeThread.turns?.at(-1)?.id;
    const checkpoint: CheckpointRecord = { id: crypto.randomUUID(), threadId: activeThread.id, turnId, label: `Checkpoint ${checkpoints.filter((item) => item.threadId === activeThread.id).length + 1}`, createdAt: Date.now() };
    const next = [checkpoint, ...checkpoints];
    setCheckpoints(next);
    storeValue("kiwi.checkpoints", next);
  };

  const forkThread = async (checkpoint?: CheckpointRecord) => {
    if (!activeThread) return;
    try {
      const result = await rpc<{ thread: Thread }>("thread/fork", {
        threadId: checkpoint?.threadId ?? activeThread.id,
        lastTurnId: checkpoint?.turnId,
        cwd: activeWorkspace?.path,
        runtimeWorkspaceRoots: activeWorkspace ? [activeWorkspace.path] : undefined,
        model: settings.model,
        baseInstructions: settings.systemPrompt,
        developerInstructions: "",
      });
      if (activeWorkspace) bindThreadToProject(result.thread.id, activeWorkspace.path);
      setActiveThread(result.thread);
      useTaskStore.getState().hydrateTask(result.thread.id, messagesFromTurns(result.thread.turns), activeWorkspace?.path);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
      void loadThreads(activeWorkspace);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const rollbackTurn = async () => {
    if (!activeThread) return;
    try {
      const result = await rpc<{ thread: Thread }>("thread/rollback", { threadId: activeThread.id, numTurns: 1 });
      setActiveThread(result.thread);
      useTaskStore.getState().hydrateTask(result.thread.id, messagesFromTurns(result.thread.turns), activeWorkspace?.path);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const createWorktree = async () => {
    if (!activeProject) return;
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
    const worktreePath = `${activeProject.path}-openkiwi-${stamp}`;
    const branch = `openkiwi/${stamp}`;
    try {
      const result = await executeCommand(["git", "worktree", "add", worktreePath, "-b", branch], activeProject.path);
      setTerminalOutput((current) => `${current}\n$ git worktree add ${worktreePath} -b ${branch}\n${result.stdout}${result.stderr}`);
      const project: Project = { id: crypto.randomUUID(), name: `${activeProject.name} · ${branch}`, path: worktreePath };
      const next = [...projects, project];
      setProjects(next);
      storeValue("kiwi.projects", next);
      setActiveProjectId(project.id);
      setWorkspaceMode("project");
      storeValue("kiwi.workspaceMode", "project");
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const addAttachment = async () => {
    const selected = await open({ multiple: true, directory: false, title: "Add context files or images" });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const imagePattern = /\.(png|jpe?g|gif|webp|heic)$/i;
    setAttachments((current) => [...current, ...paths.filter((path) => !current.some((item) => item.path === path)).map((path) => ({ path, name: basename(path), kind: imagePattern.test(path) ? "image" as const : "file" as const }))]);
  };

  const runGitAction = async (action: "status" | "diff" | "stage" | "revert" | "commit" | "comments" | "ci" | "pr") => {
    if (!activeProject) return;
    let command: string[];
    if (action === "status") command = ["git", "status", "--short", "--branch"];
    else if (action === "diff") command = ["git", "diff", "--stat", "--patch"];
    else if (action === "stage") command = ["git", "add", "--all"];
    else if (action === "revert") {
      if (!window.confirm("Revert all tracked staged and working-tree changes? Untracked files will be kept.")) return;
      command = ["git", "restore", "--staged", "--worktree", "."];
    }
    else if (action === "commit") command = ["git", "commit", "-m", gitCommitMessage.trim()];
    else if (action === "comments") command = ["gh", "pr", "view", "--comments"];
    else if (action === "ci") command = ["gh", "pr", "checks"];
    else {
      if (!window.confirm("Create a draft pull request on the configured GitHub remote?")) return;
      command = ["gh", "pr", "create", "--draft", "--fill"];
    }
    try {
      const result = await executeCommand(command, activeProject.path);
      const combined = `${result.stdout}${result.stderr || ""}`;
      setGitOutput(combined.includes("not a git repository") ? "This project folder is not a Git repository yet. Initialize Git from the terminal to enable these workflows." : `$ ${command.join(" ")}\n${combined}\n[exit ${result.exitCode}]`);
      if (action === "diff" && activeThreadId) useTaskStore.getState().setDiff(activeThreadId, result.stdout);
      if (action === "commit" && result.exitCode === 0) setGitCommitMessage("");
    } catch (reason) { setGitOutput(friendlyError(reason)); }
  };

  const runProjectAction = async (action: ProjectAction) => {
    if (!activeProject) return;
    setStudioTab("terminal");
    setTerminalOutput((current) => `${current}${current ? "\n" : ""}$ ${action.command}\n`);
    try {
      const result = await executeCommand(["/bin/zsh", "-lc", action.command], activeProject.path);
      setTerminalOutput((current) => `${current}${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
      void auditEvent("action.completed", { actionId: action.id, command: action.command, exitCode: result.exitCode }, activeThreadId ?? undefined).catch(() => {});
    } catch (reason) {
      setTerminalOutput((current) => `${current}${friendlyError(reason)}\n`);
    }
  };

  const runGitPathAction = async (action: "stage" | "revert", path: string) => {
    if (!activeProject) return;
    if (action === "revert" && !window.confirm(`Revert changes to ${path}?`)) return;
    const command = action === "stage" ? ["git", "add", "--", path] : ["git", "restore", "--staged", "--worktree", "--", path];
    try {
      const result = await executeCommand(command, activeProject.path);
      setGitOutput(`$ ${command.join(" ")}\n${result.stdout}${result.stderr}\n[exit ${result.exitCode}]`);
      if (activeThreadId) await refreshDiffFor(activeThreadId, activeProject.path);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const toggleSkill = async (skill: SkillView) => {
    try {
      await rpc("skills/config/write", { path: skill.path ?? null, name: skill.path ? null : skill.name, enabled: skill.enabled === false });
      await refreshTools(activeProject);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const connectMcp = async (server: McpView) => {
    try {
      const result = await rpc<{ authorizationUrl: string }>("mcpServer/oauth/login", { name: server.name, threadId: activeThreadId });
      if (result.authorizationUrl) await openUrl(result.authorizationUrl);
    } catch (reason) { setError(friendlyError(reason)); }
  };

  const scheduledRunningRef = useRef(new Set<string>());
  const runScheduledTask = useCallback(async (scheduled: ScheduledTask) => {
    if (scheduledRunningRef.current.has(scheduled.id) || !runtimeStatus?.available) return;
    const project = projects.find((item) => item.id === scheduled.projectId);
    if (!project || (settings.provider === "openai" && account?.type !== "chatgpt") || (settings.provider === "openrouter" && !openRouterReady)) return;
    scheduledRunningRef.current.add(scheduled.id);
    try {
      const sandbox = settings.permission === "read-only" ? "read-only" : settings.permission === "full" ? "danger-full-access" : "workspace-write";
      const approvalPolicy = settings.permission === "ask" ? "on-request" : "never";
      const started = await rpc<{ thread: Thread }>("thread/start", {
        cwd: project.path,
        runtimeWorkspaceRoots: [project.path],
        sandbox,
        approvalPolicy,
        baseInstructions: settings.systemPrompt,
        developerInstructions: "",
        model: settings.model || undefined,
        modelProvider: settings.provider === "openrouter" ? "openrouter" : undefined,
        serviceTier: settings.serviceTier,
        config: {
          project_doc_max_bytes: settings.projectInstructionsEnabled ? 32_768 : 0,
          developer_instructions: "",
          model_reasoning_effort: settings.ultra ? "ultra" : settings.reasoningEffort,
          agents: { max_threads: settings.subagentMax, max_depth: 1 },
          features: { multi_agent: settings.subagentsEnabled },
        },
      });
      bindThreadToProject(started.thread.id, project.path);
      useTaskStore.getState().ensureTask(started.thread.id, project.path);
      useTaskStore.getState().appendUserMessage(started.thread.id, { id: `scheduled-${crypto.randomUUID()}`, role: "user", text: scheduled.prompt });
      useTaskStore.getState().setTaskStatus(started.thread.id, "starting");
      await rpc("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: scheduled.prompt, text_elements: [] }],
        cwd: project.path,
        runtimeWorkspaceRoots: [project.path],
        sandboxPolicy: commandSandbox(settings.permission, project.path),
        model: settings.model || undefined,
        effort: settings.ultra ? "ultra" : settings.reasoningEffort,
        serviceTier: settings.serviceTier,
      });
      const next = scheduledTasks.map((item) => item.id === scheduled.id ? { ...item, lastRunAt: Date.now(), lastThreadId: started.thread.id, nextRunAt: Date.now() + item.intervalMinutes * 60_000 } : item);
      setScheduledTasks(next);
      storeValue("kiwi.scheduledTasks", next);
      void auditEvent("schedule.started", { scheduleId: scheduled.id, projectId: project.id }, started.thread.id).catch(() => {});
      if (activeProject?.id === project.id) void loadThreads(project);
    } catch (reason) {
      const next = scheduledTasks.map((item) => item.id === scheduled.id ? { ...item, nextRunAt: Date.now() + 5 * 60_000 } : item);
      setScheduledTasks(next);
      storeValue("kiwi.scheduledTasks", next);
      void auditEvent("schedule.failed", { scheduleId: scheduled.id, error: String(reason) }).catch(() => {});
    } finally {
      scheduledRunningRef.current.delete(scheduled.id);
    }
  }, [account?.type, activeProject?.id, bindThreadToProject, loadThreads, openRouterReady, projects, runtimeStatus?.available, scheduledTasks, settings]);

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      for (const scheduled of scheduledTasks) {
        if (scheduled.enabled && scheduled.nextRunAt <= now) void runScheduledTask(scheduled);
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [runScheduledTask, scheduledTasks]);

  return (
    <div className="app-shell" data-theme={settings.theme}>
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="sidebar-brand">
          <div className="brand-mark"><img src="/openkiwi-logo.png" alt="" /></div>
          <span>OpenKiwi</span>
          <button className="icon-button subtle collapse-button" onClick={() => setSidebarOpen(false)} title="Hide sidebar" aria-label="Hide sidebar">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className={`new-thread-button contextual ${workspaceMode}`} onClick={newThread} disabled={!activeWorkspace}>
          <Plus size={16} />
          <span className="new-thread-copy">
            <strong>{workspaceMode === "chat" ? "New normal chat" : "New project thread"}</strong>
            <small>{workspaceMode === "chat" ? "No project folder" : activeProject?.name ?? "Select a project"}</small>
          </span>
        </button>

        <div className="sidebar-section chats-section">
          <div className="section-label-row">
            <span className="section-label">Chats</span>
          </div>
          <button
            className={`chat-scope-row ${workspaceMode === "chat" ? "active" : ""}`}
            onClick={() => {
              setWorkspaceMode("chat");
              storeValue("kiwi.workspaceMode", "chat");
            }}
          >
            <span className="chat-scope-icon"><MessageSquare size={15} /></span>
            <span><strong>Normal chats</strong><small>No project folder attached</small></span>
            {workspaceMode === "chat" && <Check size={14} />}
          </button>
        </div>

        <div className="sidebar-section projects-section">
          <div className="section-label-row">
            <span className="section-label">Projects</span>
            <button className="icon-button tiny" onClick={addProject} title="Add project" aria-label="Add project"><Plus size={14} /></button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <div key={project.id} className={`project-row-wrap ${workspaceMode === "project" && project.id === activeProjectId ? "active" : ""}`}>
                <button
                  className="project-row"
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setWorkspaceMode("project");
                    storeValue("kiwi.workspaceMode", "project");
                  }}
                  title={project.path}
                >
                  {project.pinned ? <Pin className="project-pin-mark" size={14} /> : <Folder size={15} />}
                  <span>{project.name}</span>
                </button>
                <div className="project-actions">
                  <button onClick={() => toggleProjectPin(project)} title={project.pinned ? "Unpin project" : "Pin project"} aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}>
                    {project.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button className="danger" onClick={() => removeProject(project)} title="Remove from OpenKiwi — files stay on your Mac" aria-label={`Remove ${project.name} from OpenKiwi`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
            {!projects.length && (
              <button className="empty-project-button" onClick={addProject}>
                <FolderOpen size={17} />
                Open a folder
              </button>
            )}
          </div>
        </div>

        <div className="sidebar-section threads-section">
          <div className="section-label-row">
            <span className="section-label">{workspaceMode === "chat" ? "Chat threads" : "Project threads"}</span>
            {activeWorkspace && <span className="thread-count">{threads.length}</span>}
          </div>
          {threads.length > 4 && <label className="thread-search"><Search size={11} /><input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="Filter threads…" /></label>}
          <div className={`thread-scope-hint ${workspaceMode}`}>
            {workspaceMode === "chat" ? <MessageSquare size={12} /> : <Folder size={12} />}
            <span>{workspaceMode === "chat" ? "Not tied to a project folder" : activeProject ? `Working in ${activeProject.name}` : "Select a project above"}</span>
          </div>
          <div className="thread-list">
            {displayedThreads.map((thread) => (
              <div key={thread.id} className={`thread-row-wrap ${activeThread?.id === thread.id ? "active" : ""}`}>
                {renamingThreadId === thread.id ? (
                  <div className="thread-rename-row">
                    <MessageSquare size={14} />
                    <input
                      autoFocus
                      value={threadNameDraft}
                      onChange={(event) => setThreadNameDraft(event.target.value)}
                      onBlur={() => setRenamingThreadId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void renameThread(thread);
                        if (event.key === "Escape") setRenamingThreadId(null);
                      }}
                      aria-label="Thread name"
                    />
                  </div>
                ) : (
                  <button className="thread-row" onClick={() => void selectThread(thread)}>
                    {pinnedThreadIds.includes(thread.id) ? <Pin size={13} /> : <MessageSquare size={14} />}
                    <span>{thread.name || thread.preview || "Untitled thread"}</span>
                    {(threadTasks[thread.id]?.status === "running" || threadTasks[thread.id]?.status === "starting") && <LoaderCircle className="spin thread-state" size={11} />}
                    {threadTasks[thread.id]?.unread && <i className="thread-unread" />}
                  </button>
                )}
                <div className="thread-actions">
                  <button onMouseDown={(event) => event.preventDefault()} onClick={() => toggleThreadPin(thread.id)} title={pinnedThreadIds.includes(thread.id) ? "Unpin thread" : "Pin thread"} aria-label={`${pinnedThreadIds.includes(thread.id) ? "Unpin" : "Pin"} ${thread.name || thread.preview || "thread"}`}><Pin size={12} /></button>
                  <button onMouseDown={(event) => event.preventDefault()} onClick={() => startThreadRename(thread)} title="Rename thread" aria-label={`Rename ${thread.name || thread.preview || "thread"}`}><Pencil size={12} /></button>
                  <button className="danger" onMouseDown={(event) => event.preventDefault()} onClick={() => void deleteThread(thread)} title="Delete thread" aria-label={`Delete ${thread.name || thread.preview || "thread"}`}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {activeWorkspace && !threads.length && <div className="empty-threads">{workspaceMode === "chat" ? "No normal chats yet" : "No threads in this project yet"}</div>}
          </div>
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
            <span>Settings</span>
            <span className={`provider-dot ${settings.provider}`} />
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button className="icon-button" onClick={() => setSidebarOpen(true)} title="Show sidebar" aria-label="Show sidebar">
                <PanelLeftOpen size={18} />
              </button>
            )}
            <div className="project-heading">
              <span>{activeWorkspace?.isChat ? "Normal chat" : activeProject?.name ?? "No project selected"}</span>
              <small>{activeThread ? activeThread.name || activeThread.preview || "New thread" : activeWorkspace?.isChat ? "No project folder" : activeProject?.path ?? "Choose a project or use Chats"}</small>
            </div>
          </div>
          <div className="topbar-right">
            <button className="command-palette-trigger" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette"><Command size={13} /><span>Search</span><kbd>⌘K</kbd></button>
            <div className="runtime-status">
              {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
              <span>{status}</span>
            </div>
            <button className="provider-pill" onClick={() => setSettingsOpen(true)} aria-label={`Configure ${settings.provider === "openai" ? "OpenAI" : "OpenRouter"} provider`}>
              <span className={`provider-dot ${settings.provider}`} />
              {settings.provider === "openai" ? "OpenAI" : "OpenRouter"}
              {settings.model && <small>{settings.model}</small>}
            </button>
            <button className={`workspace-tools-trigger studio-toggle ${studioOpen ? "active" : ""}`} onClick={() => studioOpen ? setStudioOpen(false) : openStudio(studioTab)} title={activeProject ? "Open project workspace tools" : "Workspace tools are available inside projects"} aria-label={studioOpen ? "Close workspace tools" : "Open workspace tools"} aria-expanded={studioOpen} disabled={!activeProject}>
              <PanelRight size={17} />
              <span>Workspace</span>
            </button>
          </div>
        </header>

        {!activeWorkspace ? (
          <section className="welcome-screen">
            <div className="welcome-orbit"><Code2 size={34} /></div>
            <h1>Choose how you want to work.</h1>
            <p>Open a project for coding inside a folder, or use a normal chat with no project attached.</p>
            <div className="welcome-actions"><button className="primary-button large" onClick={addProject}><FolderOpen size={17} /> Open project</button><button className="secondary-button" onClick={() => { setWorkspaceMode("chat"); storeValue("kiwi.workspaceMode", "chat"); }}><MessageSquare size={16} /> Normal chat</button></div>
          </section>
        ) : (
          <>
            <section className="conversation">
              {!messages.length && !activities.length ? (
                <div className="thread-empty-state">
                  <div className={`empty-state-icon ${activeWorkspace.isChat ? "chat" : ""}`}>{activeWorkspace.isChat ? <MessageSquare size={27} /> : <Bot size={27} />}</div>
                  <h1>{activeWorkspace.isChat ? "Start a normal chat." : "What should we build?"}</h1>
                  <p>{activeWorkspace.isChat ? "This conversation is not attached to any project folder. Ask a question, brainstorm, or work without repository context." : `This thread works inside ${activeProject?.name}. Commands and file changes start in that project folder.`}</p>
                  <div className="trust-strip">
                    <span><Check size={13} /> No app-added system prompt</span>
                    <span><Check size={13} /> {activeWorkspace.isChat ? "No project folder" : "Local project access"}</span>
                    <span><Check size={13} /> Approval controls</span>
                  </div>
                  {!activeWorkspace.isChat && <div className="empty-state-actions" aria-label="Project workspace shortcuts"><button onClick={() => openStudio("files")}><FileCode2 size={14} /> Browse files</button><button onClick={() => openStudio("terminal")}><TerminalSquare size={14} /> Terminal</button><button onClick={() => openStudio("review")}><Search size={14} /> Review changes</button></div>}
                </div>
              ) : (
                <Suspense fallback={<div className="timeline-loading"><LoaderCircle className="spin" size={15} /> Loading conversation…</div>}>
                  <ChatTimeline
                    messages={messages}
                    activities={activities}
                    running={running}
                    thinkingLabel={activeWorkspace.isChat ? "Thinking in normal chat" : `Working in ${activeProject?.name}`}
                  />
                </Suspense>
              )}
            </section>

            <section className="composer-zone">
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button className="error-settings" onClick={() => setSettingsOpen(true)}>Check settings</button>
                  <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={14} /></button>
                </div>
              )}
              <div className="composer">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder={activeWorkspace.isChat ? "Ask anything — no project folder attached…" : `Ask OpenKiwi to work in ${activeProject?.name ?? "this project"}…`}
                  rows={1}
                />
                {settings.provider === "openai" && (
                  <ModelPowerControl
                    model={settings.model || "gpt-5.6-sol"}
                    effort={settings.reasoningEffort}
                    ultra={settings.ultra}
                    fast={settings.serviceTier === "priority"}
                    runtimeModels={runtimeModels}
                    onModel={(model) => persistSettings({ ...settings, model })}
                    onEffort={(reasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })}
                    onUltra={(ultra) => persistSettings({ ...settings, ultra, subagentsEnabled: ultra ? true : settings.subagentsEnabled })}
                    onFast={(fast) => persistSettings({ ...settings, serviceTier: fast ? "priority" : null })}
                  />
                )}
                {settings.provider === "openrouter" && (
                  <OpenRouterModelControl
                    model={settings.model}
                    effort={settings.reasoningEffort}
                    models={openRouterModels}
                    loading={openRouterModelsLoading}
                    error={openRouterModelsError}
                    onModel={(model) => persistSettings({ ...settings, model, ultra: false })}
                    onEffort={(reasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })}
                    onRefresh={() => void refreshOpenRouterModels()}
                  />
                )}
                <div className="composer-toolbar">
                  <div className="composer-controls">
                    <div className="permission-control">
                      <button className="toolbar-button" onClick={() => setPermissionOpen((open) => !open)}>
                        <PermissionIcon mode={settings.permission} />
                        {permissionLabel(settings.permission)}
                        <ChevronDown size={13} />
                      </button>
                      {permissionOpen && (
                        <div className="permission-menu">
                          {(["read-only", "ask", "full"] as PermissionMode[]).map((mode) => (
                            <button
                              key={mode}
                              className={settings.permission === mode ? "selected" : ""}
                              onClick={() => {
                                persistSettings({ ...settings, permission: mode });
                                setPermissionOpen(false);
                              }}
                            >
                              <PermissionIcon mode={mode} size={17} />
                              <span>
                                <strong>{permissionLabel(mode)}</strong>
                                <small>{mode === "read-only" ? "Inspect without changing files" : mode === "ask" ? "Work locally; ask for elevated actions" : "Unrestricted local access"}</small>
                              </span>
                              {settings.permission === mode && <Check size={15} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="toolbar-button prompt-button" onClick={() => setSettingsOpen(true)} title="Edit instruction prompt">
                      <Command size={14} />
                      Prompt: {settings.systemPrompt ? "custom" : "empty"}
                    </button>
                    <button
                      className={`toolbar-button agents-button ${settings.subagentsEnabled ? "enabled" : ""}`}
                      onClick={() => persistSettings({ ...settings, subagentsEnabled: !settings.subagentsEnabled })}
                      disabled={Boolean(activeThread)}
                      title={activeThread ? "Sub-agent access is fixed when a thread starts" : "Allow the model to spawn direct sub-agents for this thread"}
                    >
                      <UsersRound size={14} />
                      {settings.subagentsEnabled ? `Agents: ${settings.subagentMax}` : "Agents off"}
                    </button>
                    <button className={`toolbar-button ${attachments.length ? "has-attachments" : ""}`} onClick={() => void addAttachment()} title="Attach context">
                      <Paperclip size={14} />
                      {attachments.length ? attachments.length : "Attach"}
                    </button>
                  </div>
                  {running && (
                    <button className="stop-button" onClick={() => void stopTurn()} title="Stop the active task">
                      <CircleStop size={17} />
                    </button>
                  )}
                  <button className="send-button" onClick={() => void sendMessage()} disabled={!draft.trim()} title={running ? "Add direction to the active task" : "Send"}>
                    {running ? <ArrowUp size={17} /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
              <div className="composer-caption">OpenKiwi can make mistakes. Review commands and changes before shipping.</div>
            </section>
          </>
        )}
      </main>

      <Suspense fallback={null}><StudioDock
        open={studioOpen && Boolean(activeProject)}
        tab={studioTab}
        projectName={activeProject?.name}
        projectPath={activeProject?.path}
        activeThread={Boolean(activeThread)}
        diff={diff}
        approvedDiff={approvedDiff}
        agents={agentRecords}
        terminalOutput={terminalOutput}
        terminalCommand={terminalCommand}
        terminalRunning={terminalRunning}
        checkpoints={checkpoints.filter((item) => !activeThread || item.threadId === activeThread.id)}
        attachments={attachments}
        usage={tokenUsage}
        rateSummary={rateSummary}
        skills={skills}
        mcpServers={mcpServers}
        gitOutput={gitOutput}
        gitCommitMessage={gitCommitMessage}
        promptAudit={[
          { label: "Base instruction", value: settings.systemPrompt ? `custom · ${settings.systemPrompt.length} chars` : "empty" },
          { label: "Developer instruction", value: "empty" },
          { label: "Project instructions", value: settings.projectInstructionsEnabled ? "enabled · AGENTS.md up to 32 KB" : "disabled" },
          { label: "Model", value: settings.model || "provider default" },
          { label: "Reasoning", value: settings.ultra ? "ultra" : settings.reasoningEffort },
          { label: "Sub-agents", value: settings.subagentsEnabled ? `on · max ${settings.subagentMax}` : "off" },
          { label: "Permissions", value: permissionLabel(settings.permission) },
          { label: "Service tier", value: settings.serviceTier || "standard" },
        ]}
        projectActions={projectActions}
        onTab={setStudioTab}
        onClose={() => setStudioOpen(false)}
        onRefreshDiff={() => void refreshDiff()}
        onReview={() => void startReview()}
        onApproveDiff={() => setApprovedDiff((approved) => !approved)}
        onOpenAgent={(id) => void openAgent(id)}
        onStopAgent={(id) => void stopAgent(id)}
        onTerminalCommand={setTerminalCommand}
        onRunTerminal={() => void runTerminal()}
        onStopTerminal={() => void stopTerminal()}
        onTerminalInput={writeTerminal}
        onTerminalResize={resizeTerminal}
        onCheckpoint={createCheckpoint}
        onFork={(checkpoint) => void forkThread(checkpoint)}
        onRollback={() => void rollbackTurn()}
        onWorktree={() => void createWorktree()}
        onAddAttachment={() => void addAttachment()}
        onRemoveAttachment={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
        onRefreshUsage={() => void refreshUsage()}
        onRefreshTools={() => void refreshTools(activeProject)}
        onGitAction={(action) => void runGitAction(action)}
        onGitCommitMessage={setGitCommitMessage}
        onGitPathAction={(action, path) => void runGitPathAction(action, path)}
        onAttachPath={(path) => setAttachments((current) => current.some((item) => item.path === path) ? current : [...current, { path, name: basename(path), kind: "file" }])}
        onProjectAction={(action) => void runProjectAction(action)}
        onToggleSkill={(skill) => void toggleSkill(skill)}
        onConnectMcp={(server) => void connectMcp(server)}
      /></Suspense>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        account={account}
        runtimeStatus={runtimeStatus}
        openRouterReady={openRouterReady}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          persistSettings(next);
          setSettingsOpen(false);
        }}
        onAccountChange={async () => { await refreshAccount(); await refreshModels(); }}
        onSignIn={beginChatGptLogin}
        onRuntimeRequired={() => setRuntimeSetupOpen(true)}
        onWorkspaceTools={() => { setSettingsOpen(false); openStudio("tools"); }}
        onOpenRouterChange={setOpenRouterReady}
        onError={setError}
        profiles={promptProfiles}
        agents={customAgents}
        actions={projectActions}
        schedules={scheduledTasks}
        projects={projects}
        workspaceToolsAvailable={Boolean(activeProject)}
        onProfiles={(value) => { setPromptProfiles(value); storeValue("kiwi.promptProfiles", value); }}
        onAgents={(value) => { setCustomAgents(value); storeValue("kiwi.customAgents", value); }}
        onActions={(value) => { setProjectActions(value); storeValue("kiwi.projectActions", value); }}
        onSchedules={(value) => { setScheduledTasks(value); storeValue("kiwi.scheduledTasks", value); }}
      />

      <RuntimeSetupModal
        open={runtimeSetupOpen}
        checking={runtimeChecking}
        onClose={() => setRuntimeSetupOpen(false)}
        onRetry={() => void retryRuntime()}
      />

      <AuthRequiredModal
        open={authRequiredOpen}
        busy={loginStarting}
        onClose={() => setAuthRequiredOpen(false)}
        onSignIn={() => void beginChatGptLogin()}
      />

      {pendingApproval && (
        <ApprovalCenter approval={pendingApproval} onRespond={(result) => void answerApproval(result)} />
      )}
      <CommandPalette
        open={commandPaletteOpen}
        projects={projects}
        threads={threads}
        projectActive={Boolean(activeProject)}
        onClose={() => setCommandPaletteOpen(false)}
        onProject={(project) => { setActiveProjectId(project.id); setWorkspaceMode("project"); storeValue("kiwi.workspaceMode", "project"); }}
        onThread={(thread) => void selectThread(thread)}
        onNewThread={newThread}
        onSettings={() => setSettingsOpen(true)}
        onTool={openStudio}
      />
    </div>
  );
}

function RuntimeSetupModal({
  open,
  checking,
  onClose,
  onRetry,
}: {
  open: boolean;
  checking: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div className={`modal-backdrop runtime-setup-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="runtime-setup-modal" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label="Close Codex setup"><X size={17} /></button>
        <div className="runtime-setup-mark"><TerminalSquare size={25} /></div>
        <div className="runtime-setup-copy">
          <span className="runtime-eyebrow">One-time setup</span>
          <h2 id="runtime-setup-title">Connect the Codex runtime</h2>
          <p>OpenKiwi uses Codex App Server locally for ChatGPT subscription sign-in, OpenRouter, tools, approvals, and threads. Install either option below—never both.</p>
        </div>
        <div className="runtime-options">
          <div className="runtime-option recommended">
            <span className="runtime-option-icon"><Download size={17} /></span>
            <div><strong>Codex CLI <em>Recommended</em></strong><small>The dependable cross-platform option and easiest runtime to keep current.</small></div>
          </div>
          <div className="runtime-option">
            <span className="runtime-option-icon chatgpt"><Sparkles size={17} /></span>
            <div><strong>ChatGPT for macOS</strong><small>Already includes a usable Codex runtime. OpenKiwi detects it automatically.</small></div>
          </div>
        </div>
        <div className="runtime-note"><Check size={13} /> Your ChatGPT login still happens in the official browser flow and remains isolated to OpenKiwi.</div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="secondary-button" onClick={() => void openUrl("https://learn.chatgpt.com/docs/codex/cli")}><ExternalLink size={13} /> Installation guide</button>
          <button className="primary-button" onClick={onRetry} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={13} />} Try again</button>
        </div>
      </div>
    </div>
  );
}

function AuthRequiredModal({
  open,
  busy,
  onClose,
  onSignIn,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSignIn: () => void;
}) {
  return (
    <div className={`modal-backdrop runtime-setup-backdrop auth-required-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="runtime-setup-modal auth-required-modal" role="dialog" aria-modal="true" aria-labelledby="auth-required-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label="Close sign-in prompt"><X size={17} /></button>
        <div className="runtime-setup-mark auth-mark"><KeyRound size={24} /></div>
        <div className="runtime-setup-copy">
          <span className="runtime-eyebrow">ChatGPT authentication</span>
          <h2 id="auth-required-title">Sign in before sending</h2>
          <p>OpenAI models cannot receive this prompt until a ChatGPT account is connected. Your draft is still waiting in the composer and has not been sent.</p>
        </div>
        <div className="auth-required-detail">
          <ShieldCheck size={17} />
          <div><strong>Official browser sign-in</strong><small>Codex opens ChatGPT in your default browser and stores the resulting session inside OpenKiwi’s isolated credential store.</small></div>
        </div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="primary-button" onClick={onSignIn} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={13} />} Sign in with ChatGPT</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  open,
  settings,
  account,
  runtimeStatus,
  openRouterReady,
  onClose,
  onSave,
  onAccountChange,
  onSignIn,
  onRuntimeRequired,
  onWorkspaceTools,
  onOpenRouterChange,
  onError,
  profiles,
  agents,
  actions,
  schedules,
  projects,
  workspaceToolsAvailable,
  onProfiles,
  onAgents,
  onActions,
  onSchedules,
}: {
  open: boolean;
  settings: AppSettings;
  account: Account | null;
  runtimeStatus: CodexRuntimeStatus | null;
  openRouterReady: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onAccountChange: () => Promise<void>;
  onSignIn: () => Promise<void>;
  onRuntimeRequired: () => void;
  onWorkspaceTools: () => void;
  onOpenRouterChange: (ready: boolean) => void;
  onError: (error: string | null) => void;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  projects: Project[];
  workspaceToolsAvailable: boolean;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
}) {
  const [local, setLocal] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "models" | "prompts" | "agents" | "workflows" | "tools">("general");

  useEffect(() => {
    if (open) setLocal(settings);
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const signIn = async () => {
    if (!runtimeStatus?.available) {
      onRuntimeRequired();
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await onSignIn();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await rpc("account/logout");
      await onAccountChange();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const storeKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await saveOpenRouterKey(apiKey);
      setApiKey("");
      onOpenRouterChange(true);
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportDiagnosticBundle = async () => {
    try {
      const path = await save({ title: "Export OpenKiwi diagnostics", defaultPath: `openkiwi-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) await exportDiagnostics(path);
    } catch (reason) { onError(friendlyError(reason)); }
  };

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><h2 id="settings-title">Settings</h2><p>Customize OpenKiwi without hidden configuration.</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {([
              ["general", "General", Palette],
              ["models", "Models & accounts", KeyRound],
              ["prompts", "Prompts", Sparkles],
              ["agents", "Agents", UsersRound],
              ["workflows", "Workflows", Play],
              ["tools", "Tools & MCP", Wrench],
            ] as const).map(([id, label, Icon]) => <button key={id} className={settingsSection === id ? "active" : ""} onClick={() => setSettingsSection(id)} aria-current={settingsSection === id ? "page" : undefined}><Icon size={14} /><span>{label}</span><ChevronRight size={12} /></button>)}
          </nav>
          <div className="settings-content">
          <div className="settings-pane-heading"><span>{settingsSection === "general" ? "General" : settingsSection === "models" ? "Models & accounts" : settingsSection === "prompts" ? "Prompts" : settingsSection === "agents" ? "Agents" : settingsSection === "workflows" ? "Workflows" : "Tools & MCP"}</span><small>{settingsSection === "general" ? "Appearance, runtime behavior, and diagnostics" : settingsSection === "models" ? "Providers, credentials, and model routing" : settingsSection === "prompts" ? "Your complete harness instruction and reusable profiles" : settingsSection === "agents" ? "Delegation limits and specialist configurations" : settingsSection === "workflows" ? "Reusable project actions and scheduled tasks" : "Skills and Model Context Protocol servers"}</small></div>
          {settingsSection === "general" &&
          <section className="settings-section theme-settings-section">
            <div className="settings-section-heading settings-heading-with-action">
              <div className="settings-icon"><Palette size={17} /></div>
              <div><h3>Appearance</h3><p>Choose a color atmosphere for OpenKiwi. Your selection is stored on this device.</p></div>
              <button type="button" className="default-theme-button" onClick={() => setLocal({ ...local, theme: DEFAULT_SETTINGS.theme })} disabled={local.theme === DEFAULT_SETTINGS.theme}>
                <RotateCcw size={12} /> App default
              </button>
            </div>
            <div className="theme-grid">
              {THEMES.map((theme) => (
                <button
                  type="button"
                  key={theme.id}
                  className={`theme-card ${local.theme === theme.id ? "selected" : ""}`}
                  aria-pressed={local.theme === theme.id}
                  onClick={() => setLocal({ ...local, theme: theme.id })}
                >
                  <span className="theme-preview" style={{ background: theme.swatches[0] }}>
                    <i style={{ background: theme.swatches[1] }} />
                    <i style={{ background: theme.swatches[2] }} />
                  </span>
                  <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  {local.theme === theme.id && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>}

          {settingsSection === "prompts" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><Sparkles size={17} /></div>
              <div><h3>Instruction prompt</h3><p>Sent as the thread’s complete base instruction. Empty means OpenKiwi supplies no base prompt.</p></div>
            </div>
            <textarea
              className="prompt-editor"
              value={local.systemPrompt}
              onChange={(event) => setLocal({ ...local, systemPrompt: event.target.value })}
              placeholder="Empty — add your own instructions here"
              rows={7}
            />
            <div className="prompt-audit-row">
              <span><Check size={13} /> Base prompt visible</span>
              <span><Check size={13} /> Developer prompt empty</span>
              <span><Check size={13} /> Project instructions {local.projectInstructionsEnabled ? "enabled" : "disabled"}</span>
            </div>
          </section>}

          {(["prompts", "agents", "workflows", "tools"] as const).includes(settingsSection as "prompts" | "agents" | "workflows" | "tools") && <HarnessSettings
            section={settingsSection as "prompts" | "agents" | "workflows" | "tools"}
            settings={local}
            profiles={profiles}
            agents={agents}
            actions={actions}
            schedules={schedules}
            projects={projects}
            onSettings={setLocal}
            onProfiles={onProfiles}
            onAgents={onAgents}
            onActions={onActions}
            onSchedules={onSchedules}
          />}

          {settingsSection === "tools" && <div className="settings-workspace-link"><div><strong>Live tool controls</strong><small>{workspaceToolsAvailable ? "Inspect skills, connect configured MCP servers, and run project actions in the active workspace." : "Select a project to inspect live skills, MCP servers, and project actions."}</small></div><button className="secondary-button" onClick={onWorkspaceTools} disabled={!workspaceToolsAvailable}><PanelRight size={13} /> Open workspace tools</button></div>}

          {settingsSection === "general" &&
          <section className="settings-section">
            <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>Runtime behavior</h3><p>Control project guidance, background alerts, service tier, and terminal memory.</p></div></div>
            <div className="behavior-grid">
              <div><span><strong>Project instructions</strong><small>Allow AGENTS.md discovery for project threads (up to 32 KB).</small></span><button type="button" role="switch" aria-checked={local.projectInstructionsEnabled} className={`toggle-switch ${local.projectInstructionsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, projectInstructionsEnabled: !local.projectInstructionsEnabled })}><span /></button></div>
              <div><span><strong>Desktop notifications</strong><small>Notify when a background task finishes.</small></span><button type="button" role="switch" aria-checked={local.notificationsEnabled} className={`toggle-switch ${local.notificationsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, notificationsEnabled: !local.notificationsEnabled })}><span /></button></div>
            </div>
            <div className="runtime-field-grid"><label><span>OpenAI service tier</span><select value={local.serviceTier ?? ""} onChange={(event) => setLocal({ ...local, serviceTier: event.target.value || null })}><option value="">Standard</option><option value="priority">Fast / priority</option></select></label><label><span>Terminal scrollback</span><select value={local.terminalScrollback} onChange={(event) => setLocal({ ...local, terminalScrollback: Number(event.target.value) })}><option value={25000}>25k characters</option><option value={100000}>100k characters</option><option value={500000}>500k characters</option></select></label></div>
            <div className="diagnostic-card"><span><strong>Diagnostics</strong><small>{runtimeStatus?.version ?? "Runtime version unavailable"}{runtimeStatus?.warning ? ` · ${runtimeStatus.warning}` : runtimeStatus?.compatible ? " · compatible" : ""}</small></span><button className="secondary-button" onClick={() => void exportDiagnosticBundle()}>Export JSON</button></div>
          </section>}

          {settingsSection === "agents" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><UsersRound size={17} /></div>
              <div><h3>Sub-agents</h3><p>Let the model delegate parallel work to direct child agents. Applies when a new thread starts.</p></div>
            </div>
            <div className={`agent-settings-card ${local.subagentsEnabled ? "enabled" : ""}`}>
              <div className="agent-toggle-copy">
                <strong>Allow sub-agent spawning</strong>
                <small>{local.subagentsEnabled ? "The model may delegate when it decides that parallel work helps." : "No sub-agent tools are exposed to the model."}</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={local.subagentsEnabled}
                className={`toggle-switch ${local.subagentsEnabled ? "on" : ""}`}
                onClick={() => setLocal({ ...local, subagentsEnabled: !local.subagentsEnabled })}
              >
                <span />
              </button>
            </div>
            <div className={`agent-limit-row ${local.subagentsEnabled ? "" : "disabled"}`}>
              <div><strong>Maximum concurrent sub-agents</strong><small>Choose 1–24 active at once per thread, excluding the root agent.</small></div>
              <div className="number-stepper" aria-label="Maximum concurrent sub-agents">
                <button type="button" onClick={() => setLocal({ ...local, subagentMax: Math.max(1, local.subagentMax - 1) })} disabled={!local.subagentsEnabled || local.subagentMax <= 1}><Minus size={13} /></button>
                <strong>{local.subagentMax}</strong>
                <button type="button" onClick={() => setLocal({ ...local, subagentMax: Math.min(24, local.subagentMax + 1) })} disabled={!local.subagentsEnabled || local.subagentMax >= 24}><Plus size={13} /></button>
              </div>
            </div>
            <div className="agent-safety-row">
              <span><ShieldCheck size={13} /> Inherits permissions</span>
              <span><Check size={13} /> Direct children only</span>
              <span><Check size={13} /> Off by default</span>
            </div>
          </section>}

          {settingsSection === "models" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><KeyRound size={17} /></div>
              <div><h3>Model provider</h3><p>Credentials stay in the OS credential store or Codex’s isolated login store.</p></div>
            </div>
            <div className="provider-cards">
              <button className={`provider-card ${local.provider === "openai" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openai", model: local.model.includes("/") ? "gpt-5.6-sol" : (local.model || "gpt-5.6-sol"), ultra: false })}>
                <span className="provider-logo openai"><Sparkles size={17} /></span>
                <span><strong>OpenAI</strong><small>Official ChatGPT subscription sign-in</small></span>
                {local.provider === "openai" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "openrouter" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openrouter", model: local.model.includes("/") ? local.model : "", ultra: false })}>
                <span className="provider-logo openrouter"><RotateCcw size={17} /></span>
                <span><strong>OpenRouter</strong><small>Responses-compatible model routing</small></span>
                {local.provider === "openrouter" && <Check size={16} />}
              </button>
            </div>

            {local.provider === "openai" ? (
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : "ChatGPT subscription"}</strong>
                  <small>{account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan connected` : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI or ChatGPT for macOS required"}</small>
                </div>
                {account?.type === "chatgpt" ? (
                  <button className="secondary-button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
                ) : (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : !runtimeStatus?.available ? <Download size={14} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex"}
                  </button>
                )}
              </div>
            ) : (
              <div className="credential-panel stacked">
                <div className="credential-status">
                  <div><strong>OpenRouter API key</strong><small>{openRouterReady ? "Stored securely on this device" : "No key stored"}</small></div>
                  {openRouterReady && <span className="connected-badge"><Check size={12} /> Connected</span>}
                </div>
                <div className="key-input-row">
                  <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  <button className="secondary-button" onClick={() => void storeKey()} disabled={!apiKey.trim() || busy}>Save key</button>
                </div>
              </div>
            )}

            <label className="field-label">
              <span>Model</span>
              <input
                value={local.model}
                onChange={(event) => setLocal({ ...local, model: event.target.value })}
                readOnly={local.provider === "openai"}
                placeholder={local.provider === "openrouter" ? "e.g. anthropic/claude-sonnet-4" : "Select Sol, Terra, or Luna below the composer"}
              />
              <small>{local.provider === "openrouter" ? "Use the searchable picker beneath the composer, or enter any valid provider/model slug here." : "Use the animated selector beneath the composer. Availability follows the signed-in ChatGPT account."}</small>
            </label>
          </section>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" onClick={() => onSave({ ...local, subagentMax: Math.min(24, Math.max(1, local.subagentMax)) })}>Save settings</button>
        </div>
      </div>
    </div>
  );
}
