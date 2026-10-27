import { describe, expect, it } from "bun:test";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import machines from "../../site/demo/fixtures/machines.json";
import { activityOrder, agingThresholdMs, importanceFacts, importanceOrder, isSeenDone, liveSeqs, newSeqMemory, shownStatus, stateSeqs, waitingOrder } from "./sidebarOrder.ts";
import { DEFAULT_IMPORTANCE_AGING, DEFAULT_SETTINGS, sanitizeImportanceAging, sanitizeSettings, telemetrySettingsSnapshot } from "./settings.ts";
import type { ImportanceLevel } from "../../shared/protocol.ts";

const template = machines.machines[0]!.snapshot!;
const pane = (id: string, agent_status: AgentStatus, finish_id?: number): HerdrPane =>
  ({ ...template.panes[0]!, pane_id: id, agent_status, finish_id });
const snap = (statuses: Record<string, AgentStatus>, seqs: Record<string, number>): SessionSnapshot => ({
  ...template,
  panes: Object.entries(statuses).map(([id, status]) => pane(id, status)),
  agents: Object.entries(seqs).map(([pane_id, state_change_seq]) => ({ ...template.agents[0]!, pane_id, state_change_seq })),
});

describe("activity counters, independent of opened finishes", () => {
  it("ignores absent, nonnumeric and nonfinite counters", () => {
    const snapshot = snap({}, { valid: 7, text: 1, missing: 1, infinite: Infinity, nan: NaN });
    Object.assign(snapshot.agents[1]!, { state_change_seq: "9" });
    delete snapshot.agents[2]!.state_change_seq;
    expect([...stateSeqs(snapshot)]).toEqual([["valid", 7]]);
  });

  it("accepts a null snapshot", () => { expect([...stateSeqs(null)]).toEqual([]); });

  it("keeps rows without counters at the end in their supplied order", () => {
    const rows = [pane("missing-a", "done"), pane("dated", "done"), pane("missing-b", "working")];
    expect(activityOrder(rows, (p) => p, new Map([["dated", 0]])).map((p) => p.pane_id)).toEqual(["dated", "missing-a", "missing-b"]);
  });

  it("drops stand-ins when herdr's real counter arrives without another status change", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working" }, { a: 1 }), memory);
    liveSeqs(snap({ a: "done" }, { a: 1 }), memory);
    expect(memory.bumped.size).toBe(1);
    expect([...liveSeqs(snap({ a: "done" }, { a: 2 }), memory)]).toEqual([["a", 2]]);
    expect(memory.bumped.size).toBe(0);
  });

  it("drops real counters and bumps on an empty roster, so a returning pane is not falsely recent", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working" }, { a: 10 }), memory);
    liveSeqs(snap({ a: "done" }, { a: 10 }), memory);
    liveSeqs(snap({}, {}), memory);
    expect(memory.real.size).toBe(0);
    expect(memory.bumped.size).toBe(0);
    const returned = snap({ a: "working", b: "done" }, { a: 10, b: 20 });
    const seqs = liveSeqs(returned, memory);
    expect(activityOrder(returned.panes, (p) => p, seqs).map((p) => p.pane_id)).toEqual(["b", "a"]);
  });

  it("reads agent counters and dates pushed changes until herdr catches up", () => {
    const memory = newSeqMemory();
    expect([...stateSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }))]).toEqual([["a", 5], ["b", 9]]);
    liveSeqs(snap({ a: "idle", b: "done" }, { a: 5, b: 9 }), memory);
    const working = liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    const done = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    expect(working.get("a")).toBeGreaterThan(9);
    expect(done.get("a")!).toBeGreaterThan(working.get("a")!);
    expect(liveSeqs(snap({ a: "done", b: "done" }, { a: 11, b: 9 }), memory).get("a")).toBe(11);
  });

  it("keeps herdr's order when a snapshot brings new counters with changed statuses", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working", b: "working" }, { a: 5, b: 6 }), memory);
    expect([...liveSeqs(snap({ a: "done", b: "done" }, { a: 21, b: 20 }), memory)]).toEqual([["a", 21], ["b", 20]]);
  });

  it("does not date first sightings or panes without counters", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", shell: "unknown" }, { a: 5 }), memory);
    expect([...liveSeqs(snap({ a: "idle", shell: "working", c: "done" }, { a: 5, c: 7 }), memory)]).toEqual([["a", 5], ["c", 7]]);
  });

  it("ranks blocked first, then raw recency, with stable ties", () => {
    const panes = [pane("old", "done", 1), pane("working", "working"), pane("blocked", "blocked"), pane("new", "done", 1), pane("tie", "idle")];
    const seqs = new Map([["old", 20], ["working", 10], ["blocked", 1], ["new", 30], ["tie", 30]]);
    expect(activityOrder(panes, (p) => p, seqs).map((p) => p.pane_id)).toEqual(["blocked", "new", "tie", "old", "working"]);
    expect(activityOrder(panes, (p) => p, new Map([...seqs, ["working", 60]])).map((p) => p.pane_id).slice(0, 2)).toEqual(["blocked", "working"]);
  });

  it("drops pre-restart stand-ins for an older bridge with no finish epoch", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", b: "done", c: "idle" }, { a: 50, b: 49, c: 48 }), memory);
    liveSeqs(snap({ a: "working", b: "done", c: "idle" }, { a: 50, b: 49, c: 48 }), memory);
    liveSeqs(snap({ a: "working", b: "done", c: "idle" }, { a: 2, b: 3, c: 1 }), memory);
    const latest = snap({ a: "working", b: "done", c: "working" }, { a: 2, b: 3, c: 9 });
    const seqs = liveSeqs(latest, memory);
    expect(activityOrder(latest.panes, (pane) => pane, seqs).map((pane) => pane.pane_id)).toEqual(["c", "b", "a"]);
    expect(memory.bumped.size).toBe(0);
  });
});

