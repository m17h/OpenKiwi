import { describe, expect, it } from "vitest";
import { timeAgo } from "./timeAgo";

describe("timeAgo", () => {
  const now = Date.UTC(2026, 6, 19, 12, 0, 0);
  const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

  it("formats compact buckets", () => {
    expect(timeAgo(at(10), now)).toBe("now");
    expect(timeAgo(at(5 * 60), now)).toBe("5m");
    expect(timeAgo(at(3 * 3600), now)).toBe("3h");
    expect(timeAgo(at(4 * 86400), now)).toBe("4d");
  });

  it("falls back to a date after a week", () => {
    expect(timeAgo(at(30 * 86400), now)).toMatch(/Jun/);
  });

  it("returns empty for missing timestamps", () => {
    expect(timeAgo(0, now)).toBe("");
  });
});
