import { Children, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Clipboard, FileCode2, Pencil, Sparkles, TerminalSquare, UsersRound } from "lucide-react";
import Markdown from "react-markdown";
import { Virtuoso } from "react-virtuoso";
import remarkGfm from "remark-gfm";
import type { Activity, ChatMessage } from "../types";

type TimelineEntry =
  | { kind: "message"; value: ChatMessage }
  | { kind: "activity"; value: Activity }
  | { kind: "thinking"; label: string };

function entryOrder(entry: TimelineEntry): number {
  return entry.kind === "thinking" ? Number.MAX_SAFE_INTEGER : entry.value.timelineOrder ?? Number.MAX_SAFE_INTEGER;
}

export function orderedTimelineEntries(messages: ChatMessage[], activities: Activity[]): TimelineEntry[] {
  // Messages and activities each arrive in ascending timelineOrder, so a
  // linear two-pointer merge replaces an O(n log n) sort on every delta flush.
  // If either input turns out unsorted, fall back to a full sort.
  const entries: TimelineEntry[] = [];
  let sorted = true;
  let messageIndex = 0;
  let activityIndex = 0;
  let previousOrder = Number.MIN_SAFE_INTEGER;
  while (messageIndex < messages.length || activityIndex < activities.length) {
    const messageOrder = messageIndex < messages.length ? messages[messageIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    const activityOrder = activityIndex < activities.length ? activities[activityIndex].timelineOrder ?? Number.MAX_SAFE_INTEGER : Infinity;
    let next: TimelineEntry;
    if (messageOrder <= activityOrder) {
      next = { kind: "message", value: messages[messageIndex] };
      messageIndex += 1;
    } else {
      next = { kind: "activity", value: activities[activityIndex] };
      activityIndex += 1;
    }
    const order = entryOrder(next);
    if (order < previousOrder) sorted = false;
    previousOrder = Math.max(previousOrder, order);
    entries.push(next);
  }
  return sorted ? entries : entries.sort((left, right) => entryOrder(left) - entryOrder(right));
}

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

const MessageRow = memo(function MessageRow({ message, onEdit }: { message: ChatMessage; onEdit?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">
        {message.role === "assistant" ? <Sparkles size={14} /> : <span>You</span>}
      </div>
      <div className="message-body">
        {!message.streaming && (
          <div className="message-actions">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.text);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
              title="Copy message"
            >
              {copied ? <Check size={11} /> : <Clipboard size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
            {message.role === "user" && onEdit && (
              <button onClick={() => onEdit(message.text)} title="Put this message back in the composer to edit and resend">
                <Pencil size={11} />
                Edit
              </button>
            )}
          </div>
        )}
        {message.streaming ? (
          // Re-parsing Markdown over the whole accumulated text on every delta
          // flush is O(length) per frame; stream as plain text and parse once
          // on completion instead.
          <div className="message-text plain-stream">{message.text}</div>
        ) : (
          <div className="message-text rich-markdown">
            <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodePre }}>{message.text}</Markdown>
          </div>
        )}
        {message.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
});

export const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const [expanded, setExpanded] = useState(false);
  if (activity.kind === "reasoning") {
    return <ReasoningDisclosure detail={activity.detail ?? ""} inProgress={activity.status === "inProgress"} />;
  }

  const expandable = Boolean(activity.detail) && activity.kind === "command";
  const Icon = activity.kind === "command"
    ? TerminalSquare
    : activity.kind === "file"
      ? FileCode2
      : activity.kind === "agent"
        ? UsersRound
        : Sparkles;
  return (
    <div className={`activity-row ${activity.kind === "command" ? "command-activity" : ""} ${expanded ? "expanded" : "collapsed"}`}>
      <div className={`activity-icon ${activity.kind}`}><Icon size={14} /></div>
      <div className="activity-copy">
        {expandable ? (
          <button
            className="activity-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <ChevronRight className="activity-chevron" size={12} />
            <span>{activity.title}</span>
          </button>
        ) : <span>{activity.title}</span>}
        {activity.detail && (!expandable || expanded) && <pre>{activity.detail.slice(-1200)}</pre>}
      </div>
      {activity.status && <small>{activity.status}</small>}
    </div>
  );
});

export const ReasoningDisclosure = memo(function ReasoningDisclosure({
  detail,
  inProgress,
  label,
}: {
  detail: string;
  inProgress: boolean;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`reasoning-disclosure ${expanded ? "expanded" : "collapsed"} ${inProgress ? "active" : "complete"}`}>
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} thinking`}
      >
        <ChevronRight className="reasoning-chevron" size={13} />
        <span>{label || "Thinking"}</span>
        {inProgress && <i className="reasoning-live-dot" aria-label="Thinking in progress" />}
      </button>
      <div className="reasoning-panel" aria-hidden={!expanded}>
        <div className="reasoning-panel-inner">
          {/* The panel is only materialized when open: reasoning deltas stream
              constantly, and parsing Markdown per frame for a collapsed panel
              is the single largest hidden CPU cost during a turn. While the
              stream is live the text renders plain; Markdown renders once the
              item completes. */}
          {expanded && (
            <div className="reasoning-text rich-markdown">
              {inProgress
                ? <div className="plain-stream">{detail || "Waiting for the model’s thoughts…"}</div>
                : <Markdown remarkPlugins={[remarkGfm]}>{detail || "Waiting for the model’s thoughts…"}</Markdown>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function TimelineFooter() {
  return <div className="timeline-bottom-space" aria-hidden="true" />;
}

const VIRTUOSO_COMPONENTS = { Footer: TimelineFooter };

export function ChatTimeline({
  messages,
  activities,
  running,
  thinkingLabel,
  onEditMessage,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  running: boolean;
  thinkingLabel: string;
  onEditMessage?: (text: string) => void;
}) {
  const entries = useMemo<TimelineEntry[]>(() => {
    const next = orderedTimelineEntries(messages, activities);
    if (running && !messages.some((message) => message.streaming) && !activities.some((activity) => activity.kind === "reasoning" && activity.status === "inProgress")) {
      next.push({ kind: "thinking", label: thinkingLabel });
    }
    return next;
  }, [activities, messages, running, thinkingLabel]);

  return (
    <Virtuoso
      className="timeline virtual-timeline"
      data={entries}
      components={VIRTUOSO_COMPONENTS}
      followOutput={(atBottom) => atBottom ? "smooth" : false}
      increaseViewportBy={{ top: 500, bottom: 800 }}
      computeItemKey={(index, entry) => entry.kind === "thinking" ? `thinking-${index}` : `${entry.kind}-${entry.value.id}`}
      itemContent={(_, entry) => {
        if (entry.kind === "message") {
          return <div className="timeline-entry"><MessageRow message={entry.value} onEdit={onEditMessage} /></div>;
        }
        if (entry.kind === "activity") {
          return <div className="timeline-entry"><ActivityRow activity={entry.value} /></div>;
        }
        return (
          <div className="timeline-entry">
            <ReasoningDisclosure detail="" inProgress label={entry.label} />
          </div>
        );
      }}
    />
  );
}
