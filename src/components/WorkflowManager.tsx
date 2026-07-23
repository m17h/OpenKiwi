import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  TerminalSquare,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import {
  nextWorkflowRunAt,
  validateWorkflow,
  workflowTriggerLabel,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type WorkflowStep,
  type WorkflowTrigger,
} from "../lib/workflows";
import type { LocalSkill } from "../lib/skills";
import type { AppSettings, Project } from "../types";

function newWorkflow(settings: AppSettings, projectId: string): WorkflowDefinition {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    projectId,
    enabled: true,
    trigger: { type: "manual" },
    steps: [{
      id: crypto.randomUUID(),
      type: "agent",
      name: "Agent task",
      prompt: "",
      continueOnError: false,
    }],
    skillNames: [],
    run: scheduleRunSnapshot(settings),
    createdAt: now,
    updatedAt: now,
  };
}

function newStep(type: WorkflowStep["type"]): WorkflowStep {
  return type === "agent"
    ? { id: crypto.randomUUID(), type, name: "Agent task", prompt: "", continueOnError: false }
    : { id: crypto.randomUUID(), type, name: "Run command", command: "", continueOnError: false };
}

function triggerFor(type: WorkflowTrigger["type"]): WorkflowTrigger {
  return type === "interval"
    ? { type, intervalMinutes: 60 }
    : { type };
}

function runStatusLabel(run: WorkflowRunRecord): string {
  if (run.status === "running") return `Step ${Math.max(1, run.currentStep)} of ${run.stepCount}`;
  if (run.status === "completed") return "Completed";
  if (run.status === "interrupted") return "Stopped";
  return run.error || "Failed";
}

