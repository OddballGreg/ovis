/**
 * herdr's own agent sidebar in Ovis' Importance order (OVIS_HERDR_PRIO_SYNC=1; herdr's plugin
 * env file may set it under its old name, server/legacy-env.ts). Each pane gets two tokens through
 * `pane.report_metadata`: `prio`, its opencode-memory band (P2 where memory says nothing), and
 * `rank`, its 1-based place in the order, zero padded, which an agent view sorts on
 * (`agent.view.set` with `sort: [{ field: { token: "rank" } }]`). The order is the Agents list's
 * (shared/importance-order.ts) with the shared aging settings, read from this server's snapshot.
 *
 * herdr keeps one token map per pane, whoever reports: a token named twice is the last report's,
 * a clear or an expiry removes it whatever source set it, and an agent view sorts on the name
 * alone (live-verified on herdr 0.9.3). So the reports carry this server's own source,
 * PRIO_SOURCE, and the view may belong to any source. The tokens live TOKEN_TTL_MS: a pane is
 * reported again when its tokens change and at least every REREPORT_MS, so they never lapse while
 * this server runs, and leave by themselves once it stops.
 */
import type { AgentStatus, HerdrPane, ImportanceLevel, SessionSnapshot } from "../shared/protocol.ts";
import { importanceOrder, NEUTRAL_LEVEL, type ImportanceAging } from "../shared/importance-order.ts";

export const PRIO_SOURCE = "ovis:herdr-prio";
export const TOKEN_TTL_MS = 180_000;
/** a pane whose tokens did not change is reported again after this long, well inside the TTL */
export const REREPORT_MS = 60_000;
/** a pass runs at least this often, changes or none */
export const PASS_MS = 30_000;
/** a change waits this long for the ones that come with it */
export const SETTLE_MS = 1_500;

export type PrioTokens = { prio: ImportanceLevel; rank: string };
export interface PrioReport { pane_id: string; source: string; tokens: PrioTokens; ttl_ms: number }

/** Whether the sync is on: OVIS_HERDR_PRIO_SYNC (or its old name, through server/legacy-env.ts) set to 1, true, yes or on. */
export function prioSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env["OVIS_HERDR_PRIO_SYNC"]?.trim() ?? "");
}

const nonblank = (value: string | null | undefined): boolean => Boolean(value?.trim());

/**
 * The status a row ranks by, as the Agents list draws it: one at rest waiting on its turn's
 * background work is BG, which ranks with working. A seen finish draws as ready, which ranks as done.
 */
function rowStatus(pane: Pick<HerdrPane, "agent_status" | "background_wait">): AgentStatus {
  const status = pane.agent_status;
  return pane.background_wait && status !== "working" && status !== "blocked" ? "waiting" : status;
}

/** How long the pane has waited in its state by the server's clock (src/lib/agentRoster.ts paneWaitMs). */
function waitMs(pane: Pick<HerdrPane, "agent_status" | "wait">, now: number): number | undefined {
  const wait = pane.wait;
  if (wait === undefined || !Number.isFinite(wait.since)) return undefined;
  return wait.status === pane.agent_status ? Math.max(0, now - wait.since) : 0;
}

/**
 * The agent panes of a snapshot in the Agents list's source order (src/lib/sidebarAgents.ts):
 * workspace, then tab, then pane order; a pane counts when herdr lists an agent on it or the
 * server named one.
 */
function agentPanes(snapshot: SessionSnapshot): HerdrPane[] {
  const listed = new Set(snapshot.agents.map((agent) => agent.pane_id));
  const workspaceOrder = new Map(snapshot.workspaces.map((workspace, index) => [workspace.workspace_id, index]));
  const tabOrder = new Map(snapshot.tabs.map((tab, index) => [tab.tab_id, index]));
  const seen = new Set<string>();
  const rows: { pane: HerdrPane; order: number }[] = [];
  snapshot.panes.forEach((pane, order) => {
    if (seen.has(pane.pane_id)) return;
    seen.add(pane.pane_id);
    if (!workspaceOrder.has(pane.workspace_id) || (!listed.has(pane.pane_id) && !nonblank(pane.agent))) return;
    rows.push({ pane, order });
  });
  return rows.sort((a, b) => workspaceOrder.get(a.pane.workspace_id)! - workspaceOrder.get(b.pane.workspace_id)!
    || (tabOrder.get(a.pane.tab_id) ?? snapshot.tabs.length) - (tabOrder.get(b.pane.tab_id) ?? snapshot.tabs.length)
    || a.order - b.order).map((row) => row.pane);
}

