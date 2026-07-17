import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  CodeXml,
  FilePlus2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Gauge,
  History,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SearchCode,
  ShieldCheck,
  TerminalSquare,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";

export type StudioTab = "review" | "agents" | "terminal" | "history" | "context" | "usage" | "tools" | "git";

export interface AgentRecord {
  id: string;
  prompt: string;
  status: string;
  path?: string;
}

export interface CheckpointRecord {
  id: string;
  threadId: string;
  turnId?: string;
  label: string;
  createdAt: number;
}

export interface AttachmentRecord {
  path: string;
  name: string;
  kind: "image" | "file";
}

export interface TokenUsageView {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  contextWindow?: number | null;
}

export interface SkillView { name: string; description?: string; path?: string }
export interface McpView { name: string; status: string; tools: number }

const TABS: Array<{ id: StudioTab; label: string; icon: typeof CodeXml }> = [
  { id: "review", label: "Review", icon: SearchCode },
  { id: "agents", label: "Agents", icon: UsersRound },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "history", label: "History", icon: History },
  { id: "context", label: "Context", icon: Paperclip },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "git", label: "Git", icon: GitBranch },
];

function PanelHeader({ icon: Icon, title, subtitle, onClose }: { icon: typeof CodeXml; title: string; subtitle: string; onClose: () => void }) {
  return <div className="studio-header"><span className="studio-header-icon"><Icon size={16} /></span><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose}><X size={16} /></button></div>;
}

