/**
 * An OpenCode 1.x session read over OpenCode's own HTTP server, read-only (GET only).
 *
 * An OpenCode 1.x build whose sessions live somewhere other than `opencode.db` (a build backed by
 * another database, say) leaves the store reader in opencode.ts nothing to read, or a stale file.
 * Any `opencode serve` of such a build reads the same shared store, so it can answer for any
 * session a pane shows: `GET /session/:id` is the session, `GET /session/:id/message` its messages
 * as `{ info, parts }`, the shape the 1.x tables hold, mapped to turns by the same code
 * (`opencodeMessage1Record`).
 *
 * Off unless asked for. `OVIS_OPENCODE_URL` names a server the user runs; otherwise
 * `OVIS_OPENCODE_SERVE=1` has this server start one of its own on loopback (`OVIS_OPENCODE_BIN`,
 * else `opencode` on PATH) when a chat first needs it, behind a password only this process knows,
 * starts it again after a backoff when it dies, and stops it with this server.
 *
 * `GET /session/:id/message?limit=&before=` answers the newest `limit` messages before a cursor,
 * oldest first, and the cursor for the messages before those in `X-Next-Cursor` (none at the
 * session's start). A page is chosen the way the store reader chooses one (`pageStart`), walking
 * back a chunk at a time, and a page cursor names its first message and the server's cursor for
 * what comes before it: `<history id>:<message id>.<server cursor>`. A `/undo` stages
 * `session.revert`, hiding the messages from its message on, which changes the history id.
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

import type { ConversationMetadata } from "../shared/protocol.ts";
import {
  OPENCODE_MESSAGE_ID,
  OPENCODE_SESSION_ID,
  OPENCODE_WINDOW_BYTES,
  opencodeMessage1Image,
  opencodeMessage1Metadata,
  opencodeMessage1Record,
  opencodeMessage1ToolOutput,
  opencodeTurns,
  OPENCODE_IMAGE_REF,
  OPENCODE_TOOL_REF,
  pageStart,
  type OpencodeAnswer,
  type OpencodeMessage1,
  type OpencodePage,
  type OpencodeRecord,
  type RowMeta,
} from "./opencode.ts";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/** One request to the server; a page of messages is larger than a form, so it gets longer than OPENCODE_HTTP_TIMEOUT_MS. */
export const OPENCODE_V1_HTTP_TIMEOUT_MS = 5_000;
/** A started server answers its health check within this, or it is stopped and tried again later. */
export const OPENCODE_V1_START_TIMEOUT_MS = 30_000;
/** A response is cut off past this: a page is read whole, never streamed. */
const MAX_RESPONSE_BYTES = 2 * OPENCODE_WINDOW_BYTES;
/** The first chunk of a walk back; each further one doubles, up to the last. */
const FIRST_CHUNK = 32;
const LAST_CHUNK = 256;
/** A walk back stops after this many requests, starting the page at the earliest prompt it found. */
const MAX_WALK_REQUESTS = 24;
/** The server's own cursor, opaque: what it handed out, of the characters it hands out. */
const SERVER_CURSOR = /^[A-Za-z0-9_\-+/=]{1,1024}$/;

export interface OpencodeV1Endpoint {
  /** origin, and a path prefix when the server sits behind one; no trailing slash */
  baseUrl: string;
  authorization: string | null;
}

/** Where the HTTP source is: a server the user named, one this server starts, or none (the default). */
export type OpencodeV1Mode = { kind: "url"; endpoint: OpencodeV1Endpoint } | { kind: "serve"; bin: string } | null;

function basicAuth(env: Env): string | null {
  const password = env["OPENCODE_SERVER_PASSWORD"];
  if (!password) return null;
  return `Basic ${Buffer.from(`${env["OPENCODE_SERVER_USERNAME"] || "opencode"}:${password}`).toString("base64")}`;
}

/** The mode the environment asks for; a URL that is not plain http(s) without credentials is none. */
export function opencodeV1Mode(env: Env = process.env): OpencodeV1Mode {
  const url = env["OVIS_OPENCODE_URL"]?.trim();
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return { kind: "url", endpoint: { baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, authorization: basicAuth(env) } };
  }
  if (env["OVIS_OPENCODE_SERVE"] === "1") return { kind: "serve", bin: env["OVIS_OPENCODE_BIN"]?.trim() || "opencode" };
  return null;
}