export function WorkflowManager({
  workflows,
  runs,
  projects,
  skills,
  settings,
  onWorkflows,
  onRun,
  onOpenRun,
}: {
  workflows: WorkflowDefinition[];
  runs: WorkflowRunRecord[];
  projects: Project[];
  skills: LocalSkill[];
  settings: AppSettings;
  onWorkflows: (workflows: WorkflowDefinition[]) => void;
  onRun: (workflowId: string) => Promise<void> | void;
  onOpenRun?: (threadId: string) => void;
}) {
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [draftError, setDraftError] = useState("");
  const latestRuns = useMemo(() => {
    const latest = new Map<string, WorkflowRunRecord>();
    for (const run of runs) {
      if (!latest.has(run.workflowId)) latest.set(run.workflowId, run);
    }
    return latest;
  }, [runs]);

  const saveDraft = () => {
    if (!draft) return;
    const validationError = validateWorkflow(draft);
    if (validationError) {
      setDraftError(validationError);
      return;
    }
    const now = Date.now();
    const next = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      steps: draft.steps.map((step) => ({
        ...step,
        name: step.name.trim(),
        ...(step.type === "agent" ? { prompt: step.prompt.trim() } : { command: step.command.trim() }),
      })),
      nextRunAt: draft.trigger.type === "interval"
        ? (draft.nextRunAt ?? nextWorkflowRunAt(draft.trigger, now))
        : undefined,
      updatedAt: now,
    };
    onWorkflows(workflows.some((workflow) => workflow.id === next.id)
      ? workflows.map((workflow) => workflow.id === next.id ? next : workflow)
      : [next, ...workflows]);
    setDraft(null);
    setDraftError("");
  };

  const updateStep = (stepId: string, patch: Partial<WorkflowStep>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      steps: draft.steps.map((step) => step.id === stepId
        ? ({ ...step, ...patch } as WorkflowStep)
        : step),
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    if (!draft) return;
    const target = index + direction;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    setDraft({ ...draft, steps });
  };

  return (
    <section className="settings-section workflow-manager">
      <div className="settings-section-heading settings-heading-with-action">
        <div className="settings-icon"><Workflow size={17} /></div>
        <div>
          <h3>Agent workflows</h3>
          <p>Build ordered recipes from agent prompts and deterministic commands. Run them manually, on an interval, or whenever OpenKiwi starts.</p>
        </div>
        <button
          className="secondary-button compact"
          onClick={() => {
            setDraft(newWorkflow(settings, projects[0]?.id ?? ""));
            setDraftError("");
          }}
          disabled={!projects.length || Boolean(draft)}
        >
          <Plus size={12} /> New workflow
        </button>
      </div>

      <div className="workflow-safety-note">
        <Check size={13} />
        <span><strong>Transparent by design</strong><small>Every agent step appears as a user message in its project thread. Commands, selected skills, model settings, and permissions remain visible and editable.</small></span>
      </div>

      {!projects.length && (
        <div className="workflow-empty"><Workflow size={19} /><span>Add a project before creating a workflow.</span></div>
      )}

      {workflows.length > 0 && (
        <div className="workflow-list">
          {workflows.map((workflow) => {
            const project = projects.find((item) => item.id === workflow.projectId);
            const latest = latestRuns.get(workflow.id);
            const running = latest?.status === "running";
            return (
              <article key={workflow.id} className={`workflow-card ${workflow.enabled ? "" : "disabled"}`}>
                <div className="workflow-card-main">
                  <button
                    className={`mini-toggle ${workflow.enabled ? "on" : ""}`}
                    aria-label={`${workflow.enabled ? "Disable" : "Enable"} ${workflow.name}`}
                    aria-pressed={workflow.enabled}
                    onClick={() => {
                      const now = Date.now();
                      onWorkflows(workflows.map((item) => item.id === workflow.id ? {
                        ...item,
                        enabled: !item.enabled,
                        nextRunAt: !item.enabled ? nextWorkflowRunAt(item.trigger, now) : item.nextRunAt,
                        updatedAt: now,
                      } : item));
                    }}
                  >
                    <span />
                  </button>
                  <span className="workflow-card-icon"><Workflow size={14} /></span>
                  <span className="workflow-card-copy">
                    <strong>{workflow.name}</strong>
                    <small>{project?.name ?? "Missing project"} · {workflowTriggerLabel(workflow.trigger)} · {workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"}</small>
                    {workflow.description && <em>{workflow.description}</em>}
                  </span>
                  {latest && <span className={`workflow-run-chip ${latest.status}`}>{runStatusLabel(latest)}</span>}
                </div>
                <div className="workflow-card-actions">
                  <button
                    onClick={() => {
                      const commands = workflow.steps.filter((step) => step.type === "command");
                      if (commands.length && !window.confirm(`Run “${workflow.name}” now?\n\nIt contains ${commands.length} shell command${commands.length === 1 ? "" : "s"} that will run in ${project?.name ?? "its project"} using the saved ${workflow.run.permission} permission setting.`)) return;
                      void onRun(workflow.id);
                    }}
                    disabled={running || !project}
                  >
                    <Play size={11} /> {running ? "Running…" : "Run"}
                  </button>
                  <button onClick={() => { setDraft(structuredClone(workflow)); setDraftError(""); }} disabled={Boolean(draft)}><Pencil size={11} /> Edit</button>
                  {workflow.lastThreadId && onOpenRun && <button onClick={() => onOpenRun(workflow.lastThreadId!)}><Sparkles size={11} /> Last thread</button>}
                  <button
                    className="danger-action"
                    aria-label={`Delete ${workflow.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete the workflow “${workflow.name}”? Its existing threads will remain available.`)) {
                        onWorkflows(workflows.filter((item) => item.id !== workflow.id));
                      }
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {draft && (
        <div className="workflow-editor">
          <div className="workflow-editor-header">
            <span><Workflow size={15} /><strong>{workflows.some((item) => item.id === draft.id) ? "Edit workflow" : "Create workflow"}</strong></span>
            <button className="icon-button" onClick={() => { setDraft(null); setDraftError(""); }} aria-label="Close workflow editor"><X size={14} /></button>
          </div>

          <div className="workflow-editor-grid">
            <label><span>Name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Release readiness" /></label>
            <label><span>Project</span><select value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}><option value="">Choose project…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label className="wide"><span>Description</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="What this workflow accomplishes" /></label>
            <label><span>Trigger</span><select value={draft.trigger.type} onChange={(event) => {
              const trigger = triggerFor(event.target.value as WorkflowTrigger["type"]);
              setDraft({ ...draft, trigger, nextRunAt: nextWorkflowRunAt(trigger) });
            }}><option value="manual">Manual</option><option value="interval">Interval</option><option value="app-start">When OpenKiwi starts</option></select></label>
            {draft.trigger.type === "interval" && <label><span>Every (minutes)</span><input type="number" min={5} value={draft.trigger.intervalMinutes} onChange={(event) => {
              const trigger: WorkflowTrigger = { type: "interval", intervalMinutes: Math.max(5, Number(event.target.value) || 5) };
              setDraft({ ...draft, trigger, nextRunAt: nextWorkflowRunAt(trigger) });
            }} /></label>}
          </div>

          <div className="workflow-runtime-summary">
            <span><Bot size={12} /> {draft.run.provider === "openai" ? "OpenAI" : "OpenRouter"} · {draft.run.model || "Default model"}</span>
            <span>{draft.run.reasoningEffort}{draft.run.ultra ? " + Ultra" : ""}</span>
            <span>{draft.run.permission}</span>
            <button onClick={() => setDraft({ ...draft, run: scheduleRunSnapshot(settings) })}><RotateCcw size={10} /> Use current settings</button>
          </div>

          {skills.length > 0 && (
            <div className="workflow-skills">
              <span>Skills available to agent steps</span>
              <div>{skills.filter((skill) => skill.enabled !== false).map((skill) => <label key={skill.path}><input type="checkbox" checked={draft.skillNames.includes(skill.name)} onChange={() => setDraft({ ...draft, skillNames: draft.skillNames.includes(skill.name) ? draft.skillNames.filter((name) => name !== skill.name) : [...draft.skillNames, skill.name] })} /><code>${skill.name}</code></label>)}</div>
            </div>
          )}

          <div className="workflow-steps-heading">
            <span><strong>Recipe steps</strong><small>Steps run from top to bottom in the same project and thread.</small></span>
            <div><button onClick={() => setDraft({ ...draft, steps: [...draft.steps, newStep("agent")] })}><Bot size={11} /> Agent step</button><button onClick={() => setDraft({ ...draft, steps: [...draft.steps, newStep("command")] })}><TerminalSquare size={11} /> Command step</button></div>
          </div>

          <div className="workflow-steps">
            {draft.steps.map((step, index) => (
              <div key={step.id} className={`workflow-step ${step.type}`}>
                <div className="workflow-step-index">{index + 1}</div>
                <div className="workflow-step-body">
                  <div className="workflow-step-title">
                    <span>{step.type === "agent" ? <Bot size={12} /> : <TerminalSquare size={12} />}{step.type === "agent" ? "Agent prompt" : "Shell command"}</span>
                    <div>
                      <button onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label={`Move ${step.name} up`}><ArrowUp size={11} /></button>
                      <button onClick={() => moveStep(index, 1)} disabled={index === draft.steps.length - 1} aria-label={`Move ${step.name} down`}><ArrowDown size={11} /></button>
                      <button className="danger-action" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((item) => item.id !== step.id) })} aria-label={`Delete ${step.name}`}><Trash2 size={11} /></button>
                    </div>
                  </div>
                  <input value={step.name} onChange={(event) => updateStep(step.id, { name: event.target.value })} placeholder="Step name" />
                  {step.type === "agent"
                    ? <textarea value={step.prompt} onChange={(event) => updateStep(step.id, { prompt: event.target.value })} rows={4} placeholder="Tell the agent exactly what to accomplish and how to verify it." />
                    : <textarea value={step.command} onChange={(event) => updateStep(step.id, { command: event.target.value })} rows={2} className="monospace" placeholder="npm test" />}
                  <label className="workflow-continue"><input type="checkbox" checked={step.continueOnError} onChange={(event) => updateStep(step.id, { continueOnError: event.target.checked })} /> Continue if this step fails</label>
                </div>
              </div>
            ))}
          </div>

          {draftError && <div className="manager-status error">{draftError}</div>}
          <div className="workflow-editor-actions"><button className="secondary-button" onClick={() => { setDraft(null); setDraftError(""); }}>Cancel</button><button className="primary-button" onClick={saveDraft}><Check size={12} /> Save workflow</button></div>
        </div>
      )}

      {runs.length > 0 && (
        <>
          <h3 className="panel-label">Workflow run history</h3>
          <div className="schedule-run-list workflow-run-list">
            {runs.slice(0, 12).map((run) => (
              <div key={run.id} className={run.status === "failed" ? "failed" : ""}>
                <span className={`status-orb ${run.status === "failed" ? "failed" : run.status === "running" ? "inProgress" : "ready"}`} />
                <span className="schedule-run-copy"><strong>{run.workflowName}</strong><small>{new Date(run.startedAt).toLocaleString()} · {run.source} · {runStatusLabel(run)}</small></span>
                {run.threadId && onOpenRun && <button onClick={() => onOpenRun(run.threadId!)}><Play size={11} /> Open</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
