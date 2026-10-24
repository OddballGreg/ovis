import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationPart, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationMonitor } from "./conversation-monitor.ts";
import { ConversationUnavailable, forgetTranscriptState, HistoryChanged, paneConversation, toolOutput } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { forgetOpencodeState, opencodeConversation, type OpencodeAnswer } from "./opencode.ts";
import {
  forgetOpencodeV1State,
  OPENCODE_V1_HELD_BYTES,
  OPENCODE_V1_INCOMPATIBLE_STARTS,
  OPENCODE_V1_MAX_WALK_REQUESTS,
  OPENCODE_V1_NOT_FOUND_MS,
  OPENCODE_V1_PIN_MS,
  opencodeV1Changes,
  opencodeV1Configured,
  opencodeV1Conversation,
  opencodeV1Endpoint,
  opencodeV1HeldBytes,
  opencodeV1Image,
  opencodeV1Mode,
  opencodeV1Options,
  opencodeV1Serving,
  opencodeV1Signature,
  opencodeV1State,
  opencodeV1ToolOutput,
  opencodeV1Version,
  OpencodeServe,
  reapOpencodeV1Orphans,
  resetOpencodeV1,
  serveEnvironment,
  stopOpencodeV1,
  stopOpencodeV1Now,
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
  /** what its health check says it is */
  version = "1.19.0";
  /** called before a message list is answered, with its query */
  onList: ((search: URLSearchParams) => void) | null = null;
  private clock = T0;
  private ids = 0;
  private readonly streams = new Set<ReadableStreamDefaultController<string>>();
  private readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (request) => this.answer(request) });

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

  /** Open event streams, as OpenCode's `/global/event` wraps them. */
  get listeners(): number { return this.streams.size; }

  push(payload: Record<string, unknown>): void {
    for (const stream of this.streams) stream.enqueue(`data: ${JSON.stringify({ directory: "/fixture", payload })}\n\n`);
  }

  stop(): void {
    for (const stream of this.streams) { try { stream.close(); } catch { /* closed */ } }
    this.streams.clear();
    this.server.stop(true);
  }

  private answer(request: Request): Response {
    const url = new URL(request.url);
    this.requests.push(`${url.pathname}${url.search}`);
    if (request.method !== "GET") return new Response("read-only fixture", { status: 405 });
    if (this.password !== null && request.headers.get("authorization") !== `Basic ${btoa(`opencode:${this.password}`)}`) return new Response(null, { status: 401 });
    if (this.failing) return new Response("down", { status: 500 });
    if (url.pathname === "/global/health") return Response.json({ healthy: true, version: this.version });
    if (url.pathname === "/global/event") {
      let controller: ReadableStreamDefaultController<string>;
      const body = new ReadableStream<string>({
        start: (opened) => {
          controller = opened;
          this.streams.add(opened);
          opened.enqueue(`data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`);
        },
        cancel: () => { this.streams.delete(controller); },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    const match = /^\/session\/([^/]+)(\/message(?:\/([^/]+))?)?$/.exec(url.pathname);
    const session = match === null ? undefined : this.sessions.get(decodeURIComponent(match[1]!));
    if (session === undefined) return Response.json({ name: "NotFoundError" }, { status: 404 });
    if (match![2] === undefined) return Response.json(session.info);
    if (match![3] !== undefined) {
      const found = session.messages.find((item) => item.info.id === decodeURIComponent(match![3]!));
      return found === undefined ? Response.json({ name: "NotFoundError" }, { status: 404 }) : Response.json(found);
    }
    this.onList?.(url.searchParams);
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

/** Wait for `check`, polling, until a deadline. */
async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting");
}

/** Whether a process runs (a zombie an orphan left until its new parent reaps it does not). */
const alive = (pid: number): boolean => {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const listRequests = (requests: string[]) => requests.filter((path) => /\/message\?/.test(path) && !path.includes("limit=1&") && !path.endsWith("limit=1"));

let server: FakeServer;
let stateDir: string;
beforeEach(async () => {
  await resetOpencodeV1();
  server = new FakeServer();
  stateDir = mkdtempSync(join(root, "state-"));
  opencodeV1Options.env = { HERDR_WEB_OPENCODE_URL: server.url };
  opencodeV1Options.stateDir = stateDir;
  forgetOpencodeState();
});
afterEach(async () => {
  server.stop();
  for (const key of ["env", "deps", "serve", "stateDir", "now", "windowBytes", "heldBytes"] as const) delete opencodeV1Options[key];
  await resetOpencodeV1();
});

describe("where the HTTP source is", () => {
  it("is off unless asked for, and asks nothing to find that out", () => {
    expect(opencodeV1Mode({})).toBeNull();
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_SERVE: "0", HERDR_WEB_OPENCODE_BIN: "/opt/opencode" })).toBeNull();
    opencodeV1Options.env = {};
    expect(opencodeV1Configured()).toBe(false);
  });

  it("takes a plain http(s) URL, with OpenCode's own server password, and refuses anything else", () => {
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: "http://127.0.0.1:4100/" })).toEqual({ kind: "url", endpoint: { baseUrl: "http://127.0.0.1:4100", authorization: null } });
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: "https://example.test/oc/", OPENCODE_SERVER_USERNAME: "someone", OPENCODE_SERVER_PASSWORD: "fixture" }))
      .toEqual({ kind: "url", endpoint: { baseUrl: "https://example.test/oc", authorization: `Basic ${btoa("someone:fixture")}` } });
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: "http://127.0.0.1:4100", OPENCODE_SERVER_PASSWORD: "fixture" })?.kind === "url").toBe(true);
    for (const url of ["ftp://127.0.0.1/", "not a url", "http://user:secret@127.0.0.1/", "http://127.0.0.1/?a=1"]) {
      expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: url })).toBeNull();
    }
    // a named server wins over starting one
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: "http://127.0.0.1:4100", HERDR_WEB_OPENCODE_SERVE: "1" })?.kind).toBe("url");
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_SERVE: "1" })).toEqual({ kind: "serve", bin: "opencode" });
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_SERVE: "1", HERDR_WEB_OPENCODE_BIN: "/opt/opencode" })).toEqual({ kind: "serve", bin: "/opt/opencode" });
  });

  it("never sends a password over plain http to another host", () => {
    const withPassword = (url: string) => opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: url, OPENCODE_SERVER_PASSWORD: "fixture" });
    expect(withPassword("http://192.0.2.10:4096")).toBeNull();
    expect(withPassword("http://example.test/oc")).toBeNull();
    for (const url of ["http://127.0.0.1:4096", "http://127.1.2.3:4096", "http://localhost:4096", "http://[::1]:4096", "https://example.test/oc"]) {
      expect(withPassword(url)?.kind).toBe("url");
    }
    // without one, any host is a server the user named
    expect(opencodeV1Mode({ HERDR_WEB_OPENCODE_URL: "http://192.0.2.10:4096" })?.kind).toBe("url");
  });

  it("knows OpenCode 1.x by its health check's version", () => {
    for (const version of ["1.19.0", "1.0.0-beta.3", "0.0.0-fix/some-branch-v1.19.0-202610240522", "0.0.0-dev-v1.19.0", "0.0.0-v1.2.3"]) expect(opencodeV1Version(version)).toBe(true);
    for (const version of ["2.0.0", "0.9.1", "0.0.0-dev-202610240522", "0.0.0-dev-v1.19.0.1", "0.0.0-dev-v1.19", "0.0.0-dev-v10.1.0", "0.0.0-try-v1.2.3x", "2.0.0-dev-v1.2.3", "", undefined, 1]) expect(opencodeV1Version(version)).toBe(false);
  });

  it("sends the password it was given", async () => {
    server.password = "fixture-pass";
    const s = server.session();
    s.user("hello");
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_URL: server.url, OPENCODE_SERVER_PASSWORD: "fixture-pass" };
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

  it("asks again for the newest chunk only: older chunks stay as the server gave them", async () => {
    const s = server.session();
    for (let n = 0; n < 120; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const first = page(await opencodeV1Conversation(s.id));
    const walked = listRequests(server.requests);
    expect(walked.length).toBeGreaterThan(1);
    server.requests = [];
    s.user("p120");
    const second = page(await opencodeV1Conversation(s.id));
    expect(prompts(second).at(-1)).toBe("p120");
    // the newest chunk again, and the chunk the page now starts in, asked again ending at its start
    expect(listRequests(server.requests).filter((path) => path.includes("before=")).length).toBeLessThanOrEqual(1);
    expect(listRequests(server.requests).filter((path) => !path.includes("before="))).toEqual([walked[0]!]);
    expect(second.cursor).not.toBe(first.cursor);
  });

  it("stops walking back after a set number of requests, at the earliest prompt it fetched", async () => {
    const s = server.session();
    s.user("too far back");
    for (let n = 0; n < 6_000; n++) {
      if (n === 1_000) s.user("reached");
      else s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" });
    }
    const answer = page(await opencodeV1Conversation(s.id));
    expect(listRequests(server.requests).filter((path) => /limit=(?:32|64|128|256)(?:&|$)/.test(path)).length).toBe(OPENCODE_V1_MAX_WALK_REQUESTS);
    expect(prompts(answer)).toEqual(["reached"]);
    expect(answer.cursor).not.toBeNull();
  });

  it("starts the page at a chunk's oldest message when the newest chunk grew between two requests", async () => {
    opencodeV1Options.windowBytes = 4_000;
    const s = server.session();
    for (let n = 0; n < 40; n++) s.assistant([{ type: "text", text: `${"x".repeat(400)}${n}` }], { finish: "stop" });
    let lists = 0;
    server.onList = () => { if (++lists === 2) s.assistant([{ type: "text", text: "grew" }], { finish: "stop" }); };
    const answer = page(await opencodeV1Conversation(s.id));
    expect(lists).toBe(2);
    // the window ends mid-chunk; the chunk asked again no longer ends there, so the page takes the whole chunk
    const first = server.sessions.get(s.id)!.messages[8]!;
    expect(answer.cursor).toBe(`opencode-http-${s.id}:${first.info.id as string}.${Buffer.from(JSON.stringify({ id: first.info.id, time: first.info.time })).toString("base64url")}`);
    const texts = answer.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "text").map((part) => (part as { text: string }).text);
    expect(texts.length).toBe(32);
    expect(texts[0]).toBe(`${"x".repeat(400)}8`);
  });

  it("hides an undo's messages when its message is beyond the newest chunk", async () => {
    const s = server.session();
    let taken = "";
    for (let n = 0; n < 40; n++) {
      const id = s.user(`p${n}`);
      if (n === 10) taken = id;
      s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" });
    }
    server.sessions.get(s.id)!.info.revert = { messageID: taken };
    const answer = page(await opencodeV1Conversation(s.id));
    expect(answer.history_id).toBe(`opencode-http-${s.id}-r${taken}`);
    expect(prompts(answer)).toEqual(Array.from({ length: 10 }, (_, n) => `p${n}`));
    expect(answer.cursor).toBeNull();
  });

  it("remembers a session the server does not hold for a while, and asks nothing about it meanwhile", async () => {
    let clock = 1_000_000;
    opencodeV1Options.now = () => clock;
    expect(await opencodeV1Conversation("ses_elsewhere1")).toEqual({ kind: "unavailable", reason: "session_not_found" });
    server.requests = [];
    expect(await opencodeV1Conversation("ses_elsewhere1")).toEqual({ kind: "unavailable", reason: "session_not_found" });
    expect(await opencodeV1ToolOutput("ses_elsewhere1", "msg_000001FIX:0")).toBeUndefined();
    expect(await opencodeV1Signature("ses_elsewhere1")).toBeNull();
    expect(server.requests).toEqual([]);
    clock += OPENCODE_V1_NOT_FOUND_MS;
    const s = server.session("ses_elsewhere1");
    s.user("now here");
    expect(prompts(page(await opencodeV1Conversation(s.id)))).toEqual(["now here"]);
  });

  it("answers a session it served with its last page when the server fails, never handing it back to the store", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    expect(opencodeV1Serving(s.id)).toBe(false);
    const newest = page(await opencodeV1Conversation(s.id));
    expect(opencodeV1Serving(s.id)).toBe(true);
    server.failing = true;
    expect(await opencodeV1Conversation(s.id)).toEqual(newest);
    expect(await opencodeV1Conversation(s.id, { before: newest.cursor! })).toEqual({ kind: "unavailable", reason: "store_busy" });
    expect(await opencodeV1ToolOutput(s.id, "msg_000002FIX:0")).toBeNull();
    server.stop();
    expect(await opencodeV1Conversation(s.id)).toEqual(newest);
  });

  it("falls back on an error it does not expect, and logs only the error's class", async () => {
    const s = server.session();
    s.user("hello");
    const lines: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
    const byteLength = Buffer.byteLength.bind(Buffer);
    // a failure inside the mapping that no check here expects, quoting what it was reading
    const broken = spyOn(Buffer, "byteLength").mockImplementation(((value: string, encoding?: BufferEncoding) => {
      if (typeof value === "string" && value.startsWith("{\"info\"")) throw new TypeError(`cannot read ${value}`);
      return byteLength(value, encoding);
    }) as typeof Buffer.byteLength);
    try {
      expect(await opencodeV1Conversation(s.id)).toBeNull();
      expect(await opencodeV1Conversation(s.id)).toBeNull();
    } finally {
      broken.mockRestore();
      log.mockRestore();
    }
    expect(lines).toEqual(["Reading a chat from the OpenCode server failed (TypeError); it is read from the fallback."]);
    expect(prompts(page(await opencodeV1Conversation(s.id)))).toEqual(["hello"]);
  });

  it("learns a server cursor only from the server, never from a cursor a chat sent back", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const newest = page(await opencodeV1Conversation(s.id));
    const [history, rest] = [newest.cursor!.slice(0, newest.cursor!.lastIndexOf(":")), newest.cursor!.slice(newest.cursor!.lastIndexOf(":") + 1)];
    const forged = `${history}:${rest.slice(0, rest.indexOf("."))}.Zm9yZ2Vk`;
    expect(page(await opencodeV1Conversation(s.id, { from: forged })).cursor).toBe(forged);
    forgetOpencodeV1State();
    expect(page(await opencodeV1Conversation(s.id)).cursor).toBe(newest.cursor);
    expect(page(await opencodeV1Conversation(s.id, { from: forged })).cursor).toBe(forged);
    expect(page(await opencodeV1Conversation(s.id)).cursor).toBe(newest.cursor);
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

    // off: the store, and not one request to any server
    opencodeV1Options.env = {};
    const off = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(off.source).toBe("opencode-transcript");
    expect(prompts(off)).toEqual(["from the store"]);
    expect(server.requests).toEqual([]);
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_URL: server.url };

    // failing before it ever answered for the session: the store answers, as it always did
    server.failing = true;
    const fallback = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(fallback.source).toBe("opencode-transcript");
    expect(fallback.turns).toEqual(off.turns);
    server.failing = false;

    const served = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(served.source).toBe("opencode-http");
    expect(prompts(served)).toEqual(["from the store", "only on the server"]);
    expect(served.version).toBeString();
    expect(await toolOutput("pane-oc", "msg_000002FIX:0", undefined, db)).toBeNull();

    // failing once it answered: its last page, not the stale store and its other history
    server.failing = true;
    const held = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(held.source).toBe("opencode-http");
    expect(held.turns).toEqual(served.turns);
    expect(held.version).toBe(served.version);
  });

  it("keeps the server's cursor away from the store once the server answered", async () => {
    const s = server.session();
    for (let n = 0; n < 60; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const db = storeOf(server, s.id);
    panes = [paneOf(s.id)];
    const served = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(served.source).toBe("opencode-http");
    server.failing = true;
    await expect(paneConversation("pane-oc", undefined, { before: served.cursor! }, undefined, db)).rejects.toBeInstanceOf(ConversationUnavailable);
    server.failing = false;
    // a cursor of the store's own history is the store's, and the server's is refused there
    expect((await paneConversation("pane-oc", undefined, { before: served.cursor! }, undefined, db)).source).toBe("opencode-http");
    await expect(paneConversation("pane-oc", undefined, { before: `opencode-${s.id}:12` }, undefined, db)).rejects.toBeInstanceOf(HistoryChanged);
  });

  it("watches a served session through the server, and only once a chat was read from it", async () => {
    const s = server.session();
    s.user("hello");
    const db = storeOf(server, s.id);
    panes = [paneOf(s.id)];
    const changes: string[] = [];
    const monitor = new ConversationMonitor((_pane, signature) => { changes.push(signature); }, undefined, undefined, db);
    try {
      monitor.watch("pane-oc");
      await until(() => changes.length >= 1);
      // the store answers until a chat is read from the server: no request, no started server
      // fixed wait: proving that the monitor asks the server nothing meanwhile
      await Bun.sleep(600);
      expect(server.requests).toEqual([]);

      await paneConversation("pane-oc", undefined, {}, undefined, db);
      expect(opencodeV1Serving(s.id)).toBe(true);
      await until(() => server.requests.some((path) => path.endsWith("/message?limit=1")));

      // a streaming step rewrites the newest message: the signature moves
      const before = changes.length;
      server.sessions.get(s.id)!.messages.at(-1)!.parts[0]!.text = "hello again";
      await until(() => changes.length > before);

      // an event naming the session is a change too, and then the stream is known to carry it
      await until(() => server.listeners > 0);
      const quiet = changes.length;
      server.push({ type: "message.part.updated", properties: { part: { id: "prt_1", sessionID: s.id, messageID: "msg_000001FIX" } } });
      await until(() => changes.length > quiet);
      expect(opencodeV1Changes(s.id)).toEqual({ count: 1, carried: true });
      server.push({ type: "message.part.delta", properties: { sessionID: "ses_another1", delta: "x" } });
      server.push({ type: "server.heartbeat", properties: {} });
      await until(() => opencodeV1Changes("ses_another1").count === 1);
      expect(opencodeV1Changes(s.id).count).toBe(1);
    } finally {
      monitor.stop();
    }
  });

  it("reads a chat from the server once a server that was still starting is up, though the store answered it first", async () => {
    const s = server.session();
    s.user("from the store");
    const db = storeOf(server, s.id);
    s.user("only on the server");
    panes = [paneOf(s.id)];
    const fake = fakeDeps();
    const answered = Promise.withResolvers<"ready">();
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_SERVE: "1" };
    opencodeV1Options.deps = { ...fake.deps, freePort: async () => Number(new URL(server.url).port), ready: () => answered.promise };
    opencodeV1Options.serve = { ...fast, waitMs: 5 };
    const first = await paneConversation("pane-oc", undefined, {}, undefined, db);
    expect(first.source).toBe("opencode-transcript");
    expect(opencodeV1State()).toBe("starting");
    const changes: string[] = [];
    const monitor = new ConversationMonitor((_pane, signature) => { changes.push(signature); }, undefined, undefined, db);
    try {
      monitor.watch("pane-oc");
      await until(() => changes.length >= 1);
      const before = changes.length;
      // the store did not change; the server came up, and that is a change the chat reads again on
      answered.resolve("ready");
      await until(() => changes.length > before);
      expect(opencodeV1State()).toBe("ready");
      const again = await paneConversation("pane-oc", undefined, {}, undefined, db);
      expect(again.source).toBe("opencode-http");
      expect(prompts(again)).toEqual(["from the store", "only on the server"]);
    } finally {
      monitor.stop();
    }
  });
});

