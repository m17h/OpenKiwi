import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPowerControl } from "./ModelPowerControl";

describe("ModelPowerControl", () => {
  it("selects models, reasoning, Fast, and Ultra independently", () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    const onFast = vi.fn();
    const onUltra = vi.fn();
    render(<ModelPowerControl model="gpt-5.6-sol" effort="medium" ultra={false} fast={false} runtimeModels={[]} onModel={onModel} onEffort={onEffort} onFast={onFast} onUltra={onUltra} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI model: Sol/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Luna/i }));
    expect(onModel).toHaveBeenCalledWith("gpt-5.6-luna");
    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });
    expect(onEffort).toHaveBeenCalledWith("xhigh");
    fireEvent.click(screen.getByRole("button", { name: /Fast/i }));
    expect(onFast).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: /Ultra/i }));
    expect(onUltra).toHaveBeenCalledWith(true);
  });
});