describe("opened finish identity", () => {
  it("accepts stale lower finish ids within the epoch, never future or absent ids", () => {
    expect(isSeenDone(pane("a", "done", 2), { a: 2 })).toBe(true);
    expect(isSeenDone(pane("a", "done", 1), { a: 2 })).toBe(true);
    for (const id of [undefined, 0, 3]) expect(isSeenDone(pane("a", "done", id), { a: 2 })).toBe(false);
    expect(isSeenDone(pane("a", "done", 2), {})).toBe(false);
  });

  it("never draws working, blocked, or question as ready and keeps background-wait precedence", () => {
    for (const status of ["working", "blocked", "question"] as const) {
      expect(shownStatus(pane("a", status, 2), { a: 2 })).toBe(status);
    }
    expect(shownStatus({ ...pane("a", "done", 2), background_wait: true }, { a: 2 })).toBe("waiting");
    expect(shownStatus({ ...pane("a", "blocked", 2), background_wait: true }, { a: 2 })).toBe("blocked");
    expect(shownStatus(pane("a", "done", 2), { a: 2 })).toBe("idle");
  });
});

describe("longest wait order", () => {
  const raw = (row: HerdrPane) => row.agent_status;

  it("ranks blocked, then an unread finish, then ready, then working, whatever their recency", () => {
    const panes = [pane("working", "working"), pane("ready", "idle"), pane("finished", "done", 1), pane("blocked", "blocked"), { ...pane("bg", "done", 1), background_wait: true as const }];
    const seqs = new Map([["working", 1], ["ready", 2], ["finished", 3], ["blocked", 4], ["bg", 0]]);
    expect(waitingOrder(panes, (p) => p, (p) => shownStatus(p, {}), seqs).map((p) => p.pane_id)).toEqual(["blocked", "finished", "ready", "bg", "working"]);
  });

  it("puts the oldest state change first within a rank, then the order given, then panes with no counter", () => {
    const panes = [pane("new", "done", 1), pane("none", "done", 1), pane("tie-a", "done", 1), pane("old", "done", 1), pane("tie-b", "done", 1)];
    const seqs = new Map([["new", 30], ["tie-a", 20], ["old", 10], ["tie-b", 20]]);
    expect(waitingOrder(panes, (p) => p, raw, seqs).map((p) => p.pane_id)).toEqual(["old", "tie-a", "tie-b", "new", "none"]);
    expect(activityOrder(panes, (p) => p, seqs).map((p) => p.pane_id).slice(0, 2)).toEqual(["new", "tie-a"]);
  });

  it("takes a finish already opened for ready, behind an unread one and among the other ready agents", () => {
    const panes = [pane("ready", "idle"), pane("opened", "done", 2), pane("unread", "done", 3)];
    const seqs = new Map([["ready", 5], ["opened", 1], ["unread", 9]]);
    const seen = { opened: 2 };
    expect(waitingOrder(panes, (p) => p, (p) => shownStatus(p, seen), seqs).map((p) => p.pane_id)).toEqual(["unread", "opened", "ready"]);
    expect(waitingOrder(panes, (p) => p, raw, seqs).map((p) => p.pane_id)).toEqual(["opened", "unread", "ready"]);
  });

  it("leaves a status herdr adds later after working", () => {
    const panes = [pane("odd", "question"), pane("working", "working")];
    expect(waitingOrder(panes, (p) => p, raw, new Map([["odd", 1], ["working", 2]])).map((p) => p.pane_id)).toEqual(["working", "odd"]);
  });
});