describe("a server the user names", () => {
  it("is checked to be OpenCode 1.x once, and not read from when it is another version", async () => {
    const s = server.session();
    s.user("hello");
    expect(opencodeV1State()).toBe("starting");
    page(await opencodeV1Conversation(s.id));
    page(await opencodeV1Conversation(s.id));
    expect(server.requests.filter((path) => path === "/global/health")).toEqual(["/global/health"]);
    expect(opencodeV1State()).toBe("ready");

    await resetOpencodeV1();
    server.version = "2.0.0";
    server.requests = [];
    const lines: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
    try {
      expect(await opencodeV1Conversation(s.id)).toBeNull();
      expect(await opencodeV1Conversation(s.id)).toBeNull();
      expect(await opencodeV1Signature(s.id)).toBeNull();
    } finally {
      log.mockRestore();
    }
    expect(server.requests).toEqual(["/global/health"]);
    expect(opencodeV1State()).toBe("unavailable");
    expect(lines).toEqual(["The OpenCode server HERDR_WEB_OPENCODE_URL names is not OpenCode 1.x; chats are read from opencode.db until it changes or the app restarts."]);
  });
});

describe("a session read from the server, when the server stops answering for it", () => {
  it("goes back to the store once the server has failed it continuously for longer than the pin lasts", async () => {
    let clock = 1_000_000;
    opencodeV1Options.now = () => clock;
    const s = server.session();
    s.user("hello");
    const newest = page(await opencodeV1Conversation(s.id));
    server.failing = true;
    expect(await opencodeV1Conversation(s.id)).toEqual(newest);
    clock += OPENCODE_V1_PIN_MS - 1;
    // an answer in between starts the count over
    server.failing = false;
    page(await opencodeV1Conversation(s.id));
    server.failing = true;
    expect(await opencodeV1Signature(s.id)).toBeNull();
    clock += OPENCODE_V1_PIN_MS;
    expect(await opencodeV1Conversation(s.id)).toEqual(newest);
    expect(opencodeV1Serving(s.id)).toBe(true);
    clock += 1;
    expect(opencodeV1Serving(s.id)).toBe(false);
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    expect(await opencodeV1ToolOutput(s.id, "msg_000001FIX:0")).toBeUndefined();
  });

  it("goes back to the store for a session the server says it does not hold", async () => {
    const s = server.session();
    s.user("hello");
    page(await opencodeV1Conversation(s.id));
    expect(opencodeV1Serving(s.id)).toBe(true);
    server.sessions.delete(s.id);
    expect(await opencodeV1Conversation(s.id)).toEqual({ kind: "unavailable", reason: "session_not_found" });
    expect(opencodeV1Serving(s.id)).toBe(false);
    server.failing = true;
    expect(await opencodeV1Conversation(s.id)).toEqual({ kind: "unavailable", reason: "session_not_found" });
  });

  it("goes back to the store once the started server answers as another version", async () => {
    const s = server.session();
    s.user("hello");
    const fake = fakeDeps();
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_SERVE: "1" };
    opencodeV1Options.deps = { ...fake.deps, freePort: async () => Number(new URL(server.url).port) };
    opencodeV1Options.serve = fast;
    page(await opencodeV1Conversation(s.id));
    expect(opencodeV1Serving(s.id)).toBe(true);
    fake.spawned[0]!.exit(1);
    await tick();
    fake.advance(10_000);
    fake.setHealth("incompatible");
    expect(await opencodeV1Conversation(s.id)).toBeNull();
    expect(opencodeV1Serving(s.id)).toBe(false);
  });
});

