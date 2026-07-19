import { loadStored, storeValue } from "./storage";

export interface CostEntry {
  threadId: string;
  projectPath: string;
  cost: number;
  day: string;
  updatedAt: number;
}

const LEDGER_KEY = "kiwi.costLedger";
const MAX_ENTRIES = 500;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Stores each thread's cumulative OpenRouter cost estimate so the Usage tab
 * can show spend across threads, not just the open one. One entry per thread,
 * bounded, keyed to the day it was last updated.
 */
export function recordThreadCost(threadId: string, projectPath: string, cost: number): void {
  if (!threadId || !Number.isFinite(cost) || cost <= 0) return;
  const ledger = loadStored<CostEntry[]>(LEDGER_KEY, []).filter((entry) => entry.threadId !== threadId);
  ledger.push({ threadId, projectPath, cost, day: today(), updatedAt: Date.now() });
  ledger.sort((left, right) => right.updatedAt - left.updatedAt);
  storeValue(LEDGER_KEY, ledger.slice(0, MAX_ENTRIES));
}

export function costTotals(projectPath?: string): { today: number; project: number } {
  const ledger = loadStored<CostEntry[]>(LEDGER_KEY, []);
  const day = today();
  let todayTotal = 0;
  let projectTotal = 0;
  for (const entry of ledger) {
    if (entry.day === day) todayTotal += entry.cost;
    if (projectPath && entry.projectPath === projectPath) projectTotal += entry.cost;
  }
  return { today: todayTotal, project: projectTotal };
}

export function formatCost(value: number): string {
  if (value <= 0) return "$0";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}
