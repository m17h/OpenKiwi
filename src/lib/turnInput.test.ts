import { describe, expect, it } from "vitest";
import { buildTurnInput, withoutSentAttachments } from "./turnInput";

describe("turn input", () => {
  it("includes files and images when steering or starting a turn", () => {
    expect(buildTurnInput("Review these", [
      { path: "/project/notes.md", kind: "file" },
      { path: "/tmp/screenshot.png", kind: "image" },
    ])).toEqual([
      {
        type: "text",
        text: "Review these\n\nAttached context:\n@/project/notes.md",
        text_elements: [],
      },
      { type: "localImage", path: "/tmp/screenshot.png", detail: "auto" },
    ]);
  });

  it("clears sent attachments without removing ones added while sending", () => {
    const sent = [{ path: "/tmp/first.png", kind: "image" as const }];
    const current = [...sent, { path: "/tmp/new.png", kind: "image" as const }];
    expect(withoutSentAttachments(current, sent)).toEqual([{ path: "/tmp/new.png", kind: "image" }]);
  });
});
