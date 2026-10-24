import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationPart, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { forgetTranscriptState, HistoryChanged, paneConversation, toolOutput } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { forgetOpencodeState, opencodeConversation, type OpencodeAnswer } from "./opencode.ts";
import {
  forgetOpencodeV1State,
  opencodeV1Configured,
  opencodeV1Conversation,
  opencodeV1Image,
  opencodeV1Mode,
  opencodeV1Options,
  opencodeV1Signature,
  opencodeV1ToolOutput,
  OpencodeServe,
  serveEnvironment,
  stopOpencodeV1,
  type ServeChild,
  type ServeDeps,
} from "./opencode-v1.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-opencode-v1-"));
const opened: Database[] = [];
afterAll(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

const T0 = Date.parse("2026-10-07T09:00:00Z");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Item = { info: Record<string, unknown>; parts: Record<string, unknown>[] };

/**
 * A stand-in for OpenCode 1.x's own server: the GET routes the HTTP source reads, answering in
 * their shape (`{ info, parts }`, oldest first, `X-Next-Cursor` for what comes before).
 */
class FakeServer {
  readonly sessions = new Map<string, { info: Record<string, unknown>; messages: Item[] }>();
  requests: string[] = [];
  failing = false;
  password: string | null = null;
  private clock = T0;
  private ids = 0;
  private readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.answer(request) });

  get url(): string { return this.server.url.origin; }

  session(id = "ses_fixture1"): { id: string; user: (text: string, parts?: Record<string, unknown>[]) => string; assistant: (parts: Record<string, unknown>[], extra?: Record<string, unknown>) => string } {
    this.sessions.set(id, { info: { id, title: "Fixture", version: "1.19.0", time: { created: T0, updated: T0 } }, messages: [] });
    const add = (role: string, parts: Record<string, unknown>[], extra: Record<string, unknown>): string => {
      const messageId = `msg_${(++this.ids).toString().padStart(6, "0")}FIX`;
      this.clock += 1;
      const info = { id: messageId, sessionID: id, role, time: { created: this.clock, ...(role === "assistant" ? { completed: this.clock } : {}) }, ...extra };
      this.sessions.get(id)!.messages.push({ info, parts: parts.map((part, index) => ({ id: `prt_${messageId}${index}`, sessionID: id, messageID: messageId, ...part })) });
      return messageId;
    };
    return {
      id,
      user: (text, parts = []) => add("user", [{ type: "text", text }, ...parts], { agent: "build", model: { providerID: "fixture", modelID: "fixture-model" } }),
      assistant: (parts, extra = {}) => add("assistant", parts, { modelID: "fixture-model", providerID: "fixture", ...extra }),
    };
  }

  stop(): void { this.server.stop(true); }

  private answer(request: Request): Response {
    const url = new URL(request.url);
    this.requests.push(`${url.pathname}${url.search}`);
    if (request.method !== "GET") return new Response("read-only fixture", { status: 405 });
    if (this.password !== null && request.headers.get("authorization") !== `Basic ${btoa(`opencode:${this.password}`)}`) return new Response(null, { status: 401 });
    if (this.failing) return new Response("down", { status: 500 });
    if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.19.0" });
    const match = /^\/session\/([^/]+)(\/message(?:\/([^/]+))?)?$/.exec(url.pathname);
    const session = match === null ? undefined : this.sessions.get(decodeURIComponent(match[1]!));
    if (session === undefined) return Response.json({ name: "NotFoundError" }, { status: 404 });
    if (match![2] === undefined) return Response.json(session.info);
    if (match![3] !== undefined) {
      const found = session.messages.find((item) => item.info.id === decodeURIComponent(match![3]!));
      return found === undefined ? Response.json({ name: "NotFoundError" }, { status: 404 }) : Response.json(found);
    }
    const before = url.searchParams.get("before");
    let end = session.messages.length;
    if (before !== null) {
      const { id } = JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as { id: string };
      end = session.messages.findIndex((item) => item.info.id === id);
      if (end < 0) return Response.json({ name: "BadRequest" }, { status: 400 });
    }
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : end;
    const start = Math.max(0, end - limit);
    const page = session.messages.slice(start, end);
    const headers: Record<string, string> = {};
    if (start > 0) headers["X-Next-Cursor"] = Buffer.from(JSON.stringify({ id: page[0]!.info.id, time: page[0]!.info.time })).toString("base64url");
    return Response.json(page, { headers });
  }
}

