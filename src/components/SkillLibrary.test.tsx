import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillLibrary } from "./SkillLibrary";

const skill = {
  path: "/skills/review.md",
  relativePath: "review.md",
  fileName: "review.md",
  defaultName: "review",
  name: "review",
  description: "Review code for correctness.",
  supportingMarkdownCount: 1,
  enabled: true,
};

describe("SkillLibrary", () => {
  it("shows the existing filename-derived invocation name and app-only rename control", () => {
    const onRename = vi.fn(() => true);
    render(<SkillLibrary
      folder="/skills"
      skills={[skill]}
      busy={false}
      error=""
      onChooseFolder={vi.fn()}
      onRefresh={vi.fn()}
      onImport={vi.fn()}
      onCreate={vi.fn(async () => true)}
      onRename={onRename}
      onToggle={vi.fn()}
    />);

    expect(screen.getByText("$review")).toBeInTheDocument();
    expect(screen.getByText(/1 supporting Markdown file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename review" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Invocation name for review.md" }), { target: { value: "careful-review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill name" }));
    expect(onRename).toHaveBeenCalledWith("/skills/review.md", "careful-review");
  });

  it("toggles a skill without changing its source file", () => {
    const onToggle = vi.fn();
    render(<SkillLibrary
      folder="/skills"
      skills={[skill]}
      busy={false}
      error=""
      onChooseFolder={vi.fn()}
      onRefresh={vi.fn()}
      onImport={vi.fn()}
      onCreate={vi.fn(async () => true)}
      onRename={vi.fn(() => true)}
      onToggle={onToggle}
    />);
    fireEvent.click(screen.getByRole("switch", { name: "Disable review" }));
    expect(onToggle).toHaveBeenCalledWith("/skills/review.md");
  });
});
