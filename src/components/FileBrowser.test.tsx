import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./FileBrowser";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("../lib/codex", () => ({ rpc: rpcMock }));

describe("FileBrowser", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation((method: string, params: { path?: string }) => {
      if (method === "fs/readDirectory" && params.path === "/project") return Promise.resolve({ entries: [
        { fileName: "src", isDirectory: true, isFile: false },
        { fileName: "node_modules", isDirectory: true, isFile: false },
        { fileName: ".git", isDirectory: true, isFile: false },
        { fileName: "README.md", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readDirectory" && params.path === "/project/src") return Promise.resolve({ entries: [
        { fileName: "main.ts", isDirectory: false, isFile: true },
      ] });
      if (method === "fs/readFile") return Promise.resolve({ dataBase64: btoa("hello") });
      return Promise.resolve({ files: [] });
    });
  });

  it("hides generated folders by default and reveals them on request", async () => {
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "src" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "node_modules" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show generated and ignored folders" }));
    expect(screen.getByRole("button", { name: "node_modules" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ".git" })).toBeInTheDocument();
  });

  it("navigates into folders, updates breadcrumbs, and returns to the project root", async () => {
    render(<FileBrowser root="/project" onAttach={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "main.ts" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Current project folder" })).toHaveTextContent("projectsrc");
    expect(rpcMock).toHaveBeenCalledWith("fs/readDirectory", { path: "/project/src" });
    fireEvent.click(screen.getByTitle("/project"));
    await waitFor(() => expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument());
  });
});