interface Answer { status: number; body: string; headers: IncomingHttpHeaders }

/** GET only. node:http, as opencode-service.ts: Bun's fetch follows the proxy environment, and this server is local. */
export function opencodeV1Get(endpoint: OpencodeV1Endpoint, path: string, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = OPENCODE_V1_HTTP_TIMEOUT_MS): Promise<Answer | null> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(`${endpoint.baseUrl}${path}`); } catch { resolve(null); return; }
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      agent: false,
      method: "GET",
      headers: { Accept: "application/json", ...(endpoint.authorization === null ? {} : { Authorization: endpoint.authorization }) },
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
      if (status < 200 || status >= 300) {
        resolve({ status, body: "", headers: response.headers });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          resolve(null);
          response.destroy();
          req.destroy();
        } else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    req.once("error", () => resolve(null));
    req.end();
  });
}

/* -------------------------------------------------------------------------------------------------
 * The server this one starts (OVIS_OPENCODE_SERVE=1)
 * ----------------------------------------------------------------------------------------------- */

export interface ServeChild {
  readonly exited: Promise<unknown>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

/** What starting a server takes, apart so the lifecycle can be tested without one. */
export interface ServeDeps {
  spawn(argv: string[], env: Record<string, string>): ServeChild;
  /** a loopback port free now: `--port 0` would take OpenCode's own default port first */
  freePort(): Promise<number>;
  ready(endpoint: OpencodeV1Endpoint): Promise<boolean>;
  now(): number;
}

export interface ServeOptions {
  startTimeoutMs?: number;
  readyPollMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  stopGraceMs?: number;
  /** how long one caller waits for a server that is starting */
  waitMs?: number;
}

const defaultServeDeps: ServeDeps = {
  spawn(argv, env) {
    const child = Bun.spawn(argv, { env, cwd: tmpdir(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return { exited: child.exited, kill: (signal) => { try { child.kill(signal); } catch { /* gone already */ } } };
  },
  freePort() {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = address !== null && typeof address === "object" ? address.port : 0;
        probe.close(() => port > 0 ? resolve(port) : reject(new Error("no free port")));
      });
    });
  },
  async ready(endpoint) {
    const answer = await opencodeV1Get(endpoint, "/global/health", 64 * 1024, 2_000);
    if (answer?.status !== 200) return false;
    try { return record(JSON.parse(answer.body)).healthy === true; } catch { return false; }
  },
  now: () => Date.now(),
};

/** The environment a started server gets: this one's, without herdr's pane identity (it is no pane's agent) and with its own password. */
export function serveEnvironment(env: Env, password: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("HERDR_") || key === "OPENCODE_SERVER_PASSWORD" || key === "OPENCODE_SERVER_USERNAME") continue;
    out[key] = value;
  }
  out["OPENCODE_SERVER_USERNAME"] = "opencode";
  out["OPENCODE_SERVER_PASSWORD"] = password;
  return out;
}

/**
 * One `opencode serve` on loopback, started on first use. A start that fails, or a server that
 * exits, waits a backoff (doubling, capped) before the next use starts another; meanwhile callers
 * get no endpoint and keep their fallback.
 */
export class OpencodeServe {
  private child: ServeChild | null = null;
  private endpointNow: OpencodeV1Endpoint | null = null;
  private starting: Promise<OpencodeV1Endpoint | null> | null = null;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  private readonly options: Required<ServeOptions>;

  constructor(private readonly bin: string, private readonly env: Env = process.env, private readonly deps: ServeDeps = defaultServeDeps, options: ServeOptions = {}) {
    this.options = {
      startTimeoutMs: options.startTimeoutMs ?? OPENCODE_V1_START_TIMEOUT_MS,
      readyPollMs: options.readyPollMs ?? 200,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      stopGraceMs: options.stopGraceMs ?? 2_000,
      waitMs: options.waitMs ?? 10_000,
    };
  }

  get state(): "idle" | "starting" | "ready" | "backoff" | "stopped" {
    if (this.stopped) return "stopped";
    if (this.starting !== null) return "starting";
    if (this.endpointNow !== null) return "ready";
    return this.deps.now() < this.retryAt ? "backoff" : "idle";
  }

