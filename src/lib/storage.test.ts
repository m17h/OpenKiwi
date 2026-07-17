import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { hydrateNativeStorage, loadStored, storeValue } from "./storage";

describe("durable storage", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
  });

  it("hydrates local state from the native database", async () => {
    invoke.mockResolvedValueOnce({ theme: "kiwi" });
    await hydrateNativeStorage(["kiwi.settings"]);
    expect(loadStored("kiwi.settings", {})).toEqual({ theme: "kiwi" });
  });

  it("migrates legacy localStorage when SQLite is empty", async () => {
    localStorage.setItem("kiwi.projects", JSON.stringify([{ id: "one" }]));
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    await hydrateNativeStorage(["kiwi.projects"]);
    expect(invoke).toHaveBeenLastCalledWith("state_write", {
      key: "kiwi.projects",
      value: [{ id: "one" }],
    });
  });

  it("writes both the immediate cache and durable store", () => {
    invoke.mockResolvedValue(undefined);
    storeValue("kiwi.workspaceMode", "projects");
    expect(localStorage.getItem("kiwi.workspaceMode")).toBe('"projects"');
    expect(invoke).toHaveBeenCalledWith("state_write", {
      key: "kiwi.workspaceMode",
      value: "projects",
    });
  });
});
