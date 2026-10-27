/** Activity order uses raw statuses and herdr recency; opened finishes use only bridge finish IDs. */
import type { AgentStatus, HerdrPane, ImportanceLevel, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import type { ImportanceAging } from "./settings.ts";
import { knownStatus, paneStatus, type KnownStatus } from "./status.ts";

export type SeenRecord = Readonly<Record<string, number>>;

export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/** Stand-ins date pushed statuses for ordering only. They never identify a finish. */
export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), real: new Map() });

export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  // Recency only: legacy bridges have no finish_epoch, but a rollback invalidates stand-ins.
  // This never changes acknowledgement records or identifies a finish.
  if ([...seqs].some(([id, seq]) => seq < (memory.real.get(id) ?? seq))) memory.bumped.clear();
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      else memory.bumped.delete(pane.pane_id);
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  memory.real = new Map(seqs);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

type FinishPane = Pick<HerdrPane, "pane_id" | "agent_status" | "finish_id" | "background_wait">;
export function isSeenDone(pane: FinishPane, seen: SeenRecord): boolean {
  return knownStatus(pane.agent_status) === "done" && pane.finish_id !== undefined
    && pane.finish_id > 0 && (seen[pane.pane_id] ?? 0) >= pane.finish_id;
}

export function shownStatus(pane: FinishPane, seen: SeenRecord | null): AgentStatus | undefined {
  if (pane.background_wait) return paneStatus(pane);
  return seen && isSeenDone(pane, seen) ? "idle" : pane.agent_status;
}

/** Blocked first, then herdr's latest state change, then the order given. */
export function activityOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => {
      const pane = paneOf(row);
      return { row, index, rank: knownStatus(pane.agent_status) === "blocked" ? 0 : 1, recent: seqs.get(pane.pane_id) ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}

/** Longest wait's ranks: blocked, a finish not opened yet, ready, then working (BG counts as working). */
const WAIT_RANK: Readonly<Record<KnownStatus, number>> = { blocked: 0, done: 1, idle: 2, working: 3, waiting: 3, unknown: 4 };

/**
 * Longest wait first: blocked, then a finish not opened yet, then ready (a finish already opened
 * counts as ready, as its row draws it), then working; within each, herdr's oldest state change
 * first, then the order given. `statusOf` is the status the row draws (shownStatus), not the raw
 * one. This follows herdr's own agent view sorted by status, then state_change_seq ascending, with
 * two differences: an opened finish counts as ready, and BG (waiting) counts as working.
 */
export function waitingOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id">, statusOf: (row: T) => AgentStatus | undefined, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: WAIT_RANK[knownStatus(statusOf(row))] ?? 4, changed: seqs.get(paneOf(row).pane_id) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || (a.changed === b.changed ? 0 : a.changed < b.changed ? -1 : 1) || a.index - b.index)
    .map((entry) => entry.row);
}

const BAND: Readonly<Record<ImportanceLevel, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };
/** what a row memory said nothing of counts as */
const NEUTRAL: ImportanceLevel = "P2";
/** the least urgent band, where a group's top band starts before its rows are read */
const LAST_BAND = 3;

/**
 * A band's aging threshold in ms. P0 has none to wait out: a P0 with a known wait counts as aged
 * at once, so it and a row lifted into its band are ordered by longest wait, as every band ages in
 * the objective driver's order.
 */
export function agingThresholdMs(band: number, aging: ImportanceAging): number {
  return band === 1 ? aging.p1 * 60_000 : band === 2 ? aging.p2 * 60_000 : band === 3 ? aging.p3 * 60_000 : 0;
}

/** What Importance order makes of one row: its band, the band it competes in, and whether it has aged. */
export interface ImportanceFacts { band: number; effectiveBand: number; aged: boolean; promoted: boolean; wait: number | undefined }

/** A row's facts against `topBand`, the most urgent band in its status group (drive_order_key's `top_band`). */
export function importanceFacts(level: ImportanceLevel | undefined, wait: number | undefined, aging: ImportanceAging, topBand: number): ImportanceFacts {
  const band = BAND[level ?? NEUTRAL];
  const threshold = agingThresholdMs(band, aging);
  const aged = wait !== undefined && wait > threshold;
  const promoted = aged && wait > Math.max(1, aging.factor) * threshold && topBand < band;
  return { band, effectiveBand: promoted ? topBand : band, aged, promoted, wait };
}

/**
 * Importance: Longest wait's groups (blocked, an unread finish, ready, working), and in each the
 * opencode-memory band first (P0 before P3; none known counts as P2), modelled on the objective
 * driver's order (opencode-memory analysis/objective_loop.py drive_order_key). Within a band a row
 * that has waited past its band's threshold goes first, longest wait first (a P0 always has); one
 * that waited `factor` times its threshold competes in its group's most urgent band as an aged row,
 * so a P3 is never starved.
 * The rest keep Longest wait's order: herdr's oldest state change first, then the order given.
 */
export function importanceOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id">, statusOf: (row: T) => AgentStatus | undefined, seqs: ReadonlyMap<string, number>,
  options: { importanceOf(row: T): ImportanceLevel | undefined; waitOf(row: T): number | undefined; aging: ImportanceAging }): T[] {
  const entries = rows.map((row, index) => ({
    row, index, rank: WAIT_RANK[knownStatus(statusOf(row))] ?? 4, changed: seqs.get(paneOf(row).pane_id) ?? Infinity,
    level: options.importanceOf(row), wait: options.waitOf(row),
  }));
  const top = new Map<number, number>();
  for (const entry of entries) top.set(entry.rank, Math.min(top.get(entry.rank) ?? LAST_BAND, BAND[entry.level ?? NEUTRAL]));
  return entries
    .map((entry) => ({ ...entry, facts: importanceFacts(entry.level, entry.wait, options.aging, top.get(entry.rank) ?? LAST_BAND) }))
    .sort((a, b) => a.rank - b.rank
      || a.facts.effectiveBand - b.facts.effectiveBand
      || (a.facts.aged ? 0 : 1) - (b.facts.aged ? 0 : 1)
      || (a.facts.aged && b.facts.aged ? (b.wait ?? 0) - (a.wait ?? 0) : 0)
      || (a.changed === b.changed ? 0 : a.changed < b.changed ? -1 : 1)
      || a.index - b.index)
    .map((entry) => entry.row);
}