  /** The running server, started now if none runs and no backoff holds; null while it cannot be had. */
  endpoint(): Promise<OpencodeV1Endpoint | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.endpointNow !== null) return Promise.resolve(this.endpointNow);
    if (this.starting === null) {
      if (this.deps.now() < this.retryAt) return Promise.resolve(null);
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    // a chat waits for a server starting this long, then reads its fallback until it is up
    const waited = Promise.withResolvers<null>();
    const timer = setTimeout(() => waited.resolve(null), this.options.waitMs);
    timer.unref?.();
    return Promise.race([this.starting.finally(() => clearTimeout(timer)), waited.promise]);
  }

  private backoff(): void {
    this.failures++;
    this.retryAt = this.deps.now() + Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * 2 ** (this.failures - 1));
  }

  private async start(): Promise<OpencodeV1Endpoint | null> {
    let child: ServeChild;
    let endpoint: OpencodeV1Endpoint;
    try {
      const port = await this.deps.freePort();
      if (this.stopped) return null;
      const password = randomBytes(24).toString("base64url");
      endpoint = { baseUrl: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
      child = this.deps.spawn([this.bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], serveEnvironment(this.env, password));
    } catch {
      this.backoff();
      return null;
    }
    this.child = child;
    let exited = false;
    void child.exited.then(() => {
      exited = true;
      if (this.child !== child) return;
      this.child = null;
      this.endpointNow = null;
      if (!this.stopped) this.backoff();
    });
    const deadline = this.deps.now() + this.options.startTimeoutMs;
    while (!exited && !this.stopped && this.deps.now() < deadline) {
      if (await this.deps.ready(endpoint).catch(() => false)) {
        if (exited || this.stopped || this.child !== child) return null;
        this.failures = 0;
        this.endpointNow = endpoint;
        return endpoint;
      }
      await Bun.sleep(this.options.readyPollMs);
    }
    // never answered: it goes, and its exit sets the backoff
    if (this.child === child) this.end(child);
    return null;
  }

  private end(child: ServeChild): void {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), this.options.stopGraceMs);
    killer.unref?.();
    void child.exited.finally(() => clearTimeout(killer));
  }

  /** Stop the server for good (this server is stopping); settles once it has exited. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.endpointNow = null;
    const child = this.child;
    this.child = null;
    if (child === null) return;
    this.end(child);
    await child.exited.catch(() => undefined);
  }

  /** The last word, from a process `exit` handler: no waiting is possible there. */
  killNow(): void {
    this.stopped = true;
    this.child?.kill("SIGKILL");
  }
}

/** Tests point the source at a fixture: an environment and the deps a started server uses. */
export const opencodeV1Options: { env?: Env; deps?: ServeDeps; serve?: ServeOptions } = {};

let serve: { key: string; instance: OpencodeServe } | null = null;
let exitHook = false;

const sourceEnv = (): Env => opencodeV1Options.env ?? process.env;

/** Whether the HTTP source is configured at all; nothing is started by asking. */
export function opencodeV1Configured(): boolean {
  return opencodeV1Mode(sourceEnv()) !== null;
}

/** The server to read from: the configured one, or the one this server starts; null when none is configured or can be had now. */
export async function opencodeV1Endpoint(): Promise<OpencodeV1Endpoint | null> {
  const env = sourceEnv();
  const mode = opencodeV1Mode(env);
  if (mode === null) return null;
  if (mode.kind === "url") return mode.endpoint;
  if (serve?.key !== mode.bin) {
    void serve?.instance.stop();
    serve = { key: mode.bin, instance: new OpencodeServe(mode.bin, env, opencodeV1Options.deps, opencodeV1Options.serve) };
    if (!exitHook) {
      exitHook = true;
      process.once("exit", () => serve?.instance.killNow());
    }
  }
  return serve.instance.endpoint();
}

/** Stop the server this one started, if any; this server is stopping (or a test is done). */
export async function stopOpencodeV1(): Promise<void> {
  const running = serve;
  serve = null;
  await running?.instance.stop();
}

/* -------------------------------------------------------------------------------------------------
 * Reading a session
 * ----------------------------------------------------------------------------------------------- */

/** The server could not answer (down, timed out, not JSON): the caller keeps its fallback. */
class SourceFailed extends Error {}

interface Wire extends OpencodeMessage1 {
  role: string;
  created: number;
  json: string;
  size: number;
}

interface Chunk {
  /** the server cursor it was asked with; undefined for the newest */
  before: string | undefined;
  messages: Wire[];
  /** the server's cursor for what comes before this chunk; null at the session's start */
  next: string | null;
}

