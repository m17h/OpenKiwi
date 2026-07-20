/** Compact relative timestamp for sidebar rows: "now", "5m", "3h", "4d", then a date. */
export function timeAgo(unixSeconds: number, nowMs = Date.now()): string {
  if (!unixSeconds || unixSeconds <= 0) return "";
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const then = new Date(unixSeconds * 1000);
  const sameYear = then.getFullYear() === new Date(nowMs).getFullYear();
  return then.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}