/** Every agent pane's tokens, in Importance order. */
export function prioTokens(snapshot: SessionSnapshot, aging: ImportanceAging, now: number): { pane_id: string; tokens: PrioTokens }[] {
  const seqs = new Map<string, number>();
  for (const agent of snapshot.agents) {
    if (agent.state_change_seq !== undefined && Number.isFinite(agent.state_change_seq)) seqs.set(agent.pane_id, agent.state_change_seq);
  }
  const ordered = importanceOrder(agentPanes(snapshot), (pane) => pane, rowStatus, seqs, {
    importanceOf: (pane) => pane.importance?.level,
    waitOf: (pane) => waitMs(pane, now),
    aging,
  });
  return ordered.map((pane, index) => ({ pane_id: pane.pane_id, tokens: { prio: pane.importance?.level ?? NEUTRAL_LEVEL, rank: String(index + 1).padStart(4, "0") } }));
}

export interface HerdrPrioSyncDeps {
  /** the snapshot browsers get, waits and importance in it */
  snapshot: () => Promise<SessionSnapshot>;
  /** the shared Importance aging settings, read at each pass */
  aging: () => ImportanceAging;
  /** one pane.report_metadata call */
  report: (params: PrioReport) => Promise<unknown>;
  now?: () => number;
  passMs?: number;
  settleMs?: number;
  rereportMs?: number;
  log?: (line: string) => void;
}

export class HerdrPrioSync {
  private readonly now: () => number;
  private readonly passMs: number;
  private readonly settleMs: number;
  private readonly rereportMs: number;
  /** what each pane was last given, and when */
  private readonly reported = new Map<string, { key: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /** stop() was called: nothing more is reported */
  private stopped = false;
  /** why the last pass failed, said once until a pass works again */
  private down: string | null = null;
  /** the first pass that worked was said */
  private announced = false;

  constructor(private readonly deps: HerdrPrioSyncDeps) {
    this.now = deps.now ?? Date.now;
    this.passMs = deps.passMs ?? PASS_MS;
    this.settleMs = deps.settleMs ?? SETTLE_MS;
    this.rereportMs = deps.rereportMs ?? REREPORT_MS;
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.sync(); }, this.passMs);
    this.timer.unref?.();
    this.nudge();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.settle !== null) clearTimeout(this.settle);
    this.timer = null;
    this.settle = null;
  }

  /** Something the order reads changed: a pass runs once the changes that come with it are in. */
  nudge(): void {
    if (this.stopped || this.settle !== null) return;
    this.settle = setTimeout(() => { this.settle = null; void this.sync(); }, this.settleMs);
    this.settle.unref?.();
  }

  /** One pass; a call while one runs makes it run once more after. Never rejects. */
  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) { this.again = false; void this.sync(); }
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    let rows: { pane_id: string; tokens: PrioTokens }[];
    try {
      rows = prioTokens(await this.deps.snapshot(), this.deps.aging(), this.now());
    } catch (error) {
      this.fail(`the snapshot was not read (${describe(error)})`);
      return;
    }
    const open = new Set(rows.map((row) => row.pane_id));
    // an empty read (herdr restarting) is not every pane closing
    if (rows.length > 0) for (const paneId of [...this.reported.keys()]) if (!open.has(paneId)) this.reported.delete(paneId);
    let failed: string | null = null;
    for (const { pane_id, tokens } of rows) {
      if (this.stopped) return;
      const key = `${tokens.prio}|${tokens.rank}`;
      const last = this.reported.get(pane_id);
      const now = this.now();
      if (last?.key === key && now - last.at < this.rereportMs) continue;
      try {
        await this.deps.report({ pane_id, source: PRIO_SOURCE, tokens, ttl_ms: TOKEN_TTL_MS });
        this.reported.set(pane_id, { key, at: now });
      } catch (error) {
        this.reported.delete(pane_id);
        failed ??= `${pane_id} was not reported (${describe(error)})`;
      }
    }
    if (failed !== null) { this.fail(failed); return; }
    if (this.down !== null) this.deps.log?.("herdr prio sync: herdr takes the sidebar order again");
    else if (!this.announced) this.deps.log?.(`herdr prio sync: herdr's sidebar follows Importance order, ${rows.length} panes reported as ${PRIO_SOURCE}`);
    this.announced = true;
    this.down = null;
  }

  private fail(why: string): void {
    if (this.down === null) this.deps.log?.(`herdr prio sync: ${why}; trying again at the next pass`);
    this.down = why;
  }
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