const enc = encodeURIComponent;

function wire(value: unknown, sessionId: string): Wire | null {
  const item = record(value);
  const info = record(item.info);
  if (typeof info.id !== "string" || !OPENCODE_MESSAGE_ID.test(info.id)) return null;
  if (info.sessionID !== undefined && info.sessionID !== sessionId) return null;
  const json = JSON.stringify(item);
  return {
    id: info.id,
    data: info,
    parts: (Array.isArray(item.parts) ? item.parts : []).map(record),
    role: typeof info.role === "string" ? info.role : "",
    created: typeof record(info.time).created === "number" ? record(info.time).created as number : 0,
    json,
    size: Buffer.byteLength(json, "utf8"),
  };
}

async function getJson(endpoint: OpencodeV1Endpoint, path: string): Promise<{ status: number; value: unknown; headers: IncomingHttpHeaders }> {
  const answer = await opencodeV1Get(endpoint, path);
  if (answer === null) throw new SourceFailed("no answer");
  if (answer.status === 404) return { status: 404, value: null, headers: answer.headers };
  if (answer.status < 200 || answer.status >= 300) throw new SourceFailed(`status ${answer.status}`);
  try { return { status: answer.status, value: JSON.parse(answer.body) as unknown, headers: answer.headers }; }
  catch { throw new SourceFailed("not JSON"); }
}

/** The session's info, or null when the server holds no such session. */
async function sessionInfo(endpoint: OpencodeV1Endpoint, sessionId: string): Promise<Row | null> {
  const answer = await getJson(endpoint, `/session/${enc(sessionId)}`);
  if (answer.status === 404) return null;
  const info = record(answer.value);
  if (info.id !== sessionId) throw new SourceFailed("another session");
  return info;
}

/** One message by id, or null when the session holds no such message. */
async function message(endpoint: OpencodeV1Endpoint, sessionId: string, id: string): Promise<Wire | null> {
  const answer = await getJson(endpoint, `/session/${enc(sessionId)}/message/${enc(id)}`);
  if (answer.status === 404) return null;
  const found = wire(answer.value, sessionId);
  if (found === null || found.id !== id) throw new SourceFailed("another message");
  return found;
}

/** The newest `limit` messages before the server cursor `before`, oldest first; null when the session is gone. */
async function chunk(endpoint: OpencodeV1Endpoint, sessionId: string, limit: number, before: string | undefined): Promise<Chunk | null> {
  const answer = await getJson(endpoint, `/session/${enc(sessionId)}/message?limit=${limit}${before === undefined ? "" : `&before=${enc(before)}`}`);
  if (answer.status === 404) return null;
  if (!Array.isArray(answer.value)) throw new SourceFailed("not a list");
  const messages = answer.value.map((value) => wire(value, sessionId));
  if (messages.some((found) => found === null)) throw new SourceFailed("not a message");
  const header = answer.headers["x-next-cursor"];
  const next = typeof header === "string" && SERVER_CURSOR.test(header) ? header : null;
  return { before, messages: messages as Wire[], next };
}

/** A page cursor's parts, or null for one of another history or not one of these. */
function parseCursor(cursor: string, historyId: string): { id: string; token: string } | null {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0 || cursor.slice(0, separator) !== historyId) return null;
  const rest = cursor.slice(separator + 1);
  const dot = rest.indexOf(".");
  const id = rest.slice(0, dot);
  const token = rest.slice(dot + 1);
  return dot > 0 && OPENCODE_MESSAGE_ID.test(id) && SERVER_CURSOR.test(token) ? { id, token } : null;
}

const formatCursor = (historyId: string, id: string, token: string): string => `${historyId}:${id}.${token}`;

/** The id a revert hides messages from, if one is staged. */
const revertBoundary = (info: Row): string | null => {
  const id = record(info.revert).messageID;
  return typeof id === "string" && OPENCODE_MESSAGE_ID.test(id) ? id : null;
};

/** Per session: the server cursor for the messages before a message, as the server handed it out. */
const tokens = new Map<string, Map<string, string>>();
/** Per page asked for: the answer, while its signature holds. */
const answers = new Map<string, { signature: string; answer: Extract<OpencodeAnswer, { kind: "page" }> }>();

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** What the caches here are keyed by, and what a pane's chat is remembered against (conversation.ts `rememberPaneRead`). */
export const opencodeV1ReadKey = (sessionId: string): string => `opencode-http\0${sessionId}`;

