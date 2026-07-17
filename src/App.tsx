import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Circle,
  Code2,
  Command,
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
  Pencil,
  RotateCcw,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  hasOpenRouterKey,
  listOpenRouterModels,
  onCodexEvent,
  respond,
  rpc,
  saveOpenRouterKey,
  type CodexEvent,
  type JsonObject,
} from "./lib/codex";
import { loadStored, storeValue } from "./lib/storage";
import {
  ModelPowerControl,
  type ReasoningEffort,
  type RuntimeModel,
} from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import {
  StudioDock,
  type AgentRecord,
  type AttachmentRecord,
  type CheckpointRecord,
  type McpView,
  type SkillView,
  type StudioTab,
  type TokenUsageView,
} from "./components/StudioDock";

type Provider = "openai" | "openrouter";
type PermissionMode = "read-only" | "ask" | "full";
type ThemeName = "kiwi" | "midnight" | "ember" | "violet";

interface Project {
  id: string;
  name: string;
  path: string;
  pinned?: boolean;
}

interface Thread {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  modelProvider: string;
  turns?: Turn[];
}

interface Turn {
  id: string;
  items: ThreadItem[];
}

interface ThreadItem {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  summary?: string[];
  tool?: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
  prompt?: string | null;
  receiverThreadIds?: string[];
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

interface Activity {
  id: string;
  kind: "command" | "file" | "reasoning" | "agent";
  title: string;
  detail?: string;
  status?: string;
}

interface Account {
  type?: string;
  email?: string | null;
  planType?: string | null;
}

interface PendingApproval {
  id: number | string;
  method: string;
  params: JsonObject;
}

interface AppSettings {
  provider: Provider;
  model: string;
  permission: PermissionMode;
  systemPrompt: string;
  subagentsEnabled: boolean;
  subagentMax: number;
  reasoningEffort: ReasoningEffort;
  ultra: boolean;
  theme: ThemeName;
}

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
  subagentsEnabled: false,
  subagentMax: 3,
  reasoningEffort: "medium",
  ultra: false,
  theme: "kiwi",
};