describe("what the source holds of a session", () => {
  const big = (n: number) => ({ type: "text", text: `${"x".repeat(800)}${n}` });

  it("counts a message once, though a cached chunk and a walk's spine both hold it", async () => {
    opencodeV1Options.heldBytes = 1_000_000;
    opencodeV1Options.windowBytes = 500_000;
    const s = server.session();
    s.user("start");
    for (let n = 0; n < 100; n++) s.assistant([big(n)], { finish: "stop" });
    const answer = page(await opencodeV1Conversation(s.id));
    expect(answer.cursor).toBeNull();
    // the walk reached the start: its older chunks are cached and in its spine, every message once
    const total = server.sessions.get(s.id)!.messages.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    expect(opencodeV1HeldBytes()).toBe(total);
  });

  it("stays within its budget however many sessions and older pages are read", async () => {
    const budget = 60_000;
    opencodeV1Options.heldBytes = budget;
    opencodeV1Options.windowBytes = 8_000;
    let peak = 0;
    for (let n = 0; n < 6; n++) {
      const s = server.session(`ses_budget${n}`);
      for (let m = 0; m < 150; m++) { s.user(`p${m}`); s.assistant([big(m)], { finish: "stop" }); }
      let answer = page(await opencodeV1Conversation(s.id));
      peak = Math.max(peak, opencodeV1HeldBytes());
      for (let older = 0; older < 8 && answer.cursor !== null; older++) {
        answer = page(await opencodeV1Conversation(s.id, { before: answer.cursor }));
        peak = Math.max(peak, opencodeV1HeldBytes());
        expect(opencodeV1HeldBytes()).toBeLessThanOrEqual(budget);
      }
    }
    expect(peak).toBeGreaterThan(budget / 2);
    expect(peak).toBeLessThanOrEqual(budget);
    expect(OPENCODE_V1_HELD_BYTES).toBe(64 * 1024 * 1024);
  });
});

