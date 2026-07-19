import { describe, expect, it } from "vitest";
import { buildTranscriptMarkdown } from "./transcript";

describe("transcript export", () => {
  it("orders entries by timeline order and renders roles", () => {
    const markdown = buildTranscriptMarkdown(
      "My thread",
      [
        { id: "m1", role: "user", text: "Question?", timelineOrder: 1 },
        { id: "m2", role: "assistant", text: "Answer.", timelineOrder: 3 },
      ],
      [{ id: "a1", kind: "command", title: "npm test", detail: "ok", status: "completed", timelineOrder: 2 }],
    );
    const userIndex = markdown.indexOf("## You");
    const commandIndex = markdown.indexOf("**command** — npm test");
    const assistantIndex = markdown.indexOf("## Assistant");
    expect(userIndex).toBeGreaterThan(-1);
    expect(commandIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(commandIndex);
    expect(markdown.startsWith("# My thread")).toBe(true);
  });

  it("wraps reasoning in a collapsed details block", () => {
    const markdown = buildTranscriptMarkdown("T", [], [
      { id: "r1", kind: "reasoning", title: "Model thinking", detail: "step by step", timelineOrder: 1 },
    ]);
    expect(markdown).toContain("<details><summary>Model thinking</summary>");
    expect(markdown).toContain("step by step");
  });
});
