import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCenter } from "./ApprovalCenter";
import type { PendingApproval } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function approval(method: string, params: PendingApproval["params"]): PendingApproval {
  return { id: 1, method, params, threadId: "thread-1", receivedAt: 1 };
}

describe("ApprovalCenter", () => {
  it("uses the legacy approval vocabulary for legacy requests", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "approved_for_session" });
  });

  it("returns structured answers for agent questions", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("item/tool/requestUserInput", { questions: [{ id: "target", header: "Target", question: "Where?", isOther: false, isSecret: false, options: [{ label: "Web", description: "Browser" }] }] })} onRespond={onRespond} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Web" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRespond).toHaveBeenCalledWith({ answers: { target: { answers: ["Web"] } } });
  });

  it("returns the requested permission profile with session scope", () => {
    const onRespond = vi.fn();
    const permissions = { network: { enabled: true }, fileSystem: null };
    render(<ApprovalCenter approval={approval("item/permissions/requestApproval", { permissions, reason: "Network access" })} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    expect(onRespond).toHaveBeenCalledWith({ permissions, scope: "session" });
  });
});
