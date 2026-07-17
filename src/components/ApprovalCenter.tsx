import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonObject } from "../lib/codex";
import type { PendingApproval } from "../types";

type Decision = "accept" | "acceptForSession" | "decline";

function ApprovalButtons({ onDecision, allowSession = true }: { onDecision: (value: Decision) => void; allowSession?: boolean }) {
  return <div className="approval-actions"><button className="secondary-button danger" onClick={() => onDecision("decline")}>Deny</button>{allowSession && <button className="secondary-button" onClick={() => onDecision("acceptForSession")}>Allow for session</button>}<button className="primary-button" onClick={() => onDecision("accept")}>Allow once</button></div>;
}

function StandardApproval({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void }) {
  const isFile = approval.method.includes("fileChange") || approval.method.includes("applyPatch");
  const commandValue = approval.params.command;
  const command = Array.isArray(commandValue) ? commandValue.join(" ") : String(commandValue ?? "");
  const reason = String(approval.params.reason ?? "The agent is requesting permission to continue.");
  const legacy = approval.method === "execCommandApproval" || approval.method === "applyPatchApproval";
  const permissions = approval.method === "item/permissions/requestApproval";
  return <Modal title={isFile ? "Allow file changes?" : permissions ? "Grant additional permissions?" : "Allow this action?"} description={reason}>{command && <pre className="approval-command">{command}</pre>}<ApprovalButtons onDecision={(decision) => {
    if (permissions) {
      const requested = (approval.params.permissions ?? {}) as JsonObject;
      onRespond({ permissions: decision === "decline" ? { network: { enabled: false }, fileSystem: { read: [], write: [], entries: [] } } : requested, scope: decision === "acceptForSession" ? "session" : "turn" });
      return;
    }
    onRespond({ decision: legacy ? decision === "accept" ? "approved" : decision === "acceptForSession" ? "approved_for_session" : "denied" : decision });
  }} /></Modal>;
}

interface UserQuestion { id: string; header: string; question: string; isSecret?: boolean; options?: Array<{ label: string; description: string }> | null }

function UserInputRequest({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void }) {
  const questions = (approval.params.questions ?? []) as UserQuestion[];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <Modal title="The agent needs your input" description="Answer these questions to continue the task."><div className="request-fields">{questions.map((question) => <label key={question.id}><span>{question.header}</span><small>{question.question}</small>{question.options?.length ? <select value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">Choose…</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div><div className="approval-actions"><button className="secondary-button danger" onClick={() => onRespond({ answers: {} })}>Cancel</button><button className="primary-button" onClick={() => onRespond({ answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: [value] }])) })}>Continue</button></div></Modal>;
}

interface JsonSchemaProperty { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[] }

function McpRequest({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void }) {
  const mode = String(approval.params.mode ?? "form");
  const message = String(approval.params.message ?? "An MCP server is requesting information.");
  const url = typeof approval.params.url === "string" ? approval.params.url : null;
  const schema = (approval.params.requestedSchema ?? {}) as { properties?: Record<string, JsonSchemaProperty>; required?: string[] };
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema.properties]);
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(([key, value]) => [key, value.default ?? ""])));
  return <Modal title={`${String(approval.params.serverName ?? "MCP")} needs your input`} description={message}>{url && <button className="elicitation-url" onClick={() => void openUrl(url)}><ExternalLink size={13} /> Open secure request</button>}{mode !== "url" && <div className="request-fields">{fields.map(([key, field]) => <label key={key}><span>{field.title || key}{schema.required?.includes(key) ? " *" : ""}</span>{field.description && <small>{field.description}</small>}{field.type === "boolean" ? <select value={String(content[key] ?? false)} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value === "true" }))}><option value="false">No</option><option value="true">Yes</option></select> : field.enum ? <select value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value }))}>{field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value }))} />}</label>)}</div>}<div className="approval-actions"><button className="secondary-button danger" onClick={() => onRespond({ action: "decline", content: null, _meta: null })}>Decline</button><button className="primary-button" onClick={() => onRespond({ action: "accept", content: mode === "url" ? null : content, _meta: null })}>{mode === "url" ? "I’m done" : "Submit"}</button></div></Modal>;
}

function Modal({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="modal-backdrop approval-backdrop"><div className="approval-modal"><div className="approval-shield"><ShieldAlert size={22} /></div><h2>{title}</h2><p>{description}</p>{children}</div></div>;
}

export function ApprovalCenter({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void }) {
  if (approval.method === "item/tool/requestUserInput") return <UserInputRequest approval={approval} onRespond={onRespond} />;
  if (approval.method === "mcpServer/elicitation/request") return <McpRequest approval={approval} onRespond={onRespond} />;
  return <StandardApproval approval={approval} onRespond={onRespond} />;
}
