import { describe, expect, it } from "bun:test";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import machines from "../../site/demo/fixtures/machines.json";
import { activityOrder, isSeenDone, liveSeqs, newSeqMemory, shownStatus, stateSeqs, waitingOrder } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

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
  expect(sanitizeSettings({ agentOrder: "recent" })).toMatchObject({ agentOrder: "workspace" });
});
