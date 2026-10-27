import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { memoryEndpoint, paneSessionId, SessionImportance, unwrapToolResult, WaitClocks, withImportance, type MemoryEndpoint } from "./session-importance.ts";
import { handleImportanceRequest } from "./importance-routes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "ovis-importance-")); dirs.push(dir); return dir; };

/** test-only stand-ins for an API key, built so no scanner takes them for one */
const KEY = ["k", "test"].join("-");
const ENV_KEY = ["from", "env"].join("-");
const endpoint: MemoryEndpoint = { url: "http://memory.test", key: () => KEY };
const pane = (pane_id: string, session: string | null, agent_status: HerdrPane["agent_status"] = "idle"): HerdrPane => ({
  pane_id, agent_status, workspace_id: "w1", tab_id: "t1", cwd: "/", focused: false, revision: 1,
  ...(session === null ? {} : { agent_session: { agent: "opencode", kind: "id", source: "herdr", value: session } }),
} as unknown as HerdrPane);

interface Call { url: string; body: unknown; auth: string | null }
function fakeMemory(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? "null")), auth: new Headers(init?.headers).get("authorization") };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: fake, calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(fetcher: typeof fetch, over: { active?: () => boolean; now?: () => number } = {}) {
  let changes = 0;
  const lines: string[] = [];
  const importance = new SessionImportance({ endpoint, fetch: fetcher, active: over.active ?? (() => true), now: over.now, onChange: () => { changes++; }, log: (line) => lines.push(line), pollMs: 45_000 });
  return { importance, changes: () => changes, lines };
}