export function forgetOpencodeV1Read(key: string): void {
  if (!key.startsWith("opencode-http\0")) return;
  tokens.delete(key);
  for (const entry of [...answers.keys()]) if (entry.startsWith(`${key}\0`)) answers.delete(entry);
}

export function forgetOpencodeV1State(): void {
  tokens.clear();
  answers.clear();
}

function knownToken(key: string, id: string): string | undefined {
  return tokens.get(key)?.get(id);
}

function learnToken(key: string, id: string, token: string): void {
  const known = tokens.get(key) ?? new Map<string, string>();
  remember(known, id, token, 512);
  remember(tokens, key, known, 16);
}

/** A walk back from `before` (the newest when undefined), as far as a page needs. */
interface Walk {
  chunks: Chunk[];
  /** every message fetched and shown, oldest first */
  visible: Wire[];
  /** where the visible messages start being the chunk's: `visible[i]` is `chunks[c].messages[j]` */
  place: { chunk: number; index: number }[];
  /** the page's first message in `visible` */
  start: number;
  /** `floor`'s place in `visible`, when the walk reached it */
  floor: number | null;
  /** the walk reached the session's start */
  beginning: boolean;
  /** the revert boundary turned up among the fetched messages */
  boundarySeen: boolean;
}

/**
 * Walk back from `before` a chunk at a time until `pageStart` finds the page's start, the walk
 * reaches `floor` or the session's start, or it has asked enough. Messages from `boundary` on (a
 * staged `/undo`) are left out; meeting it while walking back from an older cursor means the
 * cursor is past it.
 */
async function walk(endpoint: OpencodeV1Endpoint, sessionId: string, options: { before?: string; floor?: string; widen: boolean; boundary: string | null }): Promise<Walk | null> {
  const chunks: Chunk[] = [];
  let before = options.before;
  let limit = FIRST_CHUNK;
  let boundarySeen = false;
  for (let requests = 0; ; requests++) {
    const found = await chunk(endpoint, sessionId, limit, before);
    if (found === null) return null;
    chunks.unshift(found);
    const visible: Wire[] = [];
    const place: { chunk: number; index: number }[] = [];
    boundarySeen = false;
    chunks.forEach((each, c) => each.messages.forEach((wired, index) => {
      if (wired.id === options.boundary) boundarySeen = true;
      if (boundarySeen) return;
      visible.push(wired);
      place.push({ chunk: c, index });
    }));
    const floorAt = options.floor === undefined ? -1 : visible.findIndex((wired) => wired.id === options.floor);
    const from = floorAt < 0 ? 0 : floorAt;
    const rows: RowMeta[] = [];
    for (let index = visible.length - 1; index >= from; index--) {
      const wired = visible[index]!;
      rows.push({ id: wired.id, seq: index, type: wired.role, updated: 0, size: wired.size });
    }
    // -1 says the window and the prompt count were not reached
    const start = pageStart(rows, -1, options.widen);
    const beginning = found.next === null;
    const done = start >= 0 || floorAt >= 0 || beginning || requests + 1 >= MAX_WALK_REQUESTS;
    if (done) {
      let chosen = start >= 0 ? start : floorAt >= 0 ? floorAt : 0;
      if (start < 0 && floorAt < 0 && !beginning) {
        // asked enough: the earliest prompt fetched, as the store reader starts a window with no reach
        const prompt = visible.findIndex((wired) => wired.role === "user");
        if (prompt > 0) chosen = prompt;
      }
      return { chunks, visible, place, start: chosen, floor: floorAt >= 0 ? floorAt : null, beginning, boundarySeen };
    }
    before = found.next!;
    limit = Math.min(LAST_CHUNK, limit * 2);
  }
}

/**
 * The server cursor for the messages before `visible[at]`, or null when it is the session's first.
 * The server hands one out only for a chunk's oldest message: for any other, the chunk is asked
 * again ending at it. The newest chunk can have grown meanwhile; then the page starts at the
 * chunk's oldest instead, whose cursor is known.
 */
