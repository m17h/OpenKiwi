import { act, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { usePaneResize } from "./usePaneResize";

describe("usePaneResize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores, scales, clamps, and persists pane sizes", () => {
    localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 300, dock: 500 }));
    const { result } = renderHook(() => usePaneResize(2));
    const preventDefault = vi.fn();

    act(() => {
      result.current.startPaneResize("sidebar")({
        clientX: 100,
        preventDefault,
      } as unknown as ReactPointerEvent);
    });
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.paneSizes).toEqual({ sidebar: 350, dock: 500 });
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}")).toEqual({
      sidebar: 350,
      dock: 500,
    });
  });
});
