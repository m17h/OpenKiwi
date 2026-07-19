import { describe, expect, it } from "vitest";
import { timelineFromTurns } from "./threadTimeline";

describe("timelineFromTurns", () => {
  it("preserves message and command chronology when a thread is resumed", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "inspect it" }] },
      { id: "command", type: "commandExecution", command: "git status", aggregatedOutput: "clean", status: "completed" },
      { id: "assistant", type: "agentMessage", text: "Everything is clean." },
    ] }]);

    expect(snapshot.messages.map((message) => [message.id, message.timelineOrder])).toEqual([
      ["user", 1],
      ["assistant", 3],
    ]);
    expect(snapshot.activities.map((activity) => [activity.id, activity.timelineOrder])).toEqual([["command", 2]]);
  });

  it("restores model thinking as a collapsed reasoning activity", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "reasoning", type: "reasoning", summary: ["Summary"], content: ["Detailed thinking"] },
      { id: "assistant", type: "agentMessage", text: "Answer" },
    ] }]);

    expect(snapshot.activities[0]).toMatchObject({
      id: "reasoning",
      kind: "reasoning",
      title: "Model thinking",
      detail: "Detailed thinking",
      status: "completed",
    });
  });
});
