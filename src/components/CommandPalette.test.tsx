import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const baseProps = {
  open: true,
  projects: [],
  threads: [],
  onClose: vi.fn(),
  onProject: vi.fn(),
  onThread: vi.fn(),
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
});
