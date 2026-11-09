/**
 * Importance order, shared by the Agents list (src/lib/sidebarOrder.ts) and the herdr sidebar
 * sync (server/herdr-prio-sync.ts), so the browser and herdr's own sidebar order the agents alike.
 */
import type { AgentStatus, ImportanceLevel, PaneInfo } from "./protocol.ts";

/**
 * Importance order's aging: minutes a P1, P2 or P3 agent waits before it goes first in its band, and how many times
 * that wait lifts it into its group's most urgent band, P1 at most, so nothing passes a P0. P0 has no wait to
 * serve: it goes by longest wait at once.
 */
export interface ImportanceAging { p1: number; p2: number; p3: number; factor: number }
export const DEFAULT_IMPORTANCE_AGING: ImportanceAging = { p1: 15, p2: 30, p3: 60, factor: 4 };
const IMPORTANCE_AGING_MAX_MINUTES = 24 * 60;
const IMPORTANCE_AGING_MAX_FACTOR = 20;

export function sanitizeImportanceAging(raw: unknown): ImportanceAging {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const within = (value: unknown, max: number, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(max, Math.round(value)) : fallback;
  return {
    p1: within(record["p1"], IMPORTANCE_AGING_MAX_MINUTES, DEFAULT_IMPORTANCE_AGING.p1),
    p2: within(record["p2"], IMPORTANCE_AGING_MAX_MINUTES, DEFAULT_IMPORTANCE_AGING.p2),
    p3: within(record["p3"], IMPORTANCE_AGING_MAX_MINUTES, DEFAULT_IMPORTANCE_AGING.p3),
    factor: within(record["factor"], IMPORTANCE_AGING_MAX_FACTOR, DEFAULT_IMPORTANCE_AGING.factor),
  };
}

/**
 * Longest wait's ranks: blocked, then unread and ready (one rank), then working (BG counts as
 * working); any other status after them. Unread and ready are not told apart for order because a
 * herdr restart turns unread finishes into ready ones without anyone opening them.
 */
const WAIT_RANK: Readonly<Record<string, number>> = { blocked: 0, done: 1, idle: 1, working: 2, waiting: 2 };
const UNKNOWN_RANK = 3;
export function waitRank(status: AgentStatus | undefined): number {
  return status !== undefined && Object.hasOwn(WAIT_RANK, status) ? WAIT_RANK[status]! : UNKNOWN_RANK;
}

const BAND: Readonly<Record<ImportanceLevel, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
/** P4: a session parked by hand, which never ages and is never lifted */
const PARKED_BAND = 4;
/** whether a row's level parks it (src/lib/agentRoster.ts folds those rows into their own group) */
export const isParked = (level: ImportanceLevel | undefined): boolean => level !== undefined && BAND[level] === PARKED_BAND;
/** what a row memory said nothing of counts as */
export const NEUTRAL_LEVEL: ImportanceLevel = "P2";
/** the least urgent band, where a group's top band starts before its rows are read */
const LAST_BAND = 3;

/**
 * A band's aging threshold in ms. P0 has none to wait out: a P0 with a known wait counts as aged
 * at once, so the P0 rows are ordered by longest wait, as every band ages in the objective
 * driver's order.
 */
export function agingThresholdMs(band: number, aging: ImportanceAging): number {
  return band === 1 ? aging.p1 * 60_000 : band === 2 ? aging.p2 * 60_000 : band === 3 ? aging.p3 * 60_000 : 0;
}

/** What Importance order makes of one row: its band, the band it competes in, and whether it has aged. */
export interface ImportanceFacts { band: number; effectiveBand: number; aged: boolean; promoted: boolean; wait: number | undefined }

/** The most urgent band a waiting row can be lifted into is P1, so no wait passes a P0. */
const LIFT_CEILING = 1;

/**
 * A row's facts against `topBand`, the most urgent band in its status group (drive_order_key's
 * `top_band`). A row lifted for its wait competes in `topBand`, or in P1 when `topBand` is P0.
 */
export function importanceFacts(level: ImportanceLevel | undefined, wait: number | undefined, aging: ImportanceAging, topBand: number): ImportanceFacts {
  const band = BAND[level ?? NEUTRAL_LEVEL];
  if (band === PARKED_BAND) return { band, effectiveBand: band, aged: false, promoted: false, wait };
  const threshold = agingThresholdMs(band, aging);
  const aged = wait !== undefined && wait > threshold;
  const target = Math.max(topBand, LIFT_CEILING);
  const promoted = aged && wait > Math.max(1, aging.factor) * threshold && target < band;
  return { band, effectiveBand: promoted ? target : band, aged, promoted, wait };
}

/**
 * Importance: Longest wait's groups (blocked, unread and ready, working), and in each the
 * opencode-memory band first (P0 before P3; none known counts as P2), modelled on the objective
 * driver's order (opencode-memory analysis/objective_loop.py drive_order_key). Within a band a row
 * that has waited past its band's threshold goes first, longest wait first (a P0 with a known wait always has); one
 * that waited `factor` times its threshold competes in its group's most urgent band as an aged row,
 * so a P3 is never starved. That band is P1 at most: no wait lifts a row above a P0, so a session
 * marked P0 stays first in its group however long the others have waited.
 * The rest keep Longest wait's order: herdr's oldest state change first, then the order given.
 * A parked row (P4) stands after every other row whatever its status, never ages and is never
 * lifted; the parked rows keep Longest wait's order among themselves.
 */
export function importanceOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id">, statusOf: (row: T) => AgentStatus | undefined, seqs: ReadonlyMap<string, number>,
  options: { importanceOf(row: T): ImportanceLevel | undefined; waitOf(row: T): number | undefined; aging: ImportanceAging }): T[] {
  const entries = rows.map((row, index) => ({
    row, index, rank: waitRank(statusOf(row)), changed: seqs.get(paneOf(row).pane_id) ?? Infinity,
    level: options.importanceOf(row), wait: options.waitOf(row),
  }));
  const top = new Map<number, number>();
  for (const entry of entries) top.set(entry.rank, Math.min(top.get(entry.rank) ?? LAST_BAND, BAND[entry.level ?? NEUTRAL_LEVEL]));
  return entries
    .map((entry) => ({ ...entry, parked: isParked(entry.level) ? 1 : 0, facts: importanceFacts(entry.level, entry.wait, options.aging, top.get(entry.rank) ?? LAST_BAND) }))
    .sort((a, b) => a.parked - b.parked
      || a.rank - b.rank
      || a.facts.effectiveBand - b.facts.effectiveBand
      || (a.facts.aged ? 0 : 1) - (b.facts.aged ? 0 : 1)
      || (a.facts.aged && b.facts.aged ? (b.wait ?? 0) - (a.wait ?? 0) : 0)
      || (a.changed === b.changed ? 0 : a.changed < b.changed ? -1 : 1)
      || a.index - b.index)
    .map((entry) => entry.row);
}
