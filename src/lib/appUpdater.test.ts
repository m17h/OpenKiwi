import { describe, expect, it } from "vitest";
import { updateProgress } from "./appUpdater";

describe("updateProgress", () => {
  it("returns a bounded whole-number percentage", () => {
    expect(updateProgress(25, 100)).toBe(25);
    expect(updateProgress(150, 100)).toBe(100);
    expect(updateProgress(-10, 100)).toBe(0);
  });

  it("returns null when the download size is unknown", () => {
    expect(updateProgress(10, null)).toBeNull();
    expect(updateProgress(10, 0)).toBeNull();
  });
});
