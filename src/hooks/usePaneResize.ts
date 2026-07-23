import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadStored, storeValue } from "../lib/storage";

export interface PaneSizes {
  sidebar: number;
  dock: number;
}

const DEFAULT_PANE_SIZES: PaneSizes = { sidebar: 260, dock: 430 };

function clampPaneSize(pane: keyof PaneSizes, value: number): number {
  return pane === "sidebar"
    ? Math.min(420, Math.max(230, value))
    : Math.min(680, Math.max(340, value));
}

export function usePaneResize(uiScale: number) {
  const [paneSizes, setPaneSizes] = useState<PaneSizes>(() =>
    loadStored("kiwi.paneSizes", DEFAULT_PANE_SIZES),
  );
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;

  const startPaneResize = useCallback(
    (pane: keyof PaneSizes) => (event: ReactPointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startSize = paneSizesRef.current[pane];

      const onMove = (moveEvent: PointerEvent) => {
        // Pointer coordinates are screen pixels while pane widths live inside
        // the scaled container, so unscale the movement delta.
        const delta = (moveEvent.clientX - startX) / uiScaleRef.current;
        const nextSize = clampPaneSize(
          pane,
          pane === "sidebar" ? startSize + delta : startSize - delta,
        );
        setPaneSizes((current) => {
          if (current[pane] === nextSize) return current;
          const next = { ...current, [pane]: nextSize };
          paneSizesRef.current = next;
          return next;
        });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        storeValue("kiwi.paneSizes", paneSizesRef.current);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  return { paneSizes, startPaneResize };
}