async function tokenBefore(endpoint: OpencodeV1Endpoint, sessionId: string, key: string, found: Walk, at: number): Promise<{ at: number; token: string | null }> {
  const { chunk: c, index } = found.place[at]!;
  const owner = found.chunks[c]!;
  if (index === 0) return { at, token: owner.next };
  const target = found.visible[at]!;
  const known = knownToken(key, target.id);
  if (known !== undefined) return { at, token: known };
  const again = await chunk(endpoint, sessionId, owner.messages.length - index, owner.before);
  if (again !== null && again.messages[0]?.id === target.id && again.next !== null) {
    learnToken(key, target.id, again.next);
    return { at, token: again.next };
  }
  return { at: found.place.findIndex((placed) => placed.chunk === c && placed.index === 0), token: owner.next };
}

const settingsOf = (visible: readonly Wire[], end: number): ConversationMetadata => opencodeMessage1Metadata(visible, end);

function pageAnswer(cacheKey: string, historyId: string, visible: readonly Wire[], start: number, end: number, cursor: string | null): Extract<OpencodeAnswer, { kind: "page" }> {
  const hash = createHash("sha256").update(`${historyId}\0${cursor ?? ""}\0${start}\0${end}`);
  for (let index = 0; index < end; index++) hash.update("\0").update(visible[index]!.json);
  const signature = hash.digest("base64url");
  const cached = answers.get(cacheKey);
  if (cached?.signature === signature) return cached.answer;
  const records: (OpencodeRecord | null)[] = [];
  for (let index = start; index < end; index++) records.push(opencodeMessage1Record(visible[index]!));
  const answer = { kind: "page" as const, turns: opencodeTurns(records), metadata: settingsOf(visible, end), cursor, history_id: historyId, signature };
  remember(answers, cacheKey, { signature, answer }, 32);
  return answer;
}

/**
 * One page of the session (as conversation.ts's ConversationPage), from the HTTP source. null when
 * the source is not configured, cannot be had or failed: the caller keeps its fallback.
 */
export async function opencodeV1Conversation(sessionId: string, page: OpencodePage = {}): Promise<OpencodeAnswer | null> {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return { kind: "unavailable", reason: "no_session_id" };
  const endpoint = await opencodeV1Endpoint();
  if (endpoint === null) return null;
  try { return await conversationAt(endpoint, sessionId, page); }
  catch (error) {
    if (error instanceof SourceFailed) return null;
    throw error;
  }
}

async function conversationAt(endpoint: OpencodeV1Endpoint, sessionId: string, page: OpencodePage): Promise<OpencodeAnswer> {
  const info = await sessionInfo(endpoint, sessionId);
  if (info === null) return { kind: "unavailable", reason: "session_not_found" };
  const boundary = revertBoundary(info);
  const historyId = `opencode-http-${sessionId}${boundary === null ? "" : `-r${boundary}`}`;
  const key = opencodeV1ReadKey(sessionId);
  const cacheKey = `${key}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}`;

  if (page.before !== undefined) {
    const before = parseCursor(page.before, historyId);
    const since = page.since === undefined ? null : parseCursor(page.since, historyId);
    if (before === null || (page.since !== undefined && since === null)) return { kind: "history_changed" };
    // a cursor naming a message an undo deleted is another history's
    if (await message(endpoint, sessionId, before.id) === null) return { kind: "history_changed" };
    if (since !== null && since.id === before.id) {
      return { kind: "page", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: page.since!, history_id: historyId, signature: `${historyId}\0${page.since}` };
    }
    const found = await walk(endpoint, sessionId, { before: before.token, ...(since === null ? {} : { floor: since.id }), widen: true, boundary });
    if (found === null) return { kind: "unavailable", reason: "session_not_found" };
    // walking back from it met the undo's message: the cursor is among the hidden ones
    if (found.boundarySeen) return { kind: "history_changed" };
    if (since !== null && found.floor === null) return { kind: "history_changed" };
    const end = found.visible.length;
    if (found.visible.length === 0) {
      return { kind: "page", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: historyId, signature: `${historyId}\0empty` };
    }
    let start = found.start;
    let cursor: string | null;
    if (since !== null && start === found.floor) cursor = page.since!;
    else {
      const placed = await tokenBefore(endpoint, sessionId, key, found, start);
      start = placed.at;
      cursor = placed.token === null ? null : formatCursor(historyId, found.visible[start]!.id, placed.token);
    }
    return pageAnswer(cacheKey, historyId, found.visible, start, end, cursor);
  }

  const from = page.from === undefined ? null : parseCursor(page.from, historyId);
  if (page.from !== undefined && from === null) return { kind: "history_changed" };
  const found = await walk(endpoint, sessionId, { widen: false, boundary });
  if (found === null) return { kind: "unavailable", reason: "session_not_found" };
  // a staged undo whose message the walk never reached hides nothing it can tell; the store reader
  // shows everything when its boundary row is missing, and so does this
  const visible = found.visible;
  const end = visible.length;
  if (end === 0) {
    if (from !== null) return { kind: "history_changed" };
    return { kind: "page", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: historyId, signature: `${historyId}\0empty` };
  }
  let start = found.start;
  let cursor: string | null = null;
  if (from !== null) {
    const held = visible.findIndex((wired) => wired.id === from.id);
    if (held < 0) {
      const hidden = found.chunks.some((each) => each.messages.some((wired) => wired.id === from.id));
      if (hidden || await message(endpoint, sessionId, from.id) === null) return { kind: "history_changed" };
    } else if (held >= start) {
      // a chat that shows older pages keeps every turn after its held start while they are inside the newest page
      start = held;
      cursor = page.from!;
      learnToken(key, from.id, from.token);
    }
  }
  if (cursor === null && !(found.beginning && start === 0)) {
    const placed = await tokenBefore(endpoint, sessionId, key, found, start);
    start = placed.at;
    cursor = placed.token === null ? null : formatCursor(historyId, visible[start]!.id, placed.token);
  }
  return pageAnswer(cacheKey, historyId, visible, start, end, cursor);
}

