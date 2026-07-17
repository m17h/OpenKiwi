import { Children, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import { Check, Clipboard, FileCode2, LoaderCircle, Sparkles, TerminalSquare, UsersRound } from "lucide-react";
import Markdown from "react-markdown";
import { Virtuoso } from "react-virtuoso";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage } from "../types";

type TimelineEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "thinking"; label: string };

function textFromCodeNode(node: ReactNode): string {
  const child = Children.toArray(node)[0];
  if (!isValidElement<{ children?: ReactNode }>(child)) return String(node ?? "");
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function CodePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromCodeNode(children);
  return (
    <div className="code-block">
      <button
        className="code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        title="Copy code"
      >
        {copied ? <Check size={12} /> : <Clipboard size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">
        {message.role === "assistant" ? <Sparkles size={14} /> : <span>You</span>}
      </div>
      <div className="message-body">
        <div className="message-text rich-markdown">
          <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodePre }}>{message.text}</Markdown>
        </div>
        {message.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
});

const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const Icon = activity.kind === "command"
    ? TerminalSquare
    : activity.kind === "file"
      ? FileCode2
      : activity.kind === "agent"
        ? UsersRound
        : Sparkles;
  return (
    <div className="activity-row">
      <div className={`activity-icon ${activity.kind}`}><Icon size={14} /></div>
      <div className="activity-copy">
        <span>{activity.title}</span>
        {activity.detail && <pre>{activity.detail.slice(-1200)}</pre>}
      </div>
      {activity.status && <small>{activity.status}</small>}
    </div>
  );
});

export function ChatTimeline({
  messages,
  activities,
  running,
  thinkingLabel,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  running: boolean;
  thinkingLabel: string;
}) {
  const entries = useMemo<TimelineEntry[]>(() => {
    const next: TimelineEntry[] = [
      ...messages.map((value): TimelineEntry => ({ kind: "message", value })),
      ...activities.map((value): TimelineEntry => ({ kind: "activity", value })),
    ];
    if (running && !messages.some((message) => message.streaming)) {
      next.push({ kind: "thinking", label: thinkingLabel });
    }
    return next;
  }, [activities, messages, running, thinkingLabel]);

  return (
    <Virtuoso
      className="timeline virtual-timeline"
      data={entries}
      followOutput={(atBottom) => atBottom ? "smooth" : false}
      increaseViewportBy={{ top: 500, bottom: 800 }}
      itemContent={(_, entry) => {
        if (entry.kind === "message") return <MessageRow message={entry.value} />;
        if (entry.kind === "activity") return <ActivityRow activity={entry.value} />;
        return <div className="thinking-row"><LoaderCircle className="spin" size={15} /> {entry.label}</div>;
      }}
    />
  );
}
