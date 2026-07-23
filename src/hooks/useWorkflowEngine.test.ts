import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  auditEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/codex", () => codex);

import { useWorkflowEngine, waitForWorkflowTurn } from "./useWorkflowEngine";

describe("workflow turn waiting", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.useFakeTimers();
    codex.rpc.mockReset();
    codex.auditEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the agent turn completes", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    const pending = waitForWorkflowTurn("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "completed");
    await expect(pending).resolves.toBe("completed");
  });

  it("rejects interrupted turns", async () => {
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    const pending = waitForWorkflowTurn("thread-1");
    useTaskStore.getState().setTaskStatus("thread-1", "interrupted");
    await expect(pending).rejects.toThrow("stopped");
  });

  it("runs deterministic command recipes in a named project thread", async () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Run checks",
      description: "",
      projectId: "project-1",
      enabled: true,
      trigger: { type: "manual" },
      steps: [{
        id: "step-1",
        type: "command",
        name: "Tests",
        command: "npm test",
        continueOnError: false,
      }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    const runs: WorkflowRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "command/exec") return Promise.resolve({ exitCode: 0, stdout: "passed\n", stderr: "" });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useWorkflowEngine({
      workflows: [workflow],
      projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
      runtimeAvailable: true,
      chatGptConnected: true,
      openRouterReady: false,
      customAgents: [],
      ensureSkillRoots: vi.fn(async () => undefined),
      bindThreadToProject: vi.fn(),
      updateWorkflow: vi.fn(),
      recordRun: (run) => {
        const index = runs.findIndex((item) => item.id === run.id);
        if (index >= 0) runs[index] = run;
        else runs.push(run);
      },
      onThreadStarted: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => {
      await result.current.runWorkflow("workflow-1");
    });

    expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({
      command: ["/bin/zsh", "-lc", "npm test"],
      cwd: "/tmp/project",
    }));
    expect(runs.at(-1)).toMatchObject({ status: "completed", threadId: "thread-1", currentStep: 1 });
  });
});