/** Whether a message is one a staged undo hides: at or after its boundary, in the server's own order. */
async function hiddenByRevert(endpoint: OpencodeV1Endpoint, sessionId: string, info: Row, found: Wire): Promise<boolean> {
  const boundary = revertBoundary(info);
  if (boundary === null) return false;
  if (boundary === found.id) return true;
  const edge = await message(endpoint, sessionId, boundary);
  if (edge === null) return false;
  return found.created > edge.created || (found.created === edge.created && found.id > edge.id);
}

/**
 * One message a page ref names, unless an undo hid it; undefined when the source cannot answer or
 * does not hold the session (a page the store reader gave), so the store answers instead.
 */
async function refMessage(sessionId: string, id: string): Promise<Wire | null | undefined> {
  if (!OPENCODE_SESSION_ID.test(sessionId) || !OPENCODE_MESSAGE_ID.test(id)) return null;
  const endpoint = await opencodeV1Endpoint();
  if (endpoint === null) return undefined;
  try {
    const info = await sessionInfo(endpoint, sessionId);
    if (info === null) return undefined;
    const found = await message(endpoint, sessionId, id);
    if (found === null) return null;
    return await hiddenByRevert(endpoint, sessionId, info, found) ? null : found;
  } catch (error) {
    if (error instanceof SourceFailed) return undefined;
    throw error;
  }
}

/** The whole output of a tool call a page cut, by its ref; undefined when the source is not configured or cannot answer. */
export async function opencodeV1ToolOutput(sessionId: string, ref: string): Promise<string | null | undefined> {
  const match = OPENCODE_TOOL_REF.exec(ref);
  if (match === null) return null;
  const found = await refMessage(sessionId, match[1]!);
  return found === null || found === undefined ? found : opencodeMessage1ToolOutput(found, ref);
}

/** An image a page named by its ref, decoded; undefined when the source is not configured or cannot answer. */
export async function opencodeV1Image(sessionId: string, ref: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null | undefined> {
  const match = OPENCODE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  const found = await refMessage(sessionId, match[1]!);
  return found === null || found === undefined ? found : opencodeMessage1Image(found, ref);
}

/**
 * What changes whenever the session's newest page could: the session (a staged undo) and its
 * newest message, which a streaming step rewrites in place. null when the source cannot answer.
 */
export async function opencodeV1Signature(sessionId: string): Promise<string | null> {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return null;
  const endpoint = await opencodeV1Endpoint();
  if (endpoint === null) return null;
  const [info, newest] = await Promise.all([
    opencodeV1Get(endpoint, `/session/${enc(sessionId)}`, 1024 * 1024),
    opencodeV1Get(endpoint, `/session/${enc(sessionId)}/message?limit=1`),
  ]);
  if (info === null || newest === null) return null;
  return createHash("sha256").update(`${info.status}\0${info.body}\0${newest.status}\0${newest.body}`).digest("base64url").slice(0, 22);
}