it("defaults to herdr's order and accepts only known settings", () => {
  expect(DEFAULT_SETTINGS.agentOrder).toBe("workspace");
  expect(sanitizeSettings({ agentOrder: "activity" })).toMatchObject({ agentOrder: "activity" });
  expect(sanitizeSettings({ agentOrder: "waiting" })).toMatchObject({ agentOrder: "waiting" });
  expect(sanitizeSettings({ agentOrder: "importance" })).toMatchObject({ agentOrder: "importance" });
  expect(sanitizeSettings({ agentOrder: "recent" })).toMatchObject({ agentOrder: "workspace" });
});

describe("Importance order", () => {
  const MIN = 60_000;
  /** a row: its id, drawn status, band (undefined: memory said nothing), wait in minutes (undefined: no clock) and herdr's seq */
  interface Row { id: string; status: AgentStatus; level?: ImportanceLevel; wait?: number; seq?: number }
  const order = (rows: Row[], aging = DEFAULT_IMPORTANCE_AGING): string[] =>
    importanceOrder(rows, (row) => ({ pane_id: row.id }), (row) => row.status, new Map(rows.flatMap((row) => row.seq === undefined ? [] : [[row.id, row.seq] as const])), {
      importanceOf: (row) => row.level, waitOf: (row) => row.wait === undefined ? undefined : row.wait * MIN, aging,
    }).map((row) => row.id);

  it("keeps Longest wait's status groups before any band", () => {
    expect(order([
      { id: "working-p0", status: "working", level: "P0", seq: 1 },
      { id: "idle-p0", status: "idle", level: "P0", seq: 2 },
      { id: "done-p3", status: "done", level: "P3", seq: 3 },
      { id: "blocked-p3", status: "blocked", level: "P3", seq: 4 },
    ])).toEqual(["blocked-p3", "done-p3", "idle-p0", "working-p0"]);
  });

  it("puts the more urgent band first within a group, whatever the seq", () => {
    expect(order([
      { id: "p3", status: "idle", level: "P3", seq: 1 },
      { id: "p2", status: "idle", level: "P2", seq: 2 },
      { id: "p1", status: "idle", level: "P1", seq: 3 },
      { id: "p0", status: "idle", level: "P0", seq: 4 },
    ])).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("counts a row memory said nothing of as P2, between P1 and P3", () => {
    expect(order([
      { id: "p3", status: "idle", level: "P3", seq: 1 },
      { id: "none", status: "idle", seq: 2 },
      { id: "p1", status: "idle", level: "P1", seq: 3 },
    ])).toEqual(["p1", "none", "p3"]);
  });

  it("orders a band's aged rows first, longest wait first, then the rest by oldest change", () => {
    expect(order([
      { id: "fresh-old-seq", status: "idle", level: "P2", wait: 5, seq: 1 },
      { id: "aged-40", status: "idle", level: "P2", wait: 40, seq: 5 },
      { id: "aged-90", status: "idle", level: "P2", wait: 90, seq: 6 },
      { id: "fresh-new-seq", status: "idle", level: "P2", wait: 10, seq: 2 },
    ])).toEqual(["aged-90", "aged-40", "fresh-old-seq", "fresh-new-seq"]);
  });

  it("ages a row only past its band's own threshold: 15 min for P1, 30 for P2, 60 for P3", () => {
    expect(importanceFacts("P1", 16 * MIN, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(true);
    expect(importanceFacts("P1", 15 * MIN, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(false);
    expect(importanceFacts("P2", 29 * MIN, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(false);
    expect(importanceFacts("P3", 59 * MIN, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(false);
    expect(importanceFacts("P3", 61 * MIN, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(true);
    // P0 has no wait to serve: any known wait counts as aged, and it is never promoted
    expect(agingThresholdMs(0, DEFAULT_IMPORTANCE_AGING)).toBe(0);
    expect(importanceFacts("P0", 10_000 * MIN, DEFAULT_IMPORTANCE_AGING, 0)).toMatchObject({ aged: true, promoted: false, effectiveBand: 0 });
    expect(importanceFacts("P0", 0, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(false);
    expect(importanceFacts("P0", undefined, DEFAULT_IMPORTANCE_AGING, 0).aged).toBe(false);
  });

  it("does not let an aged row jump a more urgent band before it starves", () => {
    // a P3 aged 2 hours (2x its 60 min) stays behind a fresh P1
    expect(order([
      { id: "p3-aged", status: "idle", level: "P3", wait: 120, seq: 1 },
      { id: "p1-fresh", status: "idle", level: "P1", wait: 1, seq: 2 },
    ])).toEqual(["p1-fresh", "p3-aged"]);
  });

  it("lifts a row that waited 4x its threshold into its group's top band, as an aged row there", () => {
    // P3 waited 241 min (> 4 x 60): it competes in P0's band and, aged, goes before the fresh P0
    expect(order([
      { id: "p0-fresh", status: "idle", level: "P0", wait: 1, seq: 1 },
      { id: "p1-fresh", status: "idle", level: "P1", wait: 1, seq: 2 },
      { id: "p3-starved", status: "idle", level: "P3", wait: 241, seq: 3 },
    ])).toEqual(["p3-starved", "p0-fresh", "p1-fresh"]);
    expect(importanceFacts("P3", 241 * MIN, DEFAULT_IMPORTANCE_AGING, 0)).toMatchObject({ promoted: true, effectiveBand: 0 });
    expect(importanceFacts("P3", 239 * MIN, DEFAULT_IMPORTANCE_AGING, 0)).toMatchObject({ promoted: false, effectiveBand: 3 });
  });

  it("orders a P0 and a row lifted into its band by longest wait, so a long-waiting P0 is not passed", () => {
    expect(order([
      { id: "p3-starved", status: "blocked", level: "P3", wait: 241, seq: 1 },
      { id: "p0-long", status: "blocked", level: "P0", wait: 300, seq: 2 },
      { id: "p0-fresh", status: "blocked", level: "P0", wait: 2, seq: 3 },
    ])).toEqual(["p0-long", "p3-starved", "p0-fresh"]);
  });

  it("promotes only to the top band of the row's own status group", () => {
    // the working group's top band is P2: a starved P3 there joins P2, not the idle group's P0
    expect(order([
      { id: "idle-p0", status: "idle", level: "P0", seq: 1 },
      { id: "working-p2", status: "working", level: "P2", wait: 1, seq: 2 },
      { id: "working-p3", status: "working", level: "P3", wait: 300, seq: 3 },
    ])).toEqual(["idle-p0", "working-p3", "working-p2"]);
  });

  it("follows the configured thresholds and factor", () => {
    const aging = sanitizeImportanceAging({ p1: 5, p2: 10, p3: 20, factor: 2 });
    expect(order([
      { id: "p1", status: "idle", level: "P1", wait: 1, seq: 1 },
      { id: "p3", status: "idle", level: "P3", wait: 41, seq: 2 },
    ], aging)).toEqual(["p3", "p1"]);
  });

  it("is Longest wait (FIFO by herdr's seq, then given order) when no row has importance or a clock", () => {
    const rows: Row[] = [
      { id: "c", status: "idle", seq: 3 }, { id: "a", status: "idle", seq: 1 }, { id: "nos", status: "idle" },
      { id: "b", status: "blocked", seq: 9 }, { id: "tie1", status: "working", seq: 4 }, { id: "tie2", status: "working", seq: 4 },
    ];
    const waiting = waitingOrder(rows, (row) => ({ pane_id: row.id }), (row) => row.status, new Map(rows.flatMap((row) => row.seq === undefined ? [] : [[row.id, row.seq] as const]))).map((row) => row.id);
    expect(order(rows)).toEqual(waiting);
    expect(order(rows)).toEqual(["b", "a", "c", "nos", "tie1", "tie2"]);
  });

  it("breaks equal waits and bands by herdr's seq, then by the order given", () => {
    expect(order([
      { id: "second", status: "idle", level: "P2", wait: 45, seq: 7 },
      { id: "first", status: "idle", level: "P2", wait: 45, seq: 2 },
      { id: "third", status: "idle", level: "P2", wait: 45, seq: 7 },
    ])).toEqual(["first", "second", "third"]);
  });

  it("keeps sane aging values and leaves the order out of telemetry's schema", () => {
    expect(sanitizeImportanceAging(undefined)).toEqual({ p1: 15, p2: 30, p3: 60, factor: 4 });
    expect(sanitizeImportanceAging({ p1: 0, p2: -3, p3: "60", factor: 1e9 })).toEqual({ p1: 15, p2: 30, p3: 60, factor: 20 });
    expect(sanitizeImportanceAging({ p1: 7.4, p2: 1e9, p3: 90, factor: 2 })).toEqual({ p1: 7, p2: 1440, p3: 90, factor: 2 });
    expect(sanitizeSettings({}).importanceAging).toEqual(DEFAULT_IMPORTANCE_AGING);
    const telemetry = telemetrySettingsSnapshot(sanitizeSettings({ agentOrder: "importance", importanceAging: { p1: 5 } }));
    expect(telemetry.agentOrder).toBe("activity");
    expect(telemetry).not.toHaveProperty("importanceAging");
  });
});
