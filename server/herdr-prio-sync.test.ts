import { describe, expect, it } from "bun:test";
import type { AgentStatus, ImportanceLevel, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_IMPORTANCE_AGING, sanitizeImportanceAging, type ImportanceAging } from "../shared/importance-order.ts";
import { HerdrPrioSync, PASS_MS, PRIO_SOURCE, prioSyncEnabled, prioTokens, REREPORT_MS, TOKEN_TTL_MS, type PrioReport } from "./herdr-prio-sync.ts";
import { adoptLegacyEnv, legacyName } from "./legacy-env.ts";

const MIN = 60_000;
const NOW = 10_000 * MIN;

/** a row: its id, status, band (undefined: memory said nothing), wait in minutes (undefined: no clock) and herdr's seq */
interface Row { id: string; status: AgentStatus; level?: ImportanceLevel; wait?: number; seq?: number; background?: true; workspace?: string; agent?: boolean }

function snapshotOf(rows: Row[]): SessionSnapshot {
  const workspaces = [...new Set(rows.map((row) => row.workspace ?? "w1"))].map((workspace_id) => ({ workspace_id }));
  return {
    workspaces,
    tabs: workspaces.map(({ workspace_id }) => ({ tab_id: `${workspace_id}:t1`, workspace_id })),
    panes: rows.map((row) => ({
      pane_id: row.id, workspace_id: row.workspace ?? "w1", tab_id: `${row.workspace ?? "w1"}:t1`, agent_status: row.status,
      ...(row.agent === false ? {} : { agent: "opencode" }),
      ...(row.level ? { importance: { level: row.level, source: "queue", reason: "" } } : {}),
      ...(row.wait === undefined ? {} : { wait: { since: NOW - row.wait * MIN, status: row.status } }),
      ...(row.background ? { background_wait: true } : {}),
    })),
    agents: rows.filter((row) => row.agent !== false).map((row) => ({ pane_id: row.id, ...(row.seq === undefined ? {} : { state_change_seq: row.seq }) })),
  } as unknown as SessionSnapshot;
}

const order = (rows: Row[], aging: ImportanceAging = DEFAULT_IMPORTANCE_AGING): string[] => prioTokens(snapshotOf(rows), aging, NOW).map((row) => row.pane_id);