describe("session importance provider", () => {
  it("asks memory about the snapshot's OpenCode sessions only, with the key, and attaches each answer", async () => {
    const memory = fakeMemory(() => json({ sessions: { ses_a: { level: "P0", source: "queue", reason: "!123 P0", override: null }, ses_b: { level: "PX", source: "queue", reason: "bad" } } }));
    const { importance, changes } = provider(memory.fetch);
    importance.refresh([pane("p1", "ses_a"), pane("p2", "ses_b"), pane("p3", null), { ...pane("p4", null), agent_session: { agent: "claude", kind: "path", source: "x", value: "/tmp/s.jsonl" } } as HerdrPane]);
    await importance.poll();
    expect(memory.calls).toHaveLength(1);
    expect(memory.calls[0]).toEqual({ url: "http://memory.test/tools/session_importance", body: { session_ids: ["ses_a", "ses_b"] }, auth: `Bearer ${KEY}` });
    expect(importance.of(pane("p1", "ses_a"))).toEqual({ level: "P0", source: "queue", reason: "!123 P0" });
    // a level memory does not know is neutral
    expect(importance.of(pane("p2", "ses_b"))).toBeUndefined();
    expect(changes()).toBe(1);
  });

  it("unwraps a result sent as a JSON string, under result, or as MCP text content", () => {
    const inner = { sessions: { ses_a: { level: "P1" } } };
    expect(unwrapToolResult(JSON.stringify(inner))).toEqual(inner);
    expect(unwrapToolResult({ result: JSON.stringify(inner) })).toEqual(inner);
    expect(unwrapToolResult({ content: [{ type: "text", text: JSON.stringify(inner) }] })).toEqual(inner);
    expect(unwrapToolResult([{ type: "text", text: JSON.stringify({ result: inner }) }])).toEqual(inner);
    expect(unwrapToolResult("not json")).toBe("not json");
  });

  it("leaves every pane neutral, says so once, and backs off while memory lacks the tool", async () => {
    let now = 0;
    const memory = fakeMemory(() => json({ error: "Unknown tool", message: "Unknown tool: session_importance" }, 404));
    const { importance, changes, lines } = provider(memory.fetch, { now: () => now });
    importance.refresh([pane("p1", "ses_a")]);
    await importance.poll();
    expect(importance.of(pane("p1", "ses_a"))).toBeUndefined();
    expect(changes()).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("neutral (P2)");
    expect(lines[0]).not.toContain(KEY);
    now += 60_000;
    await importance.poll();
    expect(memory.calls).toHaveLength(1);
    now += 10 * 60_000;
    await importance.poll();
    expect(memory.calls).toHaveLength(2);
    expect(lines).toHaveLength(1);
  });

  it("drops what it knew when memory goes away, and takes it back when memory answers again", async () => {
    let now = 0;
    let up = true;
    const memory = fakeMemory(() => {
      if (!up) throw new TypeError("fetch failed: connection refused");
      return json(JSON.stringify({ sessions: { ses_a: { level: "P1", source: "objective", reason: "objective #85" } } }));
    });
    const { importance, changes, lines } = provider(memory.fetch, { now: () => now });
    importance.refresh([pane("p1", "ses_a")]);
    await importance.poll();
    expect(importance.of(pane("p1", "ses_a"))?.level).toBe("P1");
    up = false; now += 45_000;
    await importance.poll();
    expect(importance.of(pane("p1", "ses_a"))).toBeUndefined();
    expect(lines.at(-1)).toContain("not reachable");
    // backed off: 45 s x 2^0 after the first failure
    now += 10_000;
    await importance.poll();
    expect(memory.calls).toHaveLength(2);
    up = true; now += 60_000;
    await importance.poll();
    expect(importance.of(pane("p1", "ses_a"))?.level).toBe("P1");
    expect(changes()).toBe(3);
    expect(lines.at(-1)).toContain("answers again");
  });

  it("asks nothing while no browser watches, and nothing about a snapshot without sessions", async () => {
    let watching = false;
    const memory = fakeMemory(() => json({ sessions: {} }));
    const { importance } = provider(memory.fetch, { active: () => watching });
    importance.refresh([pane("p1", "ses_a")]);
    await importance.poll();
    expect(memory.calls).toHaveLength(0);
    watching = true;
    importance.refresh([pane("p3", null)]);
    await importance.poll();
    expect(memory.calls).toHaveLength(0);
  });

  it("is off with no endpoint, by OVIS_MEMORY_URL=off, under bun test by default, and never sends the key over plain http elsewhere", async () => {
    expect(memoryEndpoint({ OVIS_MEMORY_URL: "off" })).toBeNull();
    expect(memoryEndpoint({ NODE_ENV: "test" })).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, "key"), "");
    const local = memoryEndpoint({ OVIS_MEMORY_URL: "http://127.0.0.1:9824/", OPENCODE_MEMORY_API_KEY: ENV_KEY, XDG_CONFIG_HOME: dir });
    expect(local?.url).toBe("http://127.0.0.1:9824");
    expect(local?.key()).toBe(ENV_KEY);
    expect(memoryEndpoint({ OVIS_MEMORY_URL: "http://memory.lan:9824", OPENCODE_MEMORY_API_KEY: ENV_KEY })?.key()).toBeNull();
    // a name that only starts like a loopback address is another host
    for (const url of ["http://127.example.net:9824", "http://127.0.0.1.nip.io:9824"]) expect(memoryEndpoint({ OVIS_MEMORY_URL: url, OPENCODE_MEMORY_API_KEY: ENV_KEY })?.key()).toBeNull();
    expect(memoryEndpoint({ OVIS_MEMORY_URL: "http://127.0.0.2:9824", OPENCODE_MEMORY_API_KEY: ENV_KEY })?.key()).toBe(ENV_KEY);
    expect(memoryEndpoint({ OVIS_MEMORY_URL: "https://memory.example", OPENCODE_MEMORY_API_KEY: ENV_KEY })?.key()).toBe(ENV_KEY);
    const off = new SessionImportance({ endpoint: null, active: () => true, onChange: () => {} });
    off.refresh([pane("p1", "ses_a")]);
    expect(await off.set("p1", "P0")).toMatchObject({ ok: false, code: "importance_off" });
  });

  it("reads the key from memory's own key file when the environment has none", () => {
    const dir = tempDir();
    const secrets = join(dir, "opencode-memory", "secrets");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "api_key"), "from-file\n");
    expect(memoryEndpoint({ OVIS_MEMORY_URL: "http://localhost:9824", XDG_CONFIG_HOME: dir })?.key()).toBe("from-file");
  });

  it("sets a level on the pane's session, asks again at once, and passes memory's refusal on", async () => {
    let level = "P2";
    const memory = fakeMemory((call) => {
      if (call.url.endsWith("/session_importance_set")) {
        const body = call.body as { level: string | null };
        if (body.level === "P0") return json({ error: "override refused: session closed" });
        level = body.level ?? "P2";
        return json({ ok: true });
      }
      return json({ sessions: { ses_a: { level, source: "override", reason: "set by hand" } } });
    });
    const { importance } = provider(memory.fetch);
    importance.refresh([pane("p1", "ses_a")]);
    await importance.poll();
    expect(await importance.set("p1", "P1", 2)).toEqual({ ok: true });
    expect(memory.calls.find((call) => call.url.endsWith("/session_importance_set"))?.body).toEqual({ session_id: "ses_a", level: "P1", ttl_hours: 2 });
    expect(importance.of(pane("p1", "ses_a"))?.level).toBe("P1");
    expect(await importance.set("p1", "P0")).toMatchObject({ ok: false, status: 502, code: "memory_refused", message: expect.stringContaining("session closed") });
    expect(await importance.set("p9", "P0")).toMatchObject({ ok: false, status: 404, code: "no_session" });
  });

  it("says memory does not offer the set yet when the tool is unknown", async () => {
    const memory = fakeMemory(() => json({ error: "Unknown tool", message: "Unknown tool: session_importance_set" }, 404));
    const { importance } = provider(memory.fetch);
    importance.refresh([pane("p1", "ses_a")]);
    expect(await importance.set("p1", null)).toMatchObject({ ok: false, code: "memory_unsupported" });
  });

  it("takes a tool's own error, which memory also answers as 404 Unknown tool, for a refusal, not a missing tool", async () => {
    let now = 0;
    const memory = fakeMemory((call) => call.url.endsWith("/session_importance_set")
      ? json({ error: "Unknown tool", message: "level must be P0..P3" }, 404)
      : json({ error: "Unknown tool", message: "session_ids must be a list" }, 404));
    const { importance, lines } = provider(memory.fetch, { now: () => now });
    importance.refresh([pane("p1", "ses_a")]);
    expect(await importance.set("p1", "P1")).toMatchObject({ ok: false, code: "memory_refused", message: expect.stringContaining("level must be P0..P3") });
    // the poll that failed backs off as an ordinary failure (45 s), not as a missing tool (10 min)
    expect(lines.at(-1)).toContain("session_ids must be a list");
    const asked = memory.calls.length;
    now += 46_000;
    await importance.poll();
    expect(memory.calls.length).toBe(asked + 1);
  });

  it("tells an unreachable memory and an answer that says no apart from a refusal and a set", async () => {
    const down = provider(fakeMemory(() => { throw new TypeError("connection refused"); }).fetch);
    down.importance.refresh([pane("p1", "ses_a")]);
    expect(await down.importance.set("p1", "P1")).toMatchObject({ ok: false, code: "memory_unreachable", message: "opencode-memory did not set it (not reachable)" });
    const no = provider(fakeMemory((call) => call.url.endsWith("_set") ? json({ ok: false, message: "session not found" }) : json({ sessions: {} })).fetch);
    no.importance.refresh([pane("p1", "ses_a")]);
    expect(await no.importance.set("p1", "P1")).toMatchObject({ ok: false, code: "memory_refused", message: "opencode-memory refused: session not found" });
  });

  it("puts each pane's wait clock and its session's importance on the snapshot clients get", async () => {
    const memory = fakeMemory(() => json({ sessions: { ses_a: { level: "P0", source: "queue", reason: "!1 P0" } } }));
    const { importance } = provider(memory.fetch);
    let now = 100;
    const clocks = new WaitClocks(null, () => now);
    const snapshot = { panes: [pane("p1", "ses_a"), pane("p2", null, "working")], agents: [{ pane_id: "p1", state_change_seq: 3 }, { pane_id: "p2", state_change_seq: 4 }] } as unknown as SessionSnapshot;
    const first = withImportance(snapshot, clocks, importance);
    expect(first.panes.map((p) => [p.pane_id, p.wait, p.importance])).toEqual([["p1", { since: 100, status: "idle" }, undefined], ["p2", { since: 100, status: "working" }, undefined]]);
    await importance.poll();
    now = 900;
    const second = withImportance(snapshot, clocks, importance);
    expect(second.panes[0]).toMatchObject({ wait: { since: 100, status: "idle" }, importance: { level: "P0", reason: "!1 P0" } });
    expect(second.panes[1]).not.toHaveProperty("importance");
    expect(second.panes[1]!.wait).toEqual({ since: 100, status: "working" });
  });

  it("answers the route with ok after a set and with memory's refusal as a 502 envelope", async () => {
    const memory = fakeMemory((call) => {
      if (!call.url.endsWith("_set")) return json({ sessions: {} });
      return (call.body as { level: string | null }).level === "P3" ? json({ error: "override refused" }) : json({ ok: true });
    });
    const { importance } = provider(memory.fetch);
    importance.refresh([pane("p1", "ses_a")]);
    const route = (body: unknown) => handleImportanceRequest(new Request("http://127.0.0.1/api/agent/importance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "/api/agent/importance", importance);
    const ok = (await route({ pane_id: "p1", level: "P1", ttl_hours: 4 }))!;
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);
    const refused = (await route({ pane_id: "p1", level: "P3" }))!;
    expect([refused.status, await refused.json()]).toEqual([502, { error: { code: "memory_refused", message: "opencode-memory refused: override refused" } }]);
    expect(await handleImportanceRequest(new Request("http://127.0.0.1/api/other"), "/api/other", importance)).toBeNull();
  });

  it("finds a pane's OpenCode session id only in an id-kind ses_ session", () => {
    expect(paneSessionId(pane("p", "ses_x"))).toBe("ses_x");
    expect(paneSessionId(pane("p", "other"))).toBeNull();
    expect(paneSessionId(pane("p", null))).toBeNull();
  });
});

