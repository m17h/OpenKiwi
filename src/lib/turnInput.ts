import type { JsonObject } from "./codex";

export interface TurnAttachment {
  path: string;
  kind: "image" | "file";
}

/** Build the identical input payload for a new turn and a mid-turn steer. */
export function buildTurnInput(text: string, attachments: TurnAttachment[]): JsonObject[] {
  const fileContext = attachments
    .filter((item) => item.kind === "file")
    .map((item) => `@${item.path}`)
    .join("\n");

  return [
    {
      type: "text",
      text: fileContext ? `${text}\n\nAttached context:\n${fileContext}` : text,
      text_elements: [],
    },
    ...attachments
      .filter((item) => item.kind === "image")
      .map((item) => ({ type: "localImage", path: item.path, detail: "auto" })),
  ];
}

/** Clear only attachments that were actually sent, preserving anything added in flight. */
export function withoutSentAttachments<T extends TurnAttachment>(current: T[], sent: TurnAttachment[]): T[] {
  const sentPaths = new Set(sent.map((item) => item.path));
  return current.filter((item) => !sentPaths.has(item.path));
}