describe("herdr's sidebar order", () => {
  // the cases of src/lib/sidebarOrder.test.ts "Importance order", read from a snapshot as the server has it
  it("keeps the status groups before any band, done and idle as one group", () => {
    expect(order([
      { id: "working-p0", status: "working", level: "P0", seq: 1 },
      { id: "idle-p0", status: "idle", level: "P0", seq: 2 },
      { id: "done-p3", status: "done", level: "P3", seq: 1 },
      { id: "blocked-p3", status: "blocked", level: "P3", seq: 4 },
    ])).toEqual(["blocked-p3", "idle-p0", "done-p3", "working-p0"]);
    expect(order([
      { id: "done-p3", status: "done", level: "P3", seq: 1 },
      { id: "idle-p2", status: "idle", level: "P2", seq: 3 },
      { id: "idle-p3", status: "idle", level: "P3", seq: 2 },
      { id: "done-p2", status: "done", level: "P2", seq: 4 },
    ])).toEqual(["idle-p2", "done-p2", "done-p3", "idle-p3"]);
  });

  it("puts the more urgent band first, a row memory said nothing of as P2", () => {
    expect(order([
      { id: "p3", status: "idle", level: "P3", seq: 1 },
      { id: "none", status: "idle", seq: 2 },
      { id: "p1", status: "idle", level: "P1", seq: 3 },
      { id: "p0", status: "idle", level: "P0", seq: 4 },
    ])).toEqual(["p0", "p1", "none", "p3"]);
  });

  it("orders a band's aged rows first, longest wait first, then the rest by oldest change", () => {
    expect(order([
      { id: "fresh-old-seq", status: "idle", level: "P2", wait: 5, seq: 1 },
      { id: "aged-40", status: "idle", level: "P2", wait: 40, seq: 5 },
      { id: "aged-90", status: "idle", level: "P2", wait: 90, seq: 6 },
      { id: "fresh-new-seq", status: "idle", level: "P2", wait: 10, seq: 2 },
    ])).toEqual(["aged-90", "aged-40", "fresh-old-seq", "fresh-new-seq"]);
  });

  it("lifts a starved row into its group's top band but never above P1, and never past a P0", () => {
    expect(order([
      { id: "p0-fresh", status: "idle", level: "P0", wait: 1, seq: 1 },
      { id: "p1-fresh", status: "idle", level: "P1", wait: 1, seq: 2 },
      { id: "p3-starved", status: "idle", level: "P3", wait: 241, seq: 3 },
    ])).toEqual(["p0-fresh", "p3-starved", "p1-fresh"]);
    expect(order([
      { id: "p3-aged", status: "idle", level: "P3", wait: 120, seq: 1 },
      { id: "p1-fresh", status: "idle", level: "P1", wait: 1, seq: 2 },
    ])).toEqual(["p1-fresh", "p3-aged"]);
    expect(order([
      { id: "p3-starved", status: "blocked", level: "P3", wait: 241, seq: 1 },
      { id: "p0-long", status: "blocked", level: "P0", wait: 300, seq: 2 },
      { id: "p0-fresh", status: "blocked", level: "P0", wait: 2, seq: 3 },
    ])).toEqual(["p0-long", "p0-fresh", "p3-starved"]);
    expect(order([
      { id: "idle-p0", status: "idle", level: "P0", seq: 1 },
      { id: "working-p2", status: "working", level: "P2", wait: 1, seq: 2 },
      { id: "working-p3", status: "working", level: "P3", wait: 300, seq: 3 },
    ])).toEqual(["idle-p0", "working-p3", "working-p2"]);
  });

  it("follows the shared aging settings", () => {
    const rows: Row[] = [{ id: "p1", status: "idle", level: "P1", wait: 1, seq: 1 }, { id: "p3", status: "idle", level: "P3", wait: 41, seq: 2 }];
    expect(order(rows)).toEqual(["p1", "p3"]);
    expect(order(rows, sanitizeImportanceAging({ p1: 5, p2: 10, p3: 20, factor: 2 }))).toEqual(["p3", "p1"]);
  });

  it("is herdr's FIFO order with no importance or clock: seq, then workspace, tab and pane order", () => {
    expect(order([
      { id: "c", status: "idle", seq: 3 }, { id: "a", status: "idle", seq: 1 }, { id: "nos", status: "idle" },
      { id: "b", status: "blocked", seq: 9 }, { id: "tie2", status: "working", seq: 4, workspace: "w2" }, { id: "tie1", status: "working", seq: 4 },
    ])).toEqual(["b", "a", "c", "nos", "tie1", "tie2"]);
  });

  it("ranks a pane waiting on its turn's background work with the working ones, and leaves out panes with no agent", () => {
    expect(order([
      { id: "bg", status: "done", background: true, seq: 1 },
      { id: "working", status: "working", seq: 2 },
      { id: "shell", status: "unknown", agent: false, seq: 0 },
      { id: "idle", status: "idle", seq: 3 },
    ])).toEqual(["idle", "bg", "working"]);
  });

  it("gives each pane its band, P2 where memory said nothing, and its 1-based place zero padded", () => {
    expect(prioTokens(snapshotOf([
      { id: "w1:p2", status: "idle", seq: 2 },
      { id: "w1:p1", status: "blocked", level: "P3", seq: 1 },
      { id: "w1:p3", status: "idle", level: "P0", seq: 3 },
    ]), DEFAULT_IMPORTANCE_AGING, NOW)).toEqual([
      { pane_id: "w1:p1", tokens: { prio: "P3", rank: "0001" } },
      { pane_id: "w1:p3", tokens: { prio: "P0", rank: "0002" } },
      { pane_id: "w1:p2", tokens: { prio: "P2", rank: "0003" } },
    ]);
  });
});

