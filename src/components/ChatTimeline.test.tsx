import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityRow, orderedTimelineEntries } from "./ChatTimeline";

describe("ChatTimeline", () => {
  it("places command activity between the messages that surround it", () => {
    const entries = orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Check it", timelineOrder: 1 },
        { id: "assistant", role: "assistant", text: "Done", timelineOrder: 3 },
      ],
      [{ id: "command", kind: "command", title: "git status", detail: "clean", timelineOrder: 2 }],
    );

    expect(entries.map((entry) => entry.kind === "thinking" ? "thinking" : entry.value.id))
      .toEqual(["user", "command", "assistant"]);
  });

  it("keeps command output collapsed until the user opens it", () => {
    render(<ActivityRow activity={{ id: "command", kind: "command", title: "git status", detail: "working tree clean", status: "completed" }} />);

    const toggle = screen.getByRole("button", { name: "git status" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("working tree clean")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("working tree clean")).toBeInTheDocument();
  });
});