describe("wait clocks", () => {
  it("stamps a pane when its status or seq changes, keeps the stamp otherwise, and survives a restart", () => {
    const dir = tempDir();
    const path = join(dir, "wait-clocks.json");
    let now = 1_000;
    const clocks = new WaitClocks(path, () => now, 0);
    const seqs = new Map([["p1", 5], ["p2", 7]]);
    expect(clocks.stamp([pane("p1", null, "idle"), pane("p2", null, "working")], (id) => seqs.get(id))).toEqual(new Map([["p1", { since: 1_000, status: "idle" }], ["p2", { since: 1_000, status: "working" }]]));
    now = 5_000;
    expect(clocks.stamp([pane("p1", null, "idle"), pane("p2", null, "working")], (id) => seqs.get(id)).get("p1")?.since).toBe(1_000);
    // a new state change seq restarts p2's clock, a new status p1's
    seqs.set("p2", 8);
    const waits = clocks.stamp([pane("p1", null, "done"), pane("p2", null, "working")], (id) => seqs.get(id));
    expect(waits.get("p1")).toEqual({ since: 5_000, status: "done" });
    expect(waits.get("p2")).toEqual({ since: 5_000, status: "working" });
    clocks.save();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.panes.p1).toEqual({ key: "5|done", since: 5_000, status: "done" });
    now = 9_000;
    const restarted = new WaitClocks(path, () => now, 0);
    expect(restarted.stamp([pane("p1", null, "done")], (id) => seqs.get(id)).get("p1")?.since).toBe(5_000);
  });

  it("forgets closed panes, but not on an empty read, and starts afresh from a damaged file", () => {
    const dir = tempDir();
    const path = join(dir, "wait-clocks.json");
    const clocks = new WaitClocks(path, () => 1, 0);
    clocks.stamp([pane("p1", null), pane("p2", null)], () => 1);
    clocks.stamp([], () => 1);
    clocks.stamp([pane("p2", null)], () => 1);
    clocks.save();
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).panes)).toEqual(["p2"]);
    clocks.forget("p2");
    clocks.save();
    expect(JSON.parse(readFileSync(path, "utf8")).panes).toEqual({});
    writeFileSync(path, "{not json");
    const fresh = new WaitClocks(path, () => 42, 0);
    expect(fresh.stamp([pane("p1", null)], () => 1).get("p1")?.since).toBe(42);
  });
});
