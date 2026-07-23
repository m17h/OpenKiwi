import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import { CommandPalette } from "./CommandPalette";

const baseProps = {
  open: true,
  projects: [],
  threads: [],
  workflows: [],
  onClose: vi.fn(),
  onProject: vi.fn(),
  onThread: vi.fn(),
  onWorkflow: vi.fn(),
  onNewThread: vi.fn(),
  onSettings: vi.fn(),
  onTool: vi.fn(),
};

describe("CommandPalette", () => {
  it("exposes direct project tool commands when a project is active", () => {
    const onTool = vi.fn();
    render(<CommandPalette {...baseProps} projectActive onTool={onTool} />);
    fireEvent.click(screen.getByRole("button", { name: /Browse project files/i }));
    expect(onTool).toHaveBeenCalledWith("files");
    expect(screen.getByRole("button", { name: /Open project terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Git workspace/i })).toBeInTheDocument();
  });

  it("does not offer project-only tools during a normal chat", () => {
    render(<CommandPalette {...baseProps} projectActive={false} />);
    expect(screen.queryByRole("button", { name: /Browse project files/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New thread/i })).toBeInTheDocument();
  });

  it("runs enabled workflows directly from search", () => {
    const onWorkflow = vi.fn();
    const workflow = {
      id: "workflow-1",
      name: "Release checks",
      description: "",
      projectId: "project-1",
      enabled: true,
      trigger: { type: "manual" as const },
      steps: [{ id: "step-1", type: "command" as const, name: "Tests", command: "npm test", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    render(<CommandPalette {...baseProps} projectActive workflows={[workflow]} projects={[{ id: "project-1", name: "OpenKiwi", path: "/tmp/openkiwi" }]} onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByRole("button", { name: /Run workflow: Release checks/i }));
    expect(onWorkflow).toHaveBeenCalledWith(workflow);
  });
});