describe("the sync", () => {
  function harness(rows: Row[]) {
    let now = NOW;
    let snapshot = snapshotOf(rows);
    const reports: PrioReport[] = [];
    const logs: string[] = [];
    let failing: string | null = null;
    let snapshotFails = false;
    const sync = new HerdrPrioSync({
      snapshot: async () => { if (snapshotFails) throw new Error("herdr is restarting"); return snapshot; },
      aging: () => DEFAULT_IMPORTANCE_AGING,
      report: async (params) => { if (params.pane_id === failing) throw new Error("pane_not_found"); reports.push(params); },
      now: () => now,
      log: (line) => logs.push(line),
    });
    return {
      sync, reports, logs,
      advance: (ms: number) => { now += ms; },
      set: (next: Row[]) => { snapshot = snapshotOf(next); },
      failPane: (paneId: string | null) => { failing = paneId; },
      failSnapshot: (fails: boolean) => { snapshotFails = fails; },
    };
  }

  it("reports every pane with this server's source and the TTL, then only what changed", async () => {
    const h = harness([{ id: "a", status: "idle", seq: 1 }, { id: "b", status: "idle", seq: 2 }]);
    await h.sync.sync();
    expect(h.reports).toEqual([
      { pane_id: "a", source: PRIO_SOURCE, tokens: { prio: "P2", rank: "0001" }, ttl_ms: TOKEN_TTL_MS },
      { pane_id: "b", source: PRIO_SOURCE, tokens: { prio: "P2", rank: "0002" }, ttl_ms: TOKEN_TTL_MS },
    ]);
    expect(TOKEN_TTL_MS).toBe(3 * REREPORT_MS);
    expect(h.logs).toEqual([`herdr prio sync: herdr's sidebar follows Importance order, 2 panes reported as ${PRIO_SOURCE}`]);
    h.reports.length = 0;
    h.advance(1_000);
    await h.sync.sync();
    expect(h.reports).toEqual([]);
    h.set([{ id: "a", status: "idle", seq: 1 }, { id: "b", status: "blocked", seq: 3 }]);
    await h.sync.sync();
    expect(h.reports.map((report) => [report.pane_id, report.tokens.rank])).toEqual([["b", "0001"], ["a", "0002"]]);
  });

  it("reports an unchanged pane again before its tokens could lapse", async () => {
    const h = harness([{ id: "a", status: "idle", seq: 1 }]);
    await h.sync.sync();
    h.reports.length = 0;
    h.advance(REREPORT_MS - 1);
    await h.sync.sync();
    expect(h.reports).toEqual([]);
    h.advance(1);
    await h.sync.sync();
    expect(h.reports.map((report) => report.pane_id)).toEqual(["a"]);
    // a pass missed between two re-reports still lands inside the TTL
    expect(REREPORT_MS + 2 * PASS_MS).toBeLessThan(TOKEN_TTL_MS);
  });

  it("never rejects: a failed snapshot or report is said once, and the next pass tries again", async () => {
    const h = harness([{ id: "a", status: "idle", seq: 1 }, { id: "b", status: "idle", seq: 2 }]);
    h.failSnapshot(true);
    await h.sync.sync();
    await h.sync.sync();
    expect(h.reports).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("herdr is restarting");
    h.failSnapshot(false);
    h.failPane("a");
    await h.sync.sync();
    // the other panes are reported all the same
    expect(h.reports.map((report) => report.pane_id)).toEqual(["b"]);
    expect(h.logs).toHaveLength(1);
    h.failPane(null);
    h.reports.length = 0;
    await h.sync.sync();
    expect(h.reports.map((report) => report.pane_id)).toEqual(["a"]);
    expect(h.logs.at(-1)).toContain("again");
  });

  it("runs once more after a pass that a call arrived during, not once per call", async () => {
    const reports: string[] = [];
    let release: () => void = () => undefined;
    let first = true;
    const sync = new HerdrPrioSync({
      snapshot: async () => {
        if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); }
        return snapshotOf([{ id: "a", status: "idle", seq: 1 }]);
      },
      aging: () => DEFAULT_IMPORTANCE_AGING,
      report: async (params) => { reports.push(params.tokens.rank); },
      rereportMs: 0,
    });
    sync.start();
    const running = sync.sync();
    void sync.sync();
    void sync.sync();
    release();
    await running;
    for (let tries = 0; reports.length < 2 && tries < 100; tries++) await Promise.resolve();
    sync.stop();
    expect(reports).toEqual(["0001", "0001"]);
  });

  it("is on only when asked, under its own name or its old one in herdr's plugin env file", () => {
    expect(prioSyncEnabled({})).toBe(false);
    expect(prioSyncEnabled({ OVIS_HERDR_PRIO_SYNC: "0" })).toBe(false);
    expect(prioSyncEnabled({ OVIS_HERDR_PRIO_SYNC: "1" })).toBe(true);
    expect(prioSyncEnabled({ OVIS_HERDR_PRIO_SYNC: "on" })).toBe(true);
    const env: Record<string, string | undefined> = { [legacyName("OVIS_HERDR_PRIO_SYNC")!]: "1" };
    adoptLegacyEnv(env);
    expect(prioSyncEnabled(env)).toBe(true);
  });
});