/** The same session in a 1.x store, the way its tables hold it: what the HTTP source must read alike. */
function storeOf(server: FakeServer, sessionId: string): string {
  const path = join(root, `store-${opened.length}.db`);
  const db = new Database(path, { create: true });
  opened.push(db);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.query("INSERT INTO session VALUES (?, 'global', 'slug', '/fixture', 'Fixture', '1.19.0', NULL, ?, ?)").run(sessionId, T0, T0);
  for (const item of server.sessions.get(sessionId)!.messages) {
    const created = (item.info.time as { created: number }).created;
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(item.info.id as string, sessionId, created, created, JSON.stringify(item.info));
    item.parts.forEach((part, index) => {
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(part.id as string, item.info.id as string, sessionId, created + index / 100, created, JSON.stringify(part));
    });
  }
  return path;
}

const page = (answer: OpencodeAnswer | null) => {
  if (answer?.kind !== "page") throw new Error(`expected a page, got ${JSON.stringify(answer)}`);
  return answer;
};
const prompts = (answer: { turns: { role: string; parts: ConversationPart[] }[] }) =>
  answer.turns.filter((turn) => turn.role === "user").map((turn) => (turn.parts[0] as { text: string }).text);

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  opencodeV1Options.env = { OVIS_OPENCODE_URL: server.url };
  forgetOpencodeV1State();
  forgetOpencodeState();
});
afterEach(async () => {
  server.stop();
  delete opencodeV1Options.env;
  delete opencodeV1Options.deps;
  delete opencodeV1Options.serve;
  await stopOpencodeV1();
});

describe("where the HTTP source is", () => {
  it("is off unless asked for, and asks nothing to find that out", () => {
    expect(opencodeV1Mode({})).toBeNull();
    expect(opencodeV1Mode({ OVIS_OPENCODE_SERVE: "0", OVIS_OPENCODE_BIN: "/opt/opencode" })).toBeNull();
    opencodeV1Options.env = {};
    expect(opencodeV1Configured()).toBe(false);
  });

  it("takes a plain http(s) URL, with OpenCode's own server password, and refuses anything else", () => {
    expect(opencodeV1Mode({ OVIS_OPENCODE_URL: "http://127.0.0.1:4100/" })).toEqual({ kind: "url", endpoint: { baseUrl: "http://127.0.0.1:4100", authorization: null } });
    expect(opencodeV1Mode({ OVIS_OPENCODE_URL: "https://example.test/oc/", OPENCODE_SERVER_USERNAME: "someone", OPENCODE_SERVER_PASSWORD: "fixture" }))
      .toEqual({ kind: "url", endpoint: { baseUrl: "https://example.test/oc", authorization: `Basic ${btoa("someone:fixture")}` } });
    expect(opencodeV1Mode({ OVIS_OPENCODE_URL: "http://127.0.0.1:4100", OPENCODE_SERVER_PASSWORD: "fixture" })?.kind === "url").toBe(true);
    for (const url of ["ftp://127.0.0.1/", "not a url", "http://user:secret@127.0.0.1/", "http://127.0.0.1/?a=1"]) {
      expect(opencodeV1Mode({ OVIS_OPENCODE_URL: url })).toBeNull();
    }
    // a named server wins over starting one
    expect(opencodeV1Mode({ OVIS_OPENCODE_URL: "http://127.0.0.1:4100", OVIS_OPENCODE_SERVE: "1" })?.kind).toBe("url");
    expect(opencodeV1Mode({ OVIS_OPENCODE_SERVE: "1" })).toEqual({ kind: "serve", bin: "opencode" });
    expect(opencodeV1Mode({ OVIS_OPENCODE_SERVE: "1", OVIS_OPENCODE_BIN: "/opt/opencode" })).toEqual({ kind: "serve", bin: "/opt/opencode" });
  });

  it("sends the password it was given", async () => {
    server.password = "fixture-pass";
    const s = server.session();
    s.user("hello");
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    opencodeV1Options.env = { OVIS_OPENCODE_URL: server.url, OPENCODE_SERVER_PASSWORD: "fixture-pass" };
    expect(prompts(page(await opencodeV1Conversation(s.id)))).toEqual(["hello"]);
  });
});