/** A started server's lifecycle, against a clock and a process of its own. */
function fakeDeps(options: { stubborn?: boolean } = {}) {
  let clock = 0;
  const spawned: { argv: string[]; env: Record<string, string>; signals: string[]; exit: (code?: number) => void }[] = [];
  const logs: string[] = [];
  let health: "ready" | "incompatible" | false = "ready";
  let dieOnReady = false;
  const deps: ServeDeps = {
    spawn(argv, env) {
      const exited = Promise.withResolvers<number | null>();
      const entry = { argv, env, signals: [] as string[], exit: (code = 1) => exited.resolve(code) };
      spawned.push(entry);
      const child: ServeChild = {
        exited: exited.promise,
        stop: () => {
          entry.signals.push("stop");
          // a stubborn one's watchdog takes its time
          if (!options.stubborn) exited.resolve(null);
        },
      };
      return child;
    },
    freePort: async () => 40_000 + spawned.length,
    ready: async () => {
      clock += 100;
      if (dieOnReady) spawned.at(-1)!.exit(1);
      return health;
    },
    now: () => clock,
    log: (line) => { logs.push(line); },
  };
  return {
    deps, spawned, logs,
    advance: (ms: number) => { clock += ms; },
    setHealth: (value: "ready" | "incompatible" | false) => { health = value; },
    setDieOnReady: (value: boolean) => { dieOnReady = value; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fast = { readyPollMs: 1, settleMs: 1 };

describe("the server this one starts", () => {
  it("starts one on first use, on loopback, quiet, with its own password and no pane identity", async () => {
    const fake = fakeDeps();
    const serve = new OpencodeServe("/opt/opencode", { PATH: "/bin", HERDR_PANE_ID: "w1:p1", HERDR_ENV: "1", OPENCODE_SERVER_PASSWORD: "theirs" }, fake.deps, fast);
    expect(serve.state).toBe("idle");
    expect(fake.spawned).toEqual([]);
    const [one, two] = await Promise.all([serve.endpoint(), serve.endpoint()]);
    expect(one).toEqual(two);
    expect(fake.spawned.length).toBe(1);
    expect(fake.spawned[0]!.argv).toEqual(["/opt/opencode", "serve", "--port", "40000", "--hostname", "127.0.0.1", "--mdns=false"]);
    const env = fake.spawned[0]!.env;
    expect(Object.keys(env).some((key) => key.startsWith("HERDR_"))).toBe(false);
    expect(env["PATH"]).toBe("/bin");
    expect(env["OPENCODE_PURE"]).toBe("1");
    expect(env["OPENCODE_DISABLE_AUTOUPDATE"]).toBe("1");
    expect(env["OPENCODE_SERVER_PASSWORD"]).not.toBe("theirs");
    expect(one).toEqual({ baseUrl: "http://127.0.0.1:40000", authorization: `Basic ${btoa(`opencode:${env["OPENCODE_SERVER_PASSWORD"]}`)}` });
    expect(serve.state).toBe("ready");
    await serve.stop();
    expect(fake.spawned[0]!.signals).toEqual(["stop"]);
    expect(await serve.endpoint()).toBeNull();
    expect(fake.spawned.length).toBe(1);
  });

  it("waits a backoff that grows with each death, and logs each with its exit code only", async () => {
    const fake = fakeDeps();
    const serve = new OpencodeServe("opencode", { SECRET_FIXTURE: "never logged" }, fake.deps, { ...fast, startTimeoutMs: 500, minBackoffMs: 1_000, maxBackoffMs: 8_000, stableMs: 60_000 });
    // up, then dead soon after, again and again: the count is not reset by answering
    for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 8_000].entries()) {
      expect(await serve.endpoint()).not.toBeNull();
      fake.advance(5_000);
      fake.spawned[index]!.exit(3);
      await tick();
      expect(serve.state).toBe("backoff");
      fake.advance(wait - 1);
      expect(serve.state).toBe("backoff");
      expect(await serve.endpoint()).toBeNull();
      fake.advance(1);
      expect(serve.state).toBe("idle");
    }
    expect(fake.logs.length).toBe(5);
    expect(fake.logs[0]).toBe("OpenCode server exited (code 3); the next chat that needs it starts it again in 1s.");
    expect(fake.logs.join("\n")).not.toContain("never logged");

    // one that stayed up a minute starts the count over
    expect(await serve.endpoint()).not.toBeNull();
    fake.advance(60_000);
    fake.spawned[5]!.exit(0);
    await tick();
    fake.advance(999);
    expect(serve.state).toBe("backoff");
    fake.advance(1);
    expect(serve.state).toBe("idle");
    await serve.stop();
  });

  it("stops one that never answers its health check, or answers as another version, or exits right after answering", async () => {
    const fake = fakeDeps();
    const serve = new OpencodeServe("opencode", {}, fake.deps, { ...fast, startTimeoutMs: 500, minBackoffMs: 1_000, maxBackoffMs: 60_000 });
    fake.setHealth(false);
    expect(await serve.endpoint()).toBeNull();
    await tick();
    expect(fake.spawned[0]!.signals).toEqual(["stop"]);
    expect(fake.logs.at(-1)).toContain("did not answer its health check");

    fake.advance(1_000);
    fake.setHealth("ready");
    fake.setDieOnReady(true);
    expect(await serve.endpoint()).toBeNull();
    await tick();
    expect(fake.spawned.length).toBe(2);
    expect(fake.spawned[1]!.signals).toEqual([]);
    expect(fake.logs.at(-1)).toContain("exited (code 1)");

    fake.advance(2_000);
    fake.setDieOnReady(false);
    fake.setHealth("incompatible");
    expect(await serve.endpoint()).toBeNull();
    await tick();
    expect(fake.spawned[2]!.signals).toEqual(["stop"]);
    expect(fake.logs.at(-1)).toBe("OpenCode server is not OpenCode 1.x; the next chat that needs it starts it again in 60s.");
    expect(serve.incompatible).toBe(true);

    // another version every time: after a few starts, none again until the configuration changes
    for (let start = 1; start < OPENCODE_V1_INCOMPATIBLE_STARTS; start++) {
      fake.advance(60_000);
      expect(await serve.endpoint()).toBeNull();
      await tick();
    }
    expect(fake.spawned.length).toBe(2 + OPENCODE_V1_INCOMPATIBLE_STARTS);
    expect(fake.logs.at(-1)).toBe("OpenCode server is not OpenCode 1.x; it is not started again until HERDR_WEB_OPENCODE_BIN changes or the app restarts.");
    const logged = fake.logs.length;
    fake.advance(24 * 3_600_000);
    expect(await serve.endpoint()).toBeNull();
    expect(serve.state).toBe("incompatible");
    expect(fake.spawned.length).toBe(2 + OPENCODE_V1_INCOMPATIBLE_STARTS);
    expect(fake.logs.length).toBe(logged);
    await serve.stop();
  });

  it("gives a caller its fallback while a slow start goes on", async () => {
    const fake = fakeDeps();
    const answered = Promise.withResolvers<"ready">();
    const slow: ServeDeps = { ...fake.deps, ready: () => answered.promise };
    const serve = new OpencodeServe("opencode", {}, slow, { ...fast, waitMs: 5 });
    expect(await serve.endpoint()).toBeNull();
    expect(serve.state).toBe("starting");
    answered.resolve("ready");
    expect(await serve.endpoint()).not.toBeNull();
    expect(fake.spawned.length).toBe(1);
    await serve.stop();
  });

  it("keeps herdr's pane identity and the user's server password out of the environment", () => {
    const env = serveEnvironment({ HOME: "/home/fixture", HERDR_SOCKET_PATH: "/x", HERDR_WEB_OPENCODE_SERVE: "1", OPENCODE_SERVER_USERNAME: "other" }, "fresh");
    expect(env["HOME"]).toBe("/home/fixture");
    expect(Object.keys(env).filter((key) => key.startsWith("HERDR_"))).toEqual([]);
    expect([env["OPENCODE_SERVER_USERNAME"], env["OPENCODE_SERVER_PASSWORD"]]).toEqual(["opencode", "fresh"]);
  });

  it("is started through the environment's HERDR_WEB_OPENCODE_SERVE=1 and read from like a named one", async () => {
    const s = server.session();
    s.user("hello");
    const fake = fakeDeps();
    const port = Number(new URL(server.url).port);
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_SERVE: "1", HERDR_WEB_OPENCODE_BIN: "/opt/opencode" };
    opencodeV1Options.deps = { ...fake.deps, freePort: async () => port };
    opencodeV1Options.serve = fast;
    const answer = await opencodeV1Conversation(s.id);
    // the fixture checks no password; the started server would
    expect(prompts(page(answer))).toEqual(["hello"]);
    expect(fake.spawned.map((entry) => entry.argv[0])).toEqual(["/opt/opencode"]);
    await stopOpencodeV1();
    expect(fake.spawned[0]!.signals).toEqual(["stop"]);
  });

  it("stops for good once: a second stop waits for the same exit, nothing starts after it, and the exit hook asks the watchdog again", async () => {
    const s = server.session();
    s.user("hello");
    const fake = fakeDeps({ stubborn: true });
    opencodeV1Options.env = { HERDR_WEB_OPENCODE_SERVE: "1" };
    opencodeV1Options.deps = { ...fake.deps, freePort: async () => Number(new URL(server.url).port) };
    opencodeV1Options.serve = { ...fast, stopWaitMs: 300 };
    expect(page(await opencodeV1Conversation(s.id)).turns.length).toBe(1);
    const first = stopOpencodeV1();
    const second = stopOpencodeV1();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => { settled = true; });
    await tick();
    // the watchdog was asked, and is still stopping a slow server: the stop waits for it
    expect(fake.spawned[0]!.signals).toEqual(["stop"]);
    expect(settled).toBe(false);
    expect(await opencodeV1Endpoint()).toBeNull();
    expect(fake.spawned.length).toBe(1);
    // what the process `exit` handler does: ask again, and kill nothing from here
    stopOpencodeV1Now();
    expect(fake.spawned[0]!.signals).toEqual(["stop", "stop"]);
    // past its wait, the stop settles; the watchdog, never killed from here, finishes on its own
    await first;
    expect(settled).toBe(true);
    fake.spawned[0]!.exit(0);
  });
});