const initialProjects = loadStored<Project[]>("kiwi.projects", []).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
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
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [draft, setDraft] = useState("");
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadNameDraft, setThreadNameDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [openRouterReady, setOpenRouterReady] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<StudioTab>("review");
  const [diff, setDiff] = useState("");
  const [approvedDiff, setApprovedDiff] = useState(false);
  const [agentRecords, setAgentRecords] = useState<AgentRecord[]>([]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalProcessId, setTerminalProcessId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>(() => loadStored("kiwi.checkpoints", []));
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageView | null>(null);
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
  const endRef = useRef<HTMLDivElement>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    storeValue("kiwi.settings", next);
  }, []);

  const loadThreads = useCallback(async (project: Project | null) => {
    if (!project) {
      setThreads([]);
      return;
    }
    try {
      const result = await rpc<{ data: Thread[] }>("thread/list", { cwd: project.path, limit: 100 });
      setThreads(result.data ?? []);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    try {
      const result = await rpc<{ account: Account | null }>("account/read", { refreshToken: false });
      setAccount(result.account);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const result = await rpc<{ data: RuntimeModel[] }>("model/list", { limit: 100, includeHidden: false });
      setRuntimeModels(result.data ?? []);
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
      setOpenRouterModelsError(String(reason));
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
      setSkills((skillResult.value.data ?? []).flatMap((entry) => entry.skills ?? []).filter((skill) => skill.enabled !== false).map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })));
    }
    if (mcpResult.status === "fulfilled") {
      setMcpServers((mcpResult.value.data ?? []).map((server) => ({ name: server.name, status: server.authStatus || "ready", tools: Object.keys(server.tools ?? {}).length })));
    }
  }, []);

  const executeCommand = useCallback(async (command: string[], cwd: string) => {
    return rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", { command, cwd, timeoutMs: 120000, sandboxPolicy: commandSandbox(settings.permission, cwd) });
  }, [settings.permission]);

  const refreshDiff = useCallback(async () => {
    if (!activeProject) return;
    setApprovedDiff(false);
    try {
      const result = await rpc<{ diff: string }>("gitDiffToRemote", { cwd: activeProject.path });
      setDiff(result.diff ?? "");
    } catch {
      try {
        const result = await executeCommand(["git", "diff", "--no-ext-diff", "--"], activeProject.path);
        setDiff(`${result.stdout}${result.stderr}`);
      } catch (reason) {
        setError(String(reason));
      }
    }
  }, [activeProject, executeCommand]);

  const upsertAssistantDelta = useCallback((itemId: string, delta: string) => {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === itemId);
      if (index === -1) {
        return [...current, { id: itemId, role: "assistant", text: delta, streaming: true }];
      }
      return current.map((message, messageIndex) =>
        messageIndex === index ? { ...message, text: message.text + delta, streaming: true } : message,
      );
    });
  }, []);

  const handleItem = useCallback((item: ThreadItem) => {
    const id = item.id ?? crypto.randomUUID();
    if (item.type === "agentMessage" || item.type === "plan") {
      setMessages((current) => {
        const exists = current.some((message) => message.id === id);
        const next = { id, role: "assistant" as const, text: item.text ?? "", streaming: false };
        return exists ? current.map((message) => (message.id === id ? next : message)) : [...current, next];
      });
      return;
    }
    if (item.type === "commandExecution") {
      setActivities((current) => {
        const activity: Activity = {
          id,
          kind: "command",
          title: item.command ?? "Run command",
          detail: item.aggregatedOutput ?? item.cwd,
          status: item.status,
        };
        return current.some((entry) => entry.id === id)
          ? current.map((entry) => (entry.id === id ? activity : entry))
          : [...current, activity];
      });
      return;
    }
    if (item.type === "fileChange") {
      setActivities((current) => {
        const activity: Activity = {
          id,
          kind: "file",
          title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`,
          status: item.status,
        };
        return current.some((entry) => entry.id === id)
          ? current.map((entry) => (entry.id === id ? activity : entry))
          : [...current, activity];
      });
      return;
    }
    if (item.type === "reasoning" && item.summary?.length) {
      setActivities((current) => [
        ...current.filter((entry) => entry.id !== id),
        { id, kind: "reasoning", title: item.summary?.join(" ") ?? "Thinking" },
      ]);
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
      setActivities((current) => {
        const activity: Activity = {
          id,
          kind: "agent",
          title: titles[item.tool ?? ""] ?? "Sub-agent activity",
          detail: item.prompt ?? undefined,
          status: item.status,
        };
        return current.some((entry) => entry.id === id)
          ? current.map((entry) => (entry.id === id ? activity : entry))
          : [...current, activity];
      });
      if (item.receiverThreadIds?.length) {
        setAgentRecords((current) => item.receiverThreadIds!.reduce((next, threadId) => {
          const record: AgentRecord = { id: threadId, prompt: item.prompt ?? "Delegated task", status: item.status ?? "inProgress" };
          return next.some((entry) => entry.id === threadId) ? next.map((entry) => entry.id === threadId ? { ...entry, ...record } : entry) : [...next, record];
        }, current));
      }
      return;
    }
    if (item.type === "subAgentActivity") {
      const action = item.kind === "started" ? "started" : item.kind === "interrupted" ? "interrupted" : "working";
      setActivities((current) => [
        ...current.filter((entry) => entry.id !== id),
        {
          id,
          kind: "agent",
          title: `Sub-agent ${action}`,
          detail: item.agentPath || item.agentThreadId,
          status: item.kind,
        },
      ]);
      if (item.agentThreadId) {
        setAgentRecords((current) => {
          const record: AgentRecord = { id: item.agentThreadId!, prompt: "Delegated task", status: item.kind ?? "working", path: item.agentPath };
          return current.some((entry) => entry.id === item.agentThreadId) ? current.map((entry) => entry.id === item.agentThreadId ? { ...entry, ...record, prompt: entry.prompt } : entry) : [...current, record];
        });
      }
    }
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void onCodexEvent((event: CodexEvent) => {
      if (event.stream === "stderr") {
        if (event.line?.toLowerCase().includes("error")) setStatus(event.line);
        return;
      }

      const method = event.method ?? "";
      const params = event.params ?? {};
      if (event.id !== undefined && (method.includes("requestApproval") || method.endsWith("Approval"))) {
        setPendingApproval({ id: event.id, method, params });
        return;
      }
      if (method === "item/agentMessage/delta") {
        upsertAssistantDelta(String(params.itemId), String(params.delta ?? ""));
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        if (params.item && typeof params.item === "object") handleItem(params.item as ThreadItem);
        return;
      }
      if (method === "turn/diff/updated") {
        setDiff(String(params.diff ?? ""));
        setApprovedDiff(false);
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = params.tokenUsage as { total?: Partial<TokenUsageView>; modelContextWindow?: number | null } | undefined;
        if (usage?.total) {
          setTokenUsage({
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
        setTerminalOutput((current) => current + decodeBase64Utf8(params.deltaBase64));
        return;
      }
      if (method === "account/rateLimits/updated") {
        const limits = params.rateLimits as { primary?: { usedPercent?: number } } | undefined;
        if (limits?.primary) setRateSummary(`${Math.round(limits.primary.usedPercent ?? 0)}% used`);
        return;
      }
      if (method === "turn/started") {
        setRunning(true);
        setStatus("Working");
        return;
      }
      if (method === "turn/completed") {
        if (params.turn && typeof params.turn === "object") {
          const completedTurn = params.turn as unknown as Turn;
          setActiveThread((current) => current && current.id === String(params.threadId) ? { ...current, turns: [...(current.turns ?? []).filter((turn) => turn.id !== completedTurn.id), completedTurn] } : current);
        }
        setRunning(false);
        setStatus("Ready");
        void refreshDiff();
        return;
      }
      if (method === "account/updated") {
        void refreshAccount();
        return;
      }
      if (method === "account/login/completed" && params.success === false) {
        setError(String(params.error ?? "Sign in did not complete"));
      }
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [handleItem, refreshAccount, refreshDiff, upsertAssistantDelta]);

  useEffect(() => {
    void refreshAccount();
    void refreshModels();
    void refreshOpenRouterModels();
    void refreshUsage();
    void hasOpenRouterKey().then(setOpenRouterReady).catch(() => setOpenRouterReady(false));
  }, [refreshAccount, refreshModels, refreshOpenRouterModels, refreshUsage]);

  useEffect(() => {
    void loadThreads(activeProject);
    setActiveThread(null);
    setMessages([]);
    setActivities([]);
    setAttachments([]);
    setAgentRecords([]);
    setTokenUsage(null);
    setDiff("");
    setApprovedDiff(false);
    void refreshTools(activeProject);
  }, [activeProject, loadThreads, refreshTools]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activities, messages, running]);

  const addProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (!selected || Array.isArray(selected)) return;
    const existing = projects.find((project) => project.path === selected);
    if (existing) {
      setActiveProjectId(existing.id);
      return;
    }
    const project: Project = { id: crypto.randomUUID(), name: basename(selected), path: selected };
    const next = [...projects, project];
    setProjects(next);
    setActiveProjectId(project.id);
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
    if (activeProjectId === project.id) setActiveProjectId(next[0]?.id ?? null);
  };

  const selectThread = async (thread: Thread) => {
    setError(null);
    setStatus("Loading thread");
    try {
      const result = await rpc<{ thread: Thread }>("thread/resume", {
        threadId: thread.id,
        cwd: activeProject?.path,
      });
      setActiveThread(result.thread);
      setMessages(messagesFromTurns(result.thread.turns));
      setActivities([]);
      setStatus("Ready");
    } catch (reason) {
      setError(String(reason));
      setStatus("Ready");
    }
  };

  const newThread = () => {
    setActiveThread(null);
    setMessages([]);
    setActivities([]);
    setAgentRecords([]);
    setTokenUsage(null);
    setDiff("");
    setDraft("");
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || !activeProject || running) return;
    if (settings.provider === "openrouter" && !openRouterReady) {
      setSettingsOpen(true);
      setError("Add an OpenRouter API key before using OpenRouter.");
      return;
    }
    if (settings.provider === "openrouter" && !settings.model.trim()) {
      setError("Choose an OpenRouter model before starting this thread.");
      return;
    }

    setDraft("");
    setError(null);
    setRunning(true);
    setStatus("Starting");
    setMessages((current) => [
      ...current,
      { id: `local-${crypto.randomUUID()}`, role: "user", text },
    ]);

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
          cwd: activeProject.path,
          sandbox,
          approvalPolicy,
          baseInstructions: settings.systemPrompt,
          developerInstructions: "",
          config: {
            project_doc_max_bytes: 0,
            project_doc_fallback_filenames: [],
            developer_instructions: "",
            model_reasoning_effort: settings.ultra ? "ultra" : settings.reasoningEffort,
            agents: {
              max_threads: settings.subagentMax,
              max_depth: 1,
            },
            features: {
              multi_agent: settings.subagentsEnabled,
            },
          },
          serviceName: "OpenKiwi",
        };
        if (settings.model.trim()) startParams.model = settings.model.trim();
        if (settings.provider === "openrouter") startParams.modelProvider = "openrouter";

        const result = await rpc<{ thread: Thread }>("thread/start", startParams);
        threadId = result.thread.id;
        setActiveThread(result.thread);
      }

      await rpc("turn/start", {
        threadId,
        input,
        model: settings.model.trim() || undefined,
        effort: settings.ultra ? "ultra" : settings.reasoningEffort,
      });
      setAttachments([]);
      void loadThreads(activeProject);
    } catch (reason) {
      setRunning(false);
      setStatus("Ready");
      setError(String(reason));
    }
  };

  const answerApproval = async (decision: "accept" | "acceptForSession" | "decline") => {
    if (!pendingApproval) return;
    try {
      await respond(pendingApproval.id, { decision });
      setPendingApproval(null);
    } catch (reason) {
      setError(String(reason));
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
      setError(String(reason));
    }
  };

  const deleteThread = async (thread: Thread) => {
    const label = thread.name || thread.preview || "Untitled thread";
    if (!window.confirm(`Delete “${label}” from OpenKiwi's thread list?`)) return;
    try {
      await rpc("thread/archive", { threadId: thread.id });
      if (activeThread?.id === thread.id) newThread();
      setThreads((current) => current.filter((entry) => entry.id !== thread.id));
      void loadThreads(activeProject);
    } catch (reason) {
      setError(String(reason));
    }
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
    } catch (reason) { setError(String(reason)); }
  };

  const openAgent = async (threadId: string) => {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setActiveThread(result.thread);
      setMessages(messagesFromTurns(result.thread.turns));
      setStudioOpen(false);
    } catch (reason) { setError(String(reason)); }
  };

  const stopAgent = async (threadId: string) => {
    try {
      await rpc("turn/interrupt", { threadId });
      setAgentRecords((current) => current.map((agent) => agent.id === threadId ? { ...agent, status: "interrupted" } : agent));
    } catch (reason) { setError(String(reason)); }
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
        streamStdoutStderr: true,
        cwd: activeProject.path,
        timeoutMs: 300000,
        sandboxPolicy: commandSandbox(settings.permission, activeProject.path),
      });
      if (result.stdout || result.stderr) setTerminalOutput((current) => current + result.stdout + result.stderr);
      setTerminalOutput((current) => `${current}\n[exit ${result.exitCode}]\n`);
    } catch (reason) {
      setTerminalOutput((current) => `${current}\n${String(reason)}\n`);
    } finally {
      setTerminalRunning(false);
      setTerminalProcessId(null);
    }
  };

  const stopTerminal = async () => {
    if (!terminalProcessId) return;
    try { await rpc("command/exec/terminate", { processId: terminalProcessId }); } catch (reason) { setError(String(reason)); }
  };

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
        cwd: activeProject?.path,
        model: settings.model,
        baseInstructions: settings.systemPrompt,
        developerInstructions: "",
      });
      setActiveThread(result.thread);
      setMessages(messagesFromTurns(result.thread.turns));
      setActivities([]);
      setStudioOpen(false);
      void loadThreads(activeProject);
    } catch (reason) { setError(String(reason)); }
  };

  const rollbackTurn = async () => {
    if (!activeThread) return;
    try {
      const result = await rpc<{ thread: Thread }>("thread/rollback", { threadId: activeThread.id, numTurns: 1 });
      setActiveThread(result.thread);
      setMessages(messagesFromTurns(result.thread.turns));
      setActivities([]);
    } catch (reason) { setError(String(reason)); }
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
    } catch (reason) { setError(String(reason)); }
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
      if (action === "diff") setDiff(result.stdout);
      if (action === "commit" && result.exitCode === 0) setGitCommitMessage("");
    } catch (reason) { setGitOutput(String(reason)); }
  };

  return (
    <div className="app-shell" data-theme={settings.theme}>
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="sidebar-brand">
          <div className="brand-mark"><img src="/openkiwi-logo.png" alt="" /></div>
          <span>OpenKiwi</span>
          <button className="icon-button subtle collapse-button" onClick={() => setSidebarOpen(false)} title="Hide sidebar">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className="new-thread-button" onClick={newThread} disabled={!activeProject}>
          <Plus size={16} />
          New thread
        </button>

        <div className="sidebar-section projects-section">
          <div className="section-label-row">
            <span className="section-label">Projects</span>
            <button className="icon-button tiny" onClick={addProject} title="Add project"><Plus size={14} /></button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <div key={project.id} className={`project-row-wrap ${project.id === activeProjectId ? "active" : ""}`}>
                <button
                  className="project-row"
                  onClick={() => setActiveProjectId(project.id)}
                  title={project.path}
                >
                  {project.pinned ? <Pin className="project-pin-mark" size={14} /> : <Folder size={15} />}
                  <span>{project.name}</span>
                </button>
                <div className="project-actions">
                  <button onClick={() => toggleProjectPin(project)} title={project.pinned ? "Unpin project" : "Pin project"}>
                    {project.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button className="danger" onClick={() => removeProject(project)} title="Remove from OpenKiwi — files stay on your Mac">
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
            <span className="section-label">Threads</span>
            {activeProject && <span className="thread-count">{threads.length}</span>}
          </div>
          <div className="thread-list">
            {threads.map((thread) => (
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
                    <MessageSquare size={14} />
                    <span>{thread.name || thread.preview || "Untitled thread"}</span>
                  </button>
                )}
                <div className="thread-actions">
                  <button onMouseDown={(event) => event.preventDefault()} onClick={() => startThreadRename(thread)} title="Rename thread"><Pencil size={12} /></button>
                  <button className="danger" onMouseDown={(event) => event.preventDefault()} onClick={() => void deleteThread(thread)} title="Delete thread"><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {activeProject && !threads.length && <div className="empty-threads">No threads yet</div>}
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
              <button className="icon-button" onClick={() => setSidebarOpen(true)} title="Show sidebar">
                <PanelLeftOpen size={18} />
              </button>
            )}
            <div className="project-heading">
              <span>{activeProject?.name ?? "No project"}</span>
              {activeThread && <small>{activeThread.name || activeThread.preview || "New thread"}</small>}
            </div>
          </div>
          <div className="topbar-right">
            <div className="runtime-status">
              {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
              <span>{status}</span>
            </div>
            <button className="provider-pill" onClick={() => setSettingsOpen(true)}>
              <span className={`provider-dot ${settings.provider}`} />
              {settings.provider === "openai" ? "OpenAI" : "OpenRouter"}
              {settings.model && <small>{settings.model}</small>}
            </button>
            <button className={`icon-button studio-toggle ${studioOpen ? "active" : ""}`} onClick={() => studioOpen ? setStudioOpen(false) : openStudio(studioTab)} title="Open workspace tools">
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        {!activeProject ? (
          <section className="welcome-screen">
            <div className="welcome-orbit"><Code2 size={34} /></div>
            <h1>Build from a blank slate.</h1>
            <p>Choose a project folder. OpenKiwi adds no secret instruction layer—your prompt is the prompt.</p>
            <button className="primary-button large" onClick={addProject}><FolderOpen size={17} /> Open project</button>
          </section>
        ) : (
          <>
            <section className="conversation">
              {!messages.length && !activities.length ? (
                <div className="thread-empty-state">
                  <div className="empty-state-icon"><Bot size={27} /></div>
                  <h1>What should we build?</h1>
                  <p>OpenKiwi starts with an empty instruction field. Add your own in Settings whenever you want.</p>
                  <div className="trust-strip">
                    <span><Check size={13} /> No app-added system prompt</span>
                    <span><Check size={13} /> Local project access</span>
                    <span><Check size={13} /> Approval controls</span>
                  </div>
                </div>
              ) : (
                <div className="timeline">
                  {messages.map((message) => (
                    <article key={message.id} className={`message ${message.role}`}>
                      <div className="message-avatar">
                        {message.role === "assistant" ? <Sparkles size={14} /> : <span>You</span>}
                      </div>
                      <div className="message-body">
                        <div className="message-text">{message.text}</div>
                        {message.streaming && <span className="stream-caret" />}
                      </div>
                    </article>
                  ))}
                  {activities.length > 0 && (
                    <div className="activity-stack">
                      {activities.map((activity) => (
                        <div className="activity-row" key={activity.id}>
                          <div className={`activity-icon ${activity.kind}`}>
                            {activity.kind === "command" ? <TerminalSquare size={14} /> : activity.kind === "file" ? <FileCode2 size={14} /> : activity.kind === "agent" ? <UsersRound size={14} /> : <Sparkles size={14} />}
                          </div>
                          <div className="activity-copy">
                            <span>{activity.title}</span>
                            {activity.detail && <pre>{activity.detail.slice(-1200)}</pre>}
                          </div>
                          {activity.status && <small>{activity.status}</small>}
                        </div>
                      ))}
                    </div>
                  )}
                  {running && !messages.some((message) => message.streaming) && (
                    <div className="thinking-row"><LoaderCircle className="spin" size={15} /> Working in {activeProject.name}</div>
                  )}
                </div>
              )}
              <div ref={endRef} />
            </section>

            <section className="composer-zone">
              {error && (
                <div className="error-banner">
                  <span>{error}</span>
                  <button onClick={() => setError(null)}><X size={14} /></button>
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
                  placeholder="Ask OpenKiwi to build, explain, or investigate…"
                  rows={1}
                />
                {settings.provider === "openai" && (
                  <ModelPowerControl
                    model={settings.model || "gpt-5.6-sol"}
                    effort={settings.reasoningEffort}
                    ultra={settings.ultra}
                    runtimeModels={runtimeModels}
                    onModel={(model) => persistSettings({ ...settings, model })}
                    onEffort={(reasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })}
                    onUltra={(ultra) => persistSettings({ ...settings, ultra, subagentsEnabled: ultra ? true : settings.subagentsEnabled })}
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
                  <button className="send-button" onClick={() => void sendMessage()} disabled={!draft.trim() || running}>
                    {running ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
              <div className="composer-caption">OpenKiwi can make mistakes. Review commands and changes before shipping.</div>
            </section>
          </>
        )}
      </main>

      <StudioDock
        open={studioOpen}
        tab={studioTab}
        projectName={activeProject?.name}
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
          { label: "Project injection", value: "disabled" },
          { label: "Model", value: settings.model || "provider default" },
          { label: "Reasoning", value: settings.ultra ? "ultra" : settings.reasoningEffort },
          { label: "Sub-agents", value: settings.subagentsEnabled ? `on · max ${settings.subagentMax}` : "off" },
          { label: "Permissions", value: permissionLabel(settings.permission) },
        ]}
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
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        account={account}
        openRouterReady={openRouterReady}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          persistSettings(next);
          setSettingsOpen(false);
        }}
        onAccountChange={async () => { await refreshAccount(); await refreshModels(); }}
        onOpenRouterChange={setOpenRouterReady}
        onError={setError}
      />

      {pendingApproval && (
        <ApprovalModal approval={pendingApproval} onAnswer={answerApproval} />
      )}
    </div>
  );
}