describe("a session read from OpenCode's server", () => {
  it("maps messages exactly as the 1.x store reader does", async () => {
    const s = server.session();
    s.user("first prompt", [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }]);
    s.assistant([
      { type: "step-start" },
      { type: "reasoning", text: "think it through" },
      { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "echo hi" }, output: "hi", metadata: { exit: 0 } } },
      { type: "tool", tool: "read", callID: "call_2", state: { status: "completed", input: { filePath: "big.log" }, output: "y".repeat(5000) } },
      { type: "step-finish" },
    ], { finish: "tool-calls" });
    s.assistant([{ type: "text", text: "done" }], { finish: "stop", tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } } });
    const served = page(await opencodeV1Conversation(s.id));
    const stored = page(opencodeConversation(storeOf(server, s.id), s.id));
    expect(served.turns).toEqual(stored.turns);
    expect(served.metadata).toEqual(stored.metadata);
    expect(served.metadata).toEqual({ model: "fixture-model", reasoning_effort: null, context: { used: 116, window: null } });
    expect(served.cursor).toBeNull();
    expect(served.history_id).toBe(`opencode-http-${s.id}`);
    expect(served.turns[1]!.parts.at(-1)).toEqual({ kind: "text", text: "done", phase: "final_answer" });
  });

  it("serves a cut tool output and a picture by the refs the page gave them", async () => {
    const s = server.session();
    const prompt = s.user("look", [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }]);
    s.assistant([{ type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input: { filePath: "big.log" }, output: "y".repeat(5000) } }], { finish: "stop" });
    const tool = page(await opencodeV1Conversation(s.id)).turns.flatMap((turn) => turn.parts)
      .find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool")!;
    expect(await opencodeV1ToolOutput(s.id, tool.output_ref!)).toBe("y".repeat(5000));
    expect(Buffer.from((await opencodeV1Image(s.id, `opencode:${prompt}:0`))!.bytes).equals(PNG)).toBe(true);
    expect(await opencodeV1Image(s.id, `opencode:${prompt}:1`)).toBeNull();
    expect(await opencodeV1ToolOutput(s.id, "msg_000999FIX:0")).toBeNull();
    // a session this server does not hold is left to the store
    expect(await opencodeV1ToolOutput("ses_elsewhere1", tool.output_ref!)).toBeUndefined();
  });

  it("pages a long session by prompt, walking back in chunks, and the pages meet exactly", async () => {
    const s = server.session();
    for (let n = 0; n < 120; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const newest = page(await opencodeV1Conversation(s.id));
    expect(newest.turns.length).toBe(100);
    expect(prompts(newest)[0]).toBe("p70");
    expect(newest.cursor).toMatch(/^opencode-http-ses_fixture1:msg_\w+\.[\w-]+$/);
    // never one request for the whole session
    expect(server.requests.some((path) => /\/message$/.test(path))).toBe(false);
    const middle = page(await opencodeV1Conversation(s.id, { before: newest.cursor! }));
    const oldest = page(await opencodeV1Conversation(s.id, { before: middle.cursor! }));
    expect(oldest.cursor).toBeNull();
    expect([...prompts(oldest), ...prompts(middle), ...prompts(newest)]).toEqual(Array.from({ length: 120 }, (_, n) => `p${n}`));
    // with `since`, an older page never reaches back past it
    const bounded = page(await opencodeV1Conversation(s.id, { before: newest.cursor!, since: middle.cursor! }));
    expect(bounded.cursor).toBe(middle.cursor);
    expect(prompts(bounded)).toEqual(prompts(middle));
    expect(page(await opencodeV1Conversation(s.id, { before: middle.cursor!, since: middle.cursor! })).turns).toEqual([]);
    // the same page asked again is the same answer
    expect(page(await opencodeV1Conversation(s.id)).signature).toBe(newest.signature);
  });

  it("holds a chat's start while it is inside the newest page, and moves on once it is not", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const newest = page(await opencodeV1Conversation(s.id));
    const held = page(await opencodeV1Conversation(s.id, { from: newest.cursor! }));
    expect(held.cursor).toBe(newest.cursor);
    expect(held.turns).toEqual(newest.turns);
    s.user("p60");
    s.assistant([{ type: "text", text: "a60" }], { finish: "stop" });
    const moved = page(await opencodeV1Conversation(s.id, { from: newest.cursor! }));
    // the newest page moved one prompt on: the chat fetches the turn in between with before + since
    expect(moved.cursor).not.toBe(newest.cursor);
    expect(prompts(moved)[0]).toBe("p11");
    const between = page(await opencodeV1Conversation(s.id, { before: moved.cursor!, since: newest.cursor! }));
    expect(between.turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "p10" }], [{ kind: "text", text: "a10", phase: "final_answer" }]]);
    expect(between.cursor).toBe(newest.cursor);
  });

  it("refuses a cursor from another history or one naming a message that is gone", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const newest = page(await opencodeV1Conversation(s.id));
    const [, rest] = newest.cursor!.split(":");
    expect(await opencodeV1Conversation(s.id, { before: `opencode-http-ses_other1:${rest}` })).toEqual({ kind: "history_changed" });
    expect(await opencodeV1Conversation(s.id, { before: `opencode-ses_fixture1:${rest}` })).toEqual({ kind: "history_changed" });
    expect(await opencodeV1Conversation(s.id, { from: `opencode-http-ses_fixture1:12` })).toEqual({ kind: "history_changed" });
    // a held start or a cursor naming a message the session no longer holds
    const gone = `opencode-http-ses_fixture1:msg_000999FIX.${rest!.split(".")[1]}`;
    expect(await opencodeV1Conversation(s.id, { from: gone })).toEqual({ kind: "history_changed" });
    expect(await opencodeV1Conversation(s.id, { before: gone })).toEqual({ kind: "history_changed" });
  });

  it("hides what a staged /undo took back, under another history id", async () => {
    const s = server.session();
    for (let n = 0; n < 3; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const taken = s.user("taken back");
    s.assistant([{ type: "text", text: "undone" }], { finish: "stop" });
    const before = page(await opencodeV1Conversation(s.id));
    server.sessions.get(s.id)!.info.revert = { messageID: taken };
    const after = page(await opencodeV1Conversation(s.id));
    expect(after.history_id).toBe(`opencode-http-${s.id}-r${taken}`);
    expect(after.history_id).not.toBe(before.history_id);
    expect(prompts(after)).toEqual(["p0", "p1", "p2"]);
    expect(await opencodeV1ToolOutput(s.id, `${taken}:0`)).toBeNull();
  });

  it("answers nothing when the server is down or failing, so the caller keeps its fallback", async () => {
    const s = server.session();
    s.user("hello");
    expect(await opencodeV1Conversation("ses_elsewhere1")).toEqual({ kind: "unavailable", reason: "session_not_found" });
    server.failing = true;
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    expect(await opencodeV1ToolOutput(s.id, "msg_000001FIX:0")).toBeUndefined();
    server.stop();
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    expect(await opencodeV1Signature(s.id)).toBeNull();
  });

  it("signs the session and its newest message, which change as a step streams", async () => {
    const s = server.session();
    s.user("hello");
    const first = await opencodeV1Signature(s.id);
    expect(first).toBeString();
    expect(await opencodeV1Signature(s.id)).toBe(first);
    const messages = server.sessions.get(s.id)!.messages;
    messages.at(-1)!.parts[0]!.text = "hello again";
    expect(await opencodeV1Signature(s.id)).not.toBe(first);
  });
});

