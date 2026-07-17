import { useState } from "react";
import { Bot, Check, Clock3, Play, Plus, Save, Sparkles, Trash2, Wrench } from "lucide-react";
import type { AppSettings, CustomAgentProfile, Project, ProjectAction, PromptProfile, ScheduledTask } from "../types";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";

export function HarnessSettings({ section, settings, profiles, agents, actions, schedules, projects, onSettings, onProfiles, onAgents, onActions, onSchedules }: {
  section: "prompts" | "agents" | "workflows" | "tools";
  settings: AppSettings;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  projects: Project[];
  onSettings: (value: AppSettings) => void;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
}) {
  const [profileName, setProfileName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [actionName, setActionName] = useState("");
  const [actionCommand, setActionCommand] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleProject, setScheduleProject] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState(60);
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpStatus, setMcpStatus] = useState("");

  const saveProfile = () => {
    if (!profileName.trim()) return;
    const profile: PromptProfile = { id: crypto.randomUUID(), name: profileName.trim(), prompt: settings.systemPrompt };
    onProfiles([...profiles, profile]);
    onSettings({ ...settings, promptProfileId: profile.id });
    setProfileName("");
  };

  return <>
    {section === "prompts" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Sparkles size={17} /></div><div><h3>Prompt profiles</h3><p>Switch your complete harness-level instruction without hidden text.</p></div></div>
      <div className="profile-grid">{profiles.map((profile) => <button key={profile.id} className={settings.promptProfileId === profile.id ? "selected" : ""} onClick={() => onSettings({ ...settings, promptProfileId: profile.id, systemPrompt: profile.prompt })}><span><strong>{profile.name}</strong><small>{profile.prompt ? `${profile.prompt.length} characters` : "Empty prompt"}</small></span>{settings.promptProfileId === profile.id && <Check size={13} />}</button>)}</div>
      <div className="inline-create"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" /><button onClick={saveProfile} disabled={!profileName.trim()}><Save size={12} /> Save current prompt</button></div>
    </section>}

    {section === "agents" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Bot size={17} /></div><div><h3>Custom agents</h3><p>Expose named specialist configurations when sub-agents are enabled.</p></div></div>
      <div className="manager-list">{agents.map((agent) => <div key={agent.id}><button className={`mini-toggle ${agent.enabled ? "on" : ""}`} aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`} aria-pressed={agent.enabled} onClick={() => onAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: !item.enabled } : item))}><span /></button><span><strong>{agent.name}</strong><small>{agent.instructions}</small></span><button className="manager-delete" aria-label={`Delete ${agent.name}`} onClick={() => onAgents(agents.filter((item) => item.id !== agent.id))}><Trash2 size={12} /></button></div>)}</div>
      <div className="stacked-create"><input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name (for example: reviewer)" /><textarea value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="Specialist instructions" rows={3} /><button onClick={() => { if (!agentName.trim() || !agentInstructions.trim()) return; onAgents([...agents, { id: crypto.randomUUID(), name: agentName.trim(), description: agentInstructions.trim().slice(0, 90), instructions: agentInstructions.trim(), enabled: true }]); setAgentName(""); setAgentInstructions(""); }} disabled={!agentName.trim() || !agentInstructions.trim()}><Plus size={12} /> Add custom agent</button></div>
    </section>}

    {section === "workflows" && <>
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Play size={17} /></div><div><h3>Project actions</h3><p>Create one-click commands that run in the selected project with its permission policy.</p></div></div>
      <div className="manager-list">{actions.map((action) => <div key={action.id}><Play size={12} /><span><strong>{action.name}</strong><small>{action.command}</small></span><button className="manager-delete" aria-label={`Delete ${action.name}`} onClick={() => onActions(actions.filter((item) => item.id !== action.id))}><Trash2 size={12} /></button></div>)}</div>
      <div className="inline-create two"><input value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="Action name" /><input value={actionCommand} onChange={(event) => setActionCommand(event.target.value)} placeholder="Command" /><button onClick={() => { if (!actionName.trim() || !actionCommand.trim()) return; onActions([...actions, { id: crypto.randomUUID(), name: actionName.trim(), command: actionCommand.trim() }]); setActionName(""); setActionCommand(""); }}><Plus size={12} /> Add</button></div>
    </section>

    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Clock3 size={17} /></div><div><h3>Scheduled tasks</h3><p>Run a prompt on an interval while OpenKiwi is open. Every run creates a traceable project thread.</p></div></div>
      <div className="manager-list">{schedules.map((schedule) => <div key={schedule.id}><button className={`mini-toggle ${schedule.enabled ? "on" : ""}`} aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`} aria-pressed={schedule.enabled} onClick={() => onSchedules(schedules.map((item) => item.id === schedule.id ? { ...item, enabled: !item.enabled, nextRunAt: Date.now() + item.intervalMinutes * 60_000 } : item))}><span /></button><span><strong>{schedule.name}</strong><small>Every {schedule.intervalMinutes} min · {projects.find((project) => project.id === schedule.projectId)?.name ?? "No project"}</small></span><button className="manager-delete" aria-label={`Delete ${schedule.name}`} onClick={() => onSchedules(schedules.filter((item) => item.id !== schedule.id))}><Trash2 size={12} /></button></div>)}</div>
      <div className="schedule-create"><input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="Task name" /><select value={scheduleProject} onChange={(event) => setScheduleProject(event.target.value)}><option value="">Choose project…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><input type="number" min={5} value={scheduleMinutes} onChange={(event) => setScheduleMinutes(Math.max(5, Number(event.target.value)))} /><textarea value={schedulePrompt} onChange={(event) => setSchedulePrompt(event.target.value)} placeholder="Prompt to run" rows={3} /><button onClick={() => { if (!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject) return; onSchedules([...schedules, { id: crypto.randomUUID(), name: scheduleName.trim(), prompt: schedulePrompt.trim(), projectId: scheduleProject, intervalMinutes: scheduleMinutes, enabled: true, nextRunAt: Date.now() + scheduleMinutes * 60_000 }]); setScheduleName(""); setSchedulePrompt(""); }} disabled={!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject}><Plus size={12} /> Add schedule</button></div>
    </section>
    </>}

    {section === "tools" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>MCP servers</h3><p>Add a local stdio MCP server. Its command is written to OpenKiwi’s isolated Codex configuration.</p></div></div>
      <div className="inline-create two"><input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" /><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="Command, for example: npx -y package" /><button disabled={!mcpName.trim() || !mcpCommand.trim()} onClick={() => { const parts = mcpCommand.trim().split(/\s+/); setMcpStatus("Saving…"); void rpc("config/value/write", { keyPath: `mcp_servers.${mcpName.trim().replace(/[^a-zA-Z0-9_-]/g, "-")}`, value: { command: parts[0], args: parts.slice(1) }, mergeStrategy: "upsert" }).then(() => rpc("config/mcpServer/reload")).then(() => { setMcpStatus("Connected. Open Workspace tools → Tools to inspect it."); setMcpName(""); setMcpCommand(""); }).catch((reason) => setMcpStatus(friendlyError(reason))); }}><Plus size={12} /> Add</button></div>
      {mcpStatus && <div className="manager-status">{mcpStatus}</div>}
      <div className="compact-note"><Wrench size={14} /><span><strong>MCP controls</strong><small>Complete MCP OAuth from Workspace tools → Tools. Manage local Markdown workflows in the dedicated Skills section.</small></span></div>
    </section>}
  </>;
}
