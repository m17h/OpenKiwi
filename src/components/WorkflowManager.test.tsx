import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition } from "../lib/workflows";
import { WorkflowManager } from "./WorkflowManager";

const project = { id: "project-1", name: "OpenKiwi", path: "/tmp/openkiwi" };

describe("WorkflowManager", () => {
  it("creates a transparent agent workflow with a runtime snapshot", () => {
    const onWorkflows = vi.fn();
    render(
      <WorkflowManager
        workflows={[]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={onWorkflows}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByPlaceholderText("Release readiness"), { target: { value: "Release readiness" } });
    fireEvent.change(screen.getByPlaceholderText("Tell the agent exactly what to accomplish and how to verify it."), {
      target: { value: "Run the tests and summarize any failures." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));

    expect(onWorkflows).toHaveBeenCalledOnce();
    const created = onWorkflows.mock.calls[0][0][0];
    expect(created).toMatchObject({
      name: "Release readiness",
      projectId: "project-1",
      trigger: { type: "manual" },
      run: { provider: DEFAULT_SETTINGS.provider, model: DEFAULT_SETTINGS.model },
    });
    expect(created.steps[0]).toMatchObject({
      type: "agent",
      prompt: "Run the tests and summarize any failures.",
    });
  });

  it("shows validation errors without saving an incomplete recipe", () => {
    const onWorkflows = vi.fn();
    render(
      <WorkflowManager
        workflows={[]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={onWorkflows}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(screen.getByText("Give the workflow a name.")).toBeInTheDocument();
    expect(onWorkflows).not.toHaveBeenCalled();
  });

  it("collects prompted variables before a manual run", () => {
    const onRun = vi.fn();
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Release",
      description: "Prepare a release.",
      projectId: project.id,
      enabled: true,
      trigger: { type: "manual" },
      variables: [{ id: "variable-1", name: "branch", value: "main", promptOnRun: true }],
      steps: [{ id: "step-1", type: "command", name: "Check", command: "git status", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <WorkflowManager
        workflows={[workflow]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={vi.fn()}
        onRun={onRun}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.change(screen.getByRole("textbox", { name: "branch" }), { target: { value: "release/next" } });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(onRun).toHaveBeenCalledWith("workflow-1", { branch: "release/next" });
  });
});