describe("a pane's chat with the HTTP source", () => {
  const restores: Array<() => void> = [];
  let panes: HerdrPane[] = [];
  beforeEach(() => {
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method !== "pane.process_info") throw new Error(`unexpected fixture RPC: ${method}`);
      return { process_info: { foreground_processes: [{ argv: ["/usr/local/bin/opencode"] }] } } as never;
    });
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes, agents: [] } as unknown as SessionSnapshot));
    restores.push(() => rpc.mockRestore(), () => snapshot.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    panes = [];
    forgetTranscriptState();
  });
  const paneOf = (session: string) => ({ pane_id: "pane-oc", cwd: "/fixture", agent: "opencode", agent_session: { source: "herdr:opencode", agent: "opencode", kind: "id", value: session } }) as HerdrPane;

  it("reads the server, not a stale store, and leaves the store alone when it is off or failing", async () => {
    const s = server.session();
    s.user("from the store");
    s.assistant([{ type: "text", text: "stale" }], { finish: "stop" });
    const db = storeOf(server, s.id);
    s.user("only on the server");
    panes = [paneOf(s.id)];

    const served = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(served.source).toBe("opencode-http");
    expect(prompts(served)).toEqual(["from the store", "only on the server"]);
    expect(served.version).toBeString();

    const tool = await toolOutput("pane-oc", "msg_000002FIX:0", undefined, db);
    expect(tool).toBeNull();

    // the server failing: the store answers, as it always did
    server.failing = true;
    const fallback = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(fallback.source).toBe("opencode-transcript");
    expect(prompts(fallback)).toEqual(["from the store"]);
    server.failing = false;

    // off: the store, and not one request to any server
    opencodeV1Options.env = {};
    server.requests = [];
    const off = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(off.source).toBe("opencode-transcript");
    expect(off.turns).toEqual(fallback.turns);
    expect(server.requests).toEqual([]);
  });

  it("refuses the server's cursor once the store stands in for it", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const db = storeOf(server, s.id);
    panes = [paneOf(s.id)];
    const served = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(served.source).toBe("opencode-http");
    server.failing = true;
    await expect(paneConversation("pane-oc", undefined, { before: served.cursor! }, undefined, db)).rejects.toBeInstanceOf(HistoryChanged);
  });
});