describe("a server a hard kill left behind", () => {
  const write = (name: string, entry: unknown) => {
    const run = join(stateDir, "opencode-serve", "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, name), JSON.stringify(entry));
  };

  it("is stopped at the next start only when its owner is gone and it still runs the same command since the same start", () => {
    const args = "serve --port 41000 --hostname 127.0.0.1 --mdns=false";
    write("100-200.json", { owner: { pid: 100, started: 1 }, pid: 200, started: 2, args });
    // its owner still runs: another server's
    write("101-201.json", { owner: { pid: 101, started: 1 }, pid: 201, started: 2, args });
    // the pid now belongs to another process: a different start, or another command
    write("102-202.json", { owner: { pid: 102, started: 1 }, pid: 202, started: 2, args });
    write("103-203.json", { owner: { pid: 103, started: 1 }, pid: 203, started: 2, args });
    write("104-204.json", "not a record");
    write("unrelated.txt", {});
    const killed: number[] = [];
    const started: Record<number, number> = { 101: 1, 200: 2, 201: 2, 202: 9, 203: 2 };
    const reaped = reapOpencodeV1Orphans(stateDir, {
      started: (pid) => started[pid] ?? null,
      args: (pid) => pid === 203 ? "/usr/bin/something-else" : `/opt/opencode ${args}`,
      kill: (pid) => { killed.push(pid); },
    });
    expect(reaped).toBe(1);
    expect(killed).toEqual([200]);
    expect(readdirSync(join(stateDir, "opencode-serve", "run")).sort()).toEqual(["101-201.json", "unrelated.txt"]);
    expect(reapOpencodeV1Orphans(join(stateDir, "none"))).toBe(0);
  });

  it.skipIf(process.platform === "win32")("comes from a real start: a record while it runs, an empty folder of its own, a quiet environment", async () => {
    const bin = join(stateDir, "fake-opencode");
    const script = join(stateDir, "fake-opencode.ts");
    writeFileSync(script, `
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      // a child of its own, as OpenCode's MCP servers and tools are
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      Bun.serve({ port, hostname: "127.0.0.1", fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/global/health") return Response.json({ healthy: true, version: "1.19.0" });
        if (path === "/fixture/child") return Response.json({ pid: child.pid });
        if (path === "/fixture/env") return Response.json({ cwd: process.cwd(), pure: process.env.OPENCODE_PURE, herdr: Object.keys(process.env).filter((key) => key.startsWith("HERDR_")) });
        return new Response(null, { status: 404 });
      } });
    `);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(bin, 0o755);
    opencodeV1Options.env = { ...process.env, HERDR_WEB_OPENCODE_SERVE: "1", HERDR_WEB_OPENCODE_BIN: bin, HERDR_FIXTURE: "1" };
    opencodeV1Options.serve = { readyPollMs: 20, settleMs: 20 };
    const endpoint = await opencodeV1Endpoint();
    expect(endpoint).not.toBeNull();
    const run = join(stateDir, "opencode-serve", "run");
    await until(() => existsSync(run) && readdirSync(run).length === 1);
    const env = await fetch(`${endpoint!.baseUrl}/fixture/env`).then((response) => response.json()) as { cwd: string; pure: string; herdr: string[] };
    expect(env).toEqual({ cwd: join(stateDir, "opencode-serve", "cwd"), pure: "1", herdr: [] });
    expect(readdirSync(join(stateDir, "opencode-serve", "cwd"))).toEqual([]);
    const { pid: child } = await fetch(`${endpoint!.baseUrl}/fixture/child`).then((response) => response.json()) as { pid: number };
    if (process.platform === "linux") {
      // a watchdog killed outright, alone: the server's whole group goes from here, and the next chat starts another
      const pid = Number(/^\d+-(\d+)\.json$/.exec(readdirSync(run)[0]!)![1]);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      expect(Number(stat[2])).toBe(pid);
      process.kill(Number(stat[1]), "SIGKILL");
      await until(() => !alive(pid) && !alive(child) && readdirSync(run).length === 0);
      await expect(fetch(`${endpoint!.baseUrl}/global/health`)).rejects.toThrow();
      return;
    }
    await stopOpencodeV1();
    expect(readdirSync(run)).toEqual([]);
    await expect(fetch(`${endpoint!.baseUrl}/global/health`)).rejects.toThrow();
    await until(() => !alive(child));
  });
});