export function StudioDock(props: {
  open: boolean;
  tab: StudioTab;
  projectName?: string;
  activeThread: boolean;
  diff: string;
  approvedDiff: boolean;
  agents: AgentRecord[];
  terminalOutput: string;
  terminalCommand: string;
  terminalRunning: boolean;
  checkpoints: CheckpointRecord[];
  attachments: AttachmentRecord[];
  usage: TokenUsageView | null;
  rateSummary: string;
  skills: SkillView[];
  mcpServers: McpView[];
  gitOutput: string;
  gitCommitMessage: string;
  promptAudit: Array<{ label: string; value: string }>;
  onTab: (tab: StudioTab) => void;
  onClose: () => void;
  onRefreshDiff: () => void;
  onReview: () => void;
  onApproveDiff: () => void;
  onOpenAgent: (id: string) => void;
  onStopAgent: (id: string) => void;
  onTerminalCommand: (value: string) => void;
  onRunTerminal: () => void;
  onStopTerminal: () => void;
  onCheckpoint: () => void;
  onFork: (checkpoint?: CheckpointRecord) => void;
  onRollback: () => void;
  onWorktree: () => void;
  onAddAttachment: () => void;
  onRemoveAttachment: (path: string) => void;
  onRefreshUsage: () => void;
  onRefreshTools: () => void;
  onGitAction: (action: "status" | "diff" | "stage" | "revert" | "commit" | "comments" | "ci" | "pr") => void;
  onGitCommitMessage: (value: string) => void;
}) {
  const diffHunks = useMemo(() => props.diff.split("\n").reduce<Array<{ id: string; label: string }>>((hunks, line) => {
    if (line.startsWith("@@")) hunks.push({ id: `${hunks.length}-${line}`, label: line });
    return hunks;
  }, []), [props.diff]);
  const [approvedHunks, setApprovedHunks] = useState<Record<string, boolean>>({});
  useEffect(() => setApprovedHunks({}), [props.diff]);
  return (
    <aside className={`studio-dock ${props.open ? "open" : "closed"}`} aria-hidden={!props.open} inert={!props.open ? true : undefined}>
      <nav className="studio-tabs" aria-label="Workspace tools">
        {TABS.map(({ id, label, icon: Icon }) => <button key={id} className={props.tab === id ? "active" : ""} onClick={() => props.onTab(id)} title={label}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      <div className="studio-panel">
        {props.tab === "review" && <>
          <PanelHeader icon={SearchCode} title="Review center" subtitle="Inspect the live turn diff" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshDiff}><RefreshCw size={13} /> Refresh</button><button onClick={props.onReview} disabled={!props.activeThread}><Bot size={13} /> AI review</button><button className={props.approvedDiff ? "approved" : ""} onClick={props.onApproveDiff} disabled={!props.diff}><Check size={13} /> {props.approvedDiff ? "Approved" : "Approve"}</button></div>
          <div className="diff-summary"><span><CodeXml size={13} /> Working changes</span><small>{props.diff ? `${props.diff.split("\n").filter((line) => line.startsWith("diff --git")).length || 1} file groups` : "No changes loaded"}</small></div>
          {diffHunks.length > 0 && <div className="hunk-review-list">{diffHunks.map((hunk, index) => <button key={hunk.id} className={approvedHunks[hunk.id] ? "approved" : ""} onClick={() => setApprovedHunks((current) => ({ ...current, [hunk.id]: !current[hunk.id] }))}><span>{approvedHunks[hunk.id] ? <Check size={11} /> : index + 1}</span><code>{hunk.label}</code></button>)}</div>}
          <pre className="diff-view">{props.diff || "Run a task or refresh to inspect the current Git diff."}</pre>
        </>}

        {props.tab === "agents" && <>
          <PanelHeader icon={UsersRound} title="Agent control" subtitle="Direct children and delegated work" onClose={props.onClose} />
          <div className="metric-grid"><div><strong>{props.agents.length}</strong><span>Observed</span></div><div><strong>{props.agents.filter((a) => a.status === "inProgress" || a.status === "started").length}</strong><span>Active</span></div></div>
          <div className="studio-list">{props.agents.length ? props.agents.map((agent) => <div className="studio-list-row" key={agent.id}><span className={`status-orb ${agent.status}`} /><div><strong>{agent.prompt || "Delegated task"}</strong><small>{agent.status} · {agent.id.slice(0, 8)}</small></div><button onClick={() => props.onOpenAgent(agent.id)} title="Open child thread"><ChevronRight size={14} /></button><button onClick={() => props.onStopAgent(agent.id)} title="Stop child agent"><CircleStop size={14} /></button></div>) : <Empty icon={UsersRound} title="No sub-agents yet" text="When the model delegates, each child appears here." />}</div>
        </>}

        {props.tab === "terminal" && <>
          <PanelHeader icon={TerminalSquare} title="Terminal" subtitle={props.projectName || "Project shell"} onClose={props.onClose} />
          <pre className="terminal-screen">{props.terminalOutput || `OPENKIWI terminal ready\n$ `}</pre>
          <div className="terminal-input"><span>$</span><input value={props.terminalCommand} onChange={(e) => props.onTerminalCommand(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onRunTerminal(); }} placeholder="npm test" /><button onClick={props.terminalRunning ? props.onStopTerminal : props.onRunTerminal}>{props.terminalRunning ? <CircleStop size={14} /> : <Play size={14} />}</button></div>
        </>}

        {props.tab === "history" && <>
          <PanelHeader icon={History} title="Checkpoints" subtitle="Fork, rewind, or isolate work" onClose={props.onClose} />
          <div className="studio-actions wrap"><button onClick={props.onCheckpoint} disabled={!props.activeThread}><Plus size={13} /> Checkpoint</button><button onClick={() => props.onFork()} disabled={!props.activeThread}><GitFork size={13} /> Fork now</button><button onClick={props.onRollback} disabled={!props.activeThread}><RotateCcw size={13} /> Undo last turn</button><button onClick={props.onWorktree}><GitBranch size={13} /> New worktree</button></div>
          <div className="history-warning"><ShieldCheck size={13} /> Conversation undo does not revert files. Use Review or Git for file rollback.</div>
          <div className="studio-list">{props.checkpoints.length ? props.checkpoints.map((checkpoint) => <div className="studio-list-row" key={checkpoint.id}><Clock3 size={15} /><div><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()}</small></div><button onClick={() => props.onFork(checkpoint)}><GitFork size={14} /></button></div>) : <Empty icon={History} title="No checkpoints" text="Capture a safe branch point before a risky direction." />}</div>
        </>}

        {props.tab === "context" && <>
          <PanelHeader icon={Paperclip} title="Context" subtitle="Files, images, and task references" onClose={props.onClose} />
          <button className="attachment-drop" onClick={props.onAddAttachment}><FilePlus2 size={21} /><strong>Add files or images</strong><small>Images are sent natively; file paths become explicit task context.</small></button>
          <div className="studio-list">{props.attachments.map((item) => <div className="studio-list-row" key={item.path}><Paperclip size={14} /><div><strong>{item.name}</strong><small>{item.kind} · {item.path}</small></div><button onClick={() => props.onRemoveAttachment(item.path)}><X size={13} /></button></div>)}</div>
        </>}

        {props.tab === "usage" && <>
          <PanelHeader icon={Gauge} title="Usage & audit" subtitle="Context, tokens, and visible request fields" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshUsage}><RefreshCw size={13} /> Refresh</button></div>
          <div className="usage-hero"><span>Context used</span><strong>{props.usage?.totalTokens.toLocaleString() ?? "—"}</strong><small>{props.usage?.contextWindow ? `of ${props.usage.contextWindow.toLocaleString()} tokens` : "Current thread"}</small><i style={{ width: `${Math.min(100, ((props.usage?.totalTokens ?? 0) / (props.usage?.contextWindow || 1)) * 100)}%` }} /></div>
          <div className="metric-grid three"><div><strong>{props.usage?.inputTokens.toLocaleString() ?? "—"}</strong><span>Input</span></div><div><strong>{props.usage?.outputTokens.toLocaleString() ?? "—"}</strong><span>Output</span></div><div><strong>{props.usage?.reasoningOutputTokens.toLocaleString() ?? "—"}</strong><span>Reasoning</span></div></div>
          <div className="rate-card"><span>Account limits</span><strong>{props.rateSummary || "Sign in to view live limits"}</strong></div>
          <h3 className="panel-label">Request audit</h3><div className="audit-table">{props.promptAudit.map((row) => <div key={row.label}><span>{row.label}</span><code>{row.value}</code></div>)}</div>
        </>}

        {props.tab === "tools" && <>
          <PanelHeader icon={Wrench} title="Tools & skills" subtitle="Harness capabilities available to the model" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshTools}><RefreshCw size={13} /> Rescan</button></div>
          <div className="tool-policy-card"><ShieldCheck size={14} /><div><strong>Permission-aware tools</strong><small>Terminal, Git, MCP, and agent actions follow the permission mode selected beneath the composer. Annotated destructive MCP actions still require approval.</small></div></div>
          <h3 className="panel-label">Skills</h3><div className="studio-list compact">{props.skills.length ? props.skills.map((skill) => <div className="studio-list-row" key={`${skill.name}-${skill.path}`}><Boxes size={14} /><div><strong>{skill.name}</strong><small>{skill.description || skill.path || "Reusable workflow"}</small></div></div>) : <Empty icon={Boxes} title="No skills found" text="Skills in the isolated OPENKIWI runtime appear here." />}</div>
          <h3 className="panel-label">MCP servers</h3><div className="studio-list compact">{props.mcpServers.length ? props.mcpServers.map((server) => <div className="studio-list-row" key={server.name}><span className={`status-orb ${server.status}`} /><div><strong>{server.name}</strong><small>{server.status} · {server.tools} tools</small></div></div>) : <Empty icon={Wrench} title="No MCP servers" text="Configured servers and their tool counts appear here." />}</div>
        </>}

        {props.tab === "git" && <>
          <PanelHeader icon={GitBranch} title="Git workspace" subtitle="Shape changes without leaving OPENKIWI" onClose={props.onClose} />
          <div className="studio-actions wrap"><button onClick={() => props.onGitAction("status")}><RefreshCw size={13} /> Status</button><button onClick={() => props.onGitAction("diff")}><CodeXml size={13} /> Diff</button><button onClick={() => props.onGitAction("stage")}><Plus size={13} /> Stage all</button><button className="danger-action" onClick={() => props.onGitAction("revert")}><RotateCcw size={13} /> Revert all</button></div>
          <pre className="git-screen">{props.gitOutput || "Choose an action to inspect the repository."}</pre>
          <label className="dock-field"><span>Commit message</span><input value={props.gitCommitMessage} onChange={(e) => props.onGitCommitMessage(e.target.value)} placeholder="Describe this change" /></label>
          <div className="studio-actions wrap"><button onClick={() => props.onGitAction("commit")} disabled={!props.gitCommitMessage.trim()}><GitCommitHorizontal size={13} /> Commit staged</button><button onClick={() => props.onGitAction("comments")}><CodeXml size={13} /> Review comments</button><button onClick={() => props.onGitAction("ci")}><ShieldCheck size={13} /> CI checks</button><button onClick={() => props.onGitAction("pr")}><GitFork size={13} /> Draft PR</button></div>
        </>}
      </div>
    </aside>
  );
}

function Empty({ icon: Icon, title, text }: { icon: typeof CodeXml; title: string; text: string }) {
  return <div className="studio-empty"><Icon size={21} /><strong>{title}</strong><span>{text}</span></div>;
}