/** A started server's lifecycle, against a clock and a process of its own. */
function fakeDeps() {
  let clock = 0;
  const spawned: { argv: string[]; env: Record<string, string>; signals: string[]; exit: () => void }[] = [];
  let healthy = true;
  const deps: ServeDeps = {
    spawn(argv, env) {
      const exited = Promise.withResolvers<void>();
      const entry = { argv, env, signals: [] as string[], exit: () => exited.resolve() };
      spawned.push(entry);
      const child: ServeChild = { exited: exited.promise, kill: (signal) => { entry.signals.push(signal); exited.resolve(); } };
      return child;
    },
    freePort: async () => 40_000 + spawned.length,
    ready: async () => { clock += 100; return healthy; },
    now: () => clock,
  };
  return { deps, spawned, advance: (ms: number) => { clock += ms; }, setHealthy: (value: boolean) => { healthy = value; } };
}

describe("the server this one starts", () => {
  it("starts one on first use, on loopback, with its own password and no pane identity", async () => {
    const fake = fakeDeps();
    const serve = new OpencodeServe("/opt/opencode", { PATH: "/bin", HERDR_PANE_ID: "w1:p1", HERDR_ENV: "1", OPENCODE_SERVER_PASSWORD: "theirs" }, fake.deps, { readyPollMs: 1 });
    expect(serve.state).toBe("idle");
    expect(fake.spawned).toEqual([]);
    const [one, two] = await Promise.all([serve.endpoint(), serve.endpoint()]);
    expect(one).toEqual(two);
    expect(fake.spawned.length).toBe(1);
    expect(fake.spawned[0]!.argv).toEqual(["/opt/opencode", "serve", "--port", "40000", "--hostname", "127.0.0.1"]);
    const env = fake.spawned[0]!.env;
    expect(Object.keys(env).some((key) => key.startsWith("HERDR_"))).toBe(false);
    expect(env["PATH"]).toBe("/bin");
    expect(env["OPENCODE_SERVER_PASSWORD"]).not.toBe("theirs");
    expect(one).toEqual({ baseUrl: "http://127.0.0.1:40000", authorization: `Basic ${btoa(`opencode:${env["OPENCODE_SERVER_PASSWORD"]}`)}` });
    expect(serve.state).toBe("ready");
    await serve.stop();
    expect(fake.spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(await serve.endpoint()).toBeNull();
    expect(fake.spawned.length).toBe(1);
  });

  it("starts it again after it dies, once a backoff that grows with each failure has passed", async () => {
    const fake = fakeDeps();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const serve = new OpencodeServe("opencode", {}, fake.deps, { readyPollMs: 1, startTimeoutMs: 500, minBackoffMs: 1_000, maxBackoffMs: 4_000 });
    expect(await serve.endpoint()).not.toBeNull();
    fake.spawned[0]!.exit();
    await tick();
    expect(serve.state).toBe("backoff");
    expect(await serve.endpoint()).toBeNull();
    expect(fake.spawned.length).toBe(1);

    // one that never answers its health check is stopped, and the next wait doubles
    fake.advance(1_000);
    fake.setHealthy(false);
    expect(await serve.endpoint()).toBeNull();
    await tick();
    expect(fake.spawned[1]!.signals).toEqual(["SIGTERM"]);
    expect(serve.state).toBe("backoff");
    fake.advance(1_999);
    expect(serve.state).toBe("backoff");
    fake.advance(1);
    expect(serve.state).toBe("idle");
    expect(await serve.endpoint()).toBeNull();
    await tick();
    fake.advance(3_999);
    expect(serve.state).toBe("backoff");
    fake.advance(1);
    fake.setHealthy(true);
    expect(await serve.endpoint()).toEqual({ baseUrl: "http://127.0.0.1:40003", authorization: expect.any(String) as unknown as string });
    expect(fake.spawned.length).toBe(4);

    // a server that was up starts the count again: its death waits the first backoff only
    fake.spawned[3]!.exit();
    await tick();
    fake.advance(999);
    expect(serve.state).toBe("backoff");
    fake.advance(1);
    expect(serve.state).toBe("idle");
    await serve.stop();
  });

  it("gives a caller its fallback while a slow start goes on", async () => {
    const fake = fakeDeps();
    const answered = Promise.withResolvers<boolean>();
    const slow: ServeDeps = { ...fake.deps, ready: () => answered.promise };
    const serve = new OpencodeServe("opencode", {}, slow, { readyPollMs: 1, waitMs: 5 });
    expect(await serve.endpoint()).toBeNull();
    expect(serve.state).toBe("starting");
    answered.resolve(true);
    expect(await serve.endpoint()).not.toBeNull();
    expect(fake.spawned.length).toBe(1);
    await serve.stop();
  });

  it("keeps herdr's pane identity and the user's server password out of the environment", () => {
    expect(serveEnvironment({ HOME: "/home/fixture", HERDR_SOCKET_PATH: "/x", OPENCODE_SERVER_USERNAME: "other" }, "fresh"))
      .toEqual({ HOME: "/home/fixture", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "fresh" });
  });

  it("is started through the environment's OVIS_OPENCODE_SERVE=1 and read from like a named one", async () => {
    const s = server.session();
    s.user("hello");
    const fake = fakeDeps();
    const port = Number(new URL(server.url).port);
    opencodeV1Options.env = { OVIS_OPENCODE_SERVE: "1", OVIS_OPENCODE_BIN: "/opt/opencode" };
    opencodeV1Options.deps = { ...fake.deps, freePort: async () => port };
    opencodeV1Options.serve = { readyPollMs: 1 };
    const answer = await opencodeV1Conversation(s.id);
    // the fixture checks no password; the started server would
    expect(prompts(page(answer))).toEqual(["hello"]);
    expect(fake.spawned.map((entry) => entry.argv[0])).toEqual(["/opt/opencode"]);
    await stopOpencodeV1();
    expect(fake.spawned[0]!.signals).toEqual(["SIGTERM"]);
  });
});