function SettingsModal({
  open,
  settings,
  account,
  openRouterReady,
  onClose,
  onSave,
  onAccountChange,
  onOpenRouterChange,
  onError,
}: {
  open: boolean;
  settings: AppSettings;
  account: Account | null;
  openRouterReady: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onAccountChange: () => Promise<void>;
  onOpenRouterChange: (ready: boolean) => void;
  onError: (error: string | null) => void;
}) {
  const [local, setLocal] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    onError(null);
    try {
      const result = await rpc<{ authUrl?: string }>("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      });
      if (result.authUrl) await openUrl(result.authUrl);
      window.setTimeout(() => void onAccountChange(), 1800);
    } catch (reason) {
      onError(String(reason));
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
      onError(String(reason));
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
      onError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><h2>Settings</h2><p>OpenKiwi’s instruction text is visible and user-controlled.</p></div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="settings-content">
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
          </section>

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
              <span><Check size={13} /> Project instruction injection disabled</span>
            </div>
          </section>

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
          </section>

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
                  <small>{account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan connected` : "Use the official Codex browser sign-in flow"}</small>
                </div>
                {account?.type === "chatgpt" ? (
                  <button className="secondary-button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
                ) : (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : null} Sign in
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
          </section>
        </div>

        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" onClick={() => onSave({ ...local, subagentMax: Math.min(24, Math.max(1, local.subagentMax)) })}>Save settings</button>
        </div>
      </div>
    </div>
  );
}

function ApprovalModal({
  approval,
  onAnswer,
}: {
  approval: PendingApproval;
  onAnswer: (decision: "accept" | "acceptForSession" | "decline") => Promise<void>;
}) {
  const isFile = approval.method.includes("fileChange");
  const command = String(approval.params.command ?? "");
  const reason = String(approval.params.reason ?? "The agent is requesting permission to continue.");

  return (
    <div className="modal-backdrop approval-backdrop">
      <div className="approval-modal">
        <div className="approval-shield"><ShieldAlert size={22} /></div>
        <h2>{isFile ? "Allow file changes?" : "Allow this action?"}</h2>
        <p>{reason}</p>
        {command && <pre className="approval-command">{command}</pre>}
        <div className="approval-actions">
          <button className="secondary-button danger" onClick={() => void onAnswer("decline")}>Deny</button>
          <button className="secondary-button" onClick={() => void onAnswer("acceptForSession")}>Allow for session</button>
          <button className="primary-button" onClick={() => void onAnswer("accept")}>Allow once</button>
        </div>
      </div>
    </div>
  );
}
