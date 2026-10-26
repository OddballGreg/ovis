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
 * `OVIS_OPENCODE_SERVE=1` has this server start one of its own on loopback
 * (`OVIS_OPENCODE_BIN`, else `opencode` on PATH) when a chat first needs it, behind a password
 * only this process knows, in an empty folder under the state folder, through
 * opencode-watchdog.ts. The watchdog runs it as a process group of its own and is the only process
 * that stops it: this one closes the pipe to the watchdog and sends it SIGTERM, never SIGKILL, and
 * the pipe closes by itself when this process is gone however it went. Only a watchdog killed
 * outright leaves its server running; then the server's group is stopped from here, or by
 * reapOpencodeV1Orphans on the next start. It is started again after a backoff when it dies, and
 * stopped with this server. A named server's version is checked once (`checkedUrl`).
 *
 * `GET /session/:id/message?limit=&before=` answers the newest `limit` messages before a cursor,
 * oldest first, and the cursor for the messages before those in `X-Next-Cursor` (none at the
 * session's start). A page is chosen the way the store reader chooses one (`pageStart`), walking
 * back a chunk at a time, and a page cursor names its first message and the server's cursor for
 * what comes before it: `<history id>:<message id>.<server cursor>`. A `/undo` stages
 * `session.revert`, hiding the messages from its message on, which changes the history id.
 *
 * Once a session has been read from the server, a failed read answers the last page it gave (or
 * nothing) rather than the store: the store may be stale, and its history id is another one. That
 * pin ends (`pinned`) when the server says it does not hold the session (a 404, which the caller
 * reads from the store), answers as another version, or has failed the session for
 * OPENCODE_V1_PIN_MS.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";

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
import { processStartedAt, sameProcessStart } from "./process-start.ts";
import { defaultStateDir } from "./update-state.ts";

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
export const OPENCODE_V1_MAX_WALK_REQUESTS = 24;
/** The server's own cursor, opaque: what it handed out, of the characters it hands out. */
const SERVER_CURSOR = /^[A-Za-z0-9_\-+/=]{1,1024}$/;
/** A session the server said it does not hold is not asked about again for this long. */
export const OPENCODE_V1_NOT_FOUND_MS = 30_000;
/** How long the watchdog waits between SIGTERM and SIGKILL to the server's process group. */
const WATCHDOG_GRACE_MS = 2_000;
/** How long a stop waits for the watchdog to exit: longer than its grace, and it is never killed from here. */
const STOP_WAIT_MS = WATCHDOG_GRACE_MS + 3_000;
/** A started server that answers as another version this many times is not started again. */
export const OPENCODE_V1_INCOMPATIBLE_STARTS = 3;
/** A session served over HTTP is read from the store again once the server has failed it this long. */
export const OPENCODE_V1_PIN_MS = 120_000;
/** OpenCode's event stream answers its headers within this, or it is tried again later. */
const EVENT_HEADERS_MS = 10_000;
/** OpenCode's event stream sends a heartbeat every 10 s: silence past this is a stream that is down. */
const EVENT_SILENCE_MS = 30_000;
/** One event past this is not read: it counts as a change of every session. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

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

const loopback = (hostname: string): boolean => hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);

/**
 * The mode the environment asks for. A URL that is not plain http(s) without credentials is none,
 * and so is a password that would go over plain http to another host, where anyone on the way reads it.
 */
export function opencodeV1Mode(env: Env = process.env): OpencodeV1Mode {
  const url = env["OVIS_OPENCODE_URL"]?.trim();
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const authorization = basicAuth(env);
    if (authorization !== null && parsed.protocol === "http:" && !loopback(parsed.hostname)) return null;
    return { kind: "url", endpoint: { baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, authorization } };
  }
  if (env["OVIS_OPENCODE_SERVE"] === "1") return { kind: "serve", bin: env["OVIS_OPENCODE_BIN"]?.trim() || "opencode" };
  return null;
}

/**
 * Whether a health check's version is OpenCode 1.x: `1.x`, or a build of a 1.x branch, which ends
 * in the version it was built from (`0.0.0-<branch>-v1.x.y`, or with a further `-…`).
 */
export function opencodeV1Version(version: unknown): boolean {
  return typeof version === "string" && /^(?:1\.\d|0\.0\.0-(?:.*-)?v1\.\d+\.\d+(?:-|$))/.test(version);
}

interface Answer { status: number; body: string; headers: IncomingHttpHeaders }

/** Connections kept open per origin: the newest page is asked again on every change (Bun's node:http keeps them, one socket for many requests). */
const agents = new Map<string, HttpAgent>();

function agentFor(url: URL): HttpAgent {
  let agent = agents.get(url.origin);
  if (agent === undefined) {
    agent = url.protocol === "https:" ? new HttpsAgent({ keepAlive: true, maxSockets: 4 }) : new HttpAgent({ keepAlive: true, maxSockets: 4 });
    agents.set(url.origin, agent);
    // a started server that came back moved port: the old origin's sockets go
    while (agents.size > 4) {
      const [origin, old] = agents.entries().next().value!;
      agents.delete(origin);
      old.destroy();
    }
  }
  return agent;
}

function closeAgents(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

/** GET only. node:http, as opencode-service.ts: Bun's fetch follows the proxy environment, and this server is local. */
export function opencodeV1Get(endpoint: OpencodeV1Endpoint, path: string, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = OPENCODE_V1_HTTP_TIMEOUT_MS): Promise<Answer | null> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(`${endpoint.baseUrl}${path}`); } catch { resolve(null); return; }
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      agent: agentFor(url),
      method: "GET",
      headers: { Accept: "application/json", ...(endpoint.authorization === null ? {} : { Authorization: endpoint.authorization }) },
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
      if (status < 200 || status >= 300) {
        resolve({ status, body: "", headers: response.headers });
        response.resume();
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

/** What an error was, for a log line: its class only, never its message (it may quote a session). */
const errorClass = (error: unknown): string => error instanceof Error ? error.constructor.name : typeof error;

/** A server's health check: "ready" when it is OpenCode 1.x, "incompatible" when another version, false when it does not answer healthy. */
async function health(endpoint: OpencodeV1Endpoint): Promise<"ready" | "incompatible" | false> {
  const answer = await opencodeV1Get(endpoint, "/global/health", 64 * 1024, 2_000);
  if (answer?.status !== 200) return false;
  let body: Row;
  try { body = record(JSON.parse(answer.body)); } catch { return false; }
  if (body.healthy !== true) return false;
  return opencodeV1Version(body.version) ? "ready" : "incompatible";
}

/* -------------------------------------------------------------------------------------------------
 * The server this one starts (OVIS_OPENCODE_SERVE=1)
 * ----------------------------------------------------------------------------------------------- */

export interface ServeChild {
  /** settles with the exit code (null when a signal ended it) */
  readonly exited: Promise<number | null>;
  /** ask its watchdog to stop it: the pipe to the watchdog closes, and the watchdog gets SIGTERM */
  stop(): void;
}

/** What starting a server takes, apart so the lifecycle can be tested without one. */
export interface ServeDeps {
  spawn(argv: string[], env: Record<string, string>): ServeChild;
  /** a loopback port free now: `--port 0` would take OpenCode's own default port first */
  freePort(): Promise<number>;
  /** "ready" once it answers healthy as OpenCode 1.x; "incompatible" when it answers as another version */
  ready(endpoint: OpencodeV1Endpoint): Promise<"ready" | "incompatible" | false>;
  now(): number;
  log(line: string): void;
}

export interface ServeOptions {
  startTimeoutMs?: number;
  readyPollMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** how long a stop waits for the server's watchdog to exit; longer than the watchdog's own grace */
  stopWaitMs?: number;
  /** how long one caller waits for a server that is starting */
  waitMs?: number;
  /** a server that answers its health check must still run this much later to count as up */
  settleMs?: number;
  /** a server that ran this long before it exited starts the backoff over */
  stableMs?: number;
}

/** The folders a started server uses: an empty working folder, and a record per running server. */
function serveFolders(): { cwd: string; run: string } {
  const root = join(opencodeV1Options.stateDir ?? defaultStateDir(), "opencode-serve");
  const cwd = join(root, "cwd");
  const run = join(root, "run");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(run, { recursive: true, mode: 0o700 });
  return { cwd, run };
}

const WATCHDOG = join(import.meta.dir, "opencode-watchdog.ts");

/** The `pid <n>` line the watchdog prints first. */
async function watchdogPid(stdout: ReadableStream<Uint8Array>): Promise<number | null> {
  const reader = stdout.getReader();
  let text = "";
  try {
    while (!text.includes("\n") && text.length < 64) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } catch { return null; }
  void reader.cancel().catch(() => undefined);
  const match = /^pid (\d+)\n/.exec(text);
  return match === null ? null : Number(match[1]);
}

/** A record of a running server, for reapOpencodeV1Orphans after a death that ran no exit handler. */
interface RunRecord { owner: { pid: number; started: number | null }; pid: number; started: number | null; args: string }

const defaultServeDeps: ServeDeps = {
  spawn(argv, env) {
    const folders = serveFolders();
    // stdin stays an open pipe the watchdog reads: it ends when this process does, however it ends
    const proc = Bun.spawn([process.execPath, WATCHDOG, String(WATCHDOG_GRACE_MS), ...argv], {
      env, cwd: folders.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
    });
    const pipe = proc.stdin;
    const recorded = watchdogPid(proc.stdout).then((pid) => {
      if (pid === null) return null;
      const entry: RunRecord = { owner: { pid: process.pid, started: processStartedAt(process.pid) }, pid, started: processStartedAt(pid), args: argv.slice(1).join(" ") };
      const file = join(folders.run, `${process.pid}-${pid}.json`);
      try { writeFileSync(file, JSON.stringify(entry), { mode: 0o600 }); } catch { return { entry, file: null }; }
      return { entry, file };
    });
    const exited = proc.exited.then(async (code) => {
      // the watchdog stops its server's group before it exits; one killed outright could not, and
      // then the group goes here, by the same checks as reapOpencodeV1Orphans
      const known = await recorded;
      if (known !== null) {
        if (stillRuns(known.entry, defaultReapDeps)) {
          try { defaultReapDeps.kill(known.entry.pid); } catch { /* gone already */ }
        }
        if (known.file !== null) rmSync(known.file, { force: true });
      }
      return proc.signalCode === null ? code : null;
    });
    return {
      exited,
      stop() {
        try { void pipe.end(); } catch { /* closed already */ }
        try { proc.kill("SIGTERM"); } catch { /* gone already */ }
      },
    };
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
  ready: (endpoint) => health(endpoint),
  now: () => Date.now(),
  log: (line) => console.error(line),
};

/** What reapOpencodeV1Orphans asks of the system, apart so it can be tested without killing anything. */
export interface ReapDeps {
  started(pid: number): number | null;
  /** the command line a process runs, as one string; null where that cannot be read */
  args(pid: number): string | null;
  /** SIGKILL to the process group `pid` leads */
  kill(pid: number): void;
}

function processArgs(pid: number): string | null {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { return null; }
  }
  if (process.platform === "darwin") {
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      return ps.exitCode === 0 ? ps.stdout.toString().trim() : null;
    } catch { return null; }
  }
  return null;
}

/** SIGKILL to the process group a started server leads (its watchdog started it as one); the process alone on Windows. */
function killGroup(pid: number): void {
  process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
}

const defaultReapDeps: ReapDeps = { started: processStartedAt, args: processArgs, kill: killGroup };

/** Whether the server a record names still runs: the same start (sameProcessStart), and its command line, so a reused pid is not it. */
function stillRuns(entry: RunRecord, deps: ReapDeps): boolean {
  return typeof entry.started === "number" && sameProcessStart(entry.started, deps.started(entry.pid)) && deps.args(entry.pid)?.endsWith(entry.args) === true;
}

/**
 * Stop each `opencode serve` an earlier run of this server started and left running: one whose
 * watchdog was killed outright with it (opencode-watchdog.ts normally stops it). Only a record
 * whose owner is gone counts, and only a server that still runs (stillRuns) is stopped, with the
 * process group it leads. Returns how many were stopped.
 */
export function reapOpencodeV1Orphans(stateDir = opencodeV1Options.stateDir ?? defaultStateDir(), deps: ReapDeps = defaultReapDeps): number {
  const run = join(stateDir, "opencode-serve", "run");
  let names: string[];
  try { names = readdirSync(run); } catch { return 0; }
  let reaped = 0;
  for (const name of names) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const file = join(run, name);
    let entry: RunRecord;
    try { entry = JSON.parse(readFileSync(file, "utf8")) as RunRecord; } catch { rmSync(file, { force: true }); continue; }
    const owner = record(entry.owner);
    if (typeof owner.pid !== "number" || typeof entry.pid !== "number" || typeof entry.args !== "string" || !entry.args.includes("serve --port ")) {
      rmSync(file, { force: true });
      continue;
    }
    if (typeof owner.started === "number" && sameProcessStart(owner.started, deps.started(owner.pid))) continue;
    if (stillRuns(entry, deps)) {
      try { deps.kill(entry.pid); reaped++; } catch { /* gone already */ }
    }
    rmSync(file, { force: true });
  }
  return reaped;
}

/**
 * Settings OpenCode reads that keep a server started only to be read from doing anything else:
 * no update, no model list fetch, no LSP download, no share, no external or default plugins, no
 * project config or skills from its folder, no file watcher.
 */
const QUIET_ENV: Record<string, string> = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  OPENCODE_PURE: "1",
};

/**
 * The environment a started server gets: this one's, without herdr's pane identity (it is no
 * pane's agent), with QUIET_ENV, and with its own password.
 */
export function serveEnvironment(env: Env, password: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("HERDR_") || key.startsWith("OVIS_") || key === "OPENCODE_SERVER_PASSWORD" || key === "OPENCODE_SERVER_USERNAME") continue;
    out[key] = value;
  }
  Object.assign(out, QUIET_ENV);
  out["OPENCODE_SERVER_USERNAME"] = "opencode";
  out["OPENCODE_SERVER_PASSWORD"] = password;
  return out;
}

/** Every server started and not yet exited, whichever instance started it: a process `exit` handler stops them all. */
const liveChildren = new Set<ServeChild>();
let exitHook = false;

function track(child: ServeChild): void {
  liveChildren.add(child);
  void child.exited.finally(() => liveChildren.delete(child));
  if (exitHook) return;
  exitHook = true;
  process.once("exit", stopOpencodeV1Now);
}

/**
 * The last word, from a process `exit` handler, where no waiting is possible: every started
 * server's watchdog is asked to stop it (its pipe closes, it gets SIGTERM), and stops it alone.
 */
export function stopOpencodeV1Now(): void {
  for (const each of liveChildren) each.stop();
}

/**
 * One `opencode serve` on loopback, started on first use. A start that fails, or a server that
 * exits, waits a backoff (doubling, capped) before the next use starts another; only a server that
 * stayed up `stableMs` starts the count over. Meanwhile callers get no endpoint. One that answers
 * as another version OPENCODE_V1_INCOMPATIBLE_STARTS times is not started again.
 */
export class OpencodeServe {
  private child: ServeChild | null = null;
  private endpointNow: OpencodeV1Endpoint | null = null;
  private starting: Promise<OpencodeV1Endpoint | null> | null = null;
  private failures = 0;
  private retryAt = 0;
  private incompatibleStarts = 0;
  /** the last health check it answered said another version */
  private lastIncompatible = false;
  private stopping: Promise<void> | null = null;
  private readonly options: Required<ServeOptions>;

  constructor(private readonly bin: string, private readonly env: Env = process.env, private readonly deps: ServeDeps = defaultServeDeps, options: ServeOptions = {}) {
    this.options = {
      startTimeoutMs: options.startTimeoutMs ?? OPENCODE_V1_START_TIMEOUT_MS,
      readyPollMs: options.readyPollMs ?? 200,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      stopWaitMs: options.stopWaitMs ?? STOP_WAIT_MS,
      waitMs: options.waitMs ?? 10_000,
      settleMs: options.settleMs ?? 250,
      stableMs: options.stableMs ?? 60_000,
    };
  }

  get state(): "idle" | "starting" | "ready" | "backoff" | "incompatible" | "stopped" {
    if (this.stopping !== null) return "stopped";
    if (this.starting !== null) return "starting";
    if (this.endpointNow !== null) return "ready";
    if (this.gaveUp) return "incompatible";
    return this.deps.now() < this.retryAt ? "backoff" : "idle";
  }

  /** Its last health check answered as another version than OpenCode 1.x. */
  get incompatible(): boolean { return this.lastIncompatible; }

  private get gaveUp(): boolean { return this.incompatibleStarts >= OPENCODE_V1_INCOMPATIBLE_STARTS; }

  /** The server running now, starting none. */
  get current(): OpencodeV1Endpoint | null { return this.endpointNow; }

  /** The running server, started now if none runs and no backoff holds; null while it cannot be had. */
  endpoint(): Promise<OpencodeV1Endpoint | null> {
    if (this.stopping !== null) return Promise.resolve(null);
    if (this.endpointNow !== null) return Promise.resolve(this.endpointNow);
    if (this.starting === null) {
      if (this.gaveUp || this.deps.now() < this.retryAt) return Promise.resolve(null);
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    // a chat waits for a server starting this long, then reads its fallback until it is up
    const waited = Promise.withResolvers<null>();
    const timer = setTimeout(() => waited.resolve(null), this.options.waitMs);
    timer.unref?.();
    return Promise.race([this.starting.finally(() => clearTimeout(timer)), waited.promise]);
  }

  private backoff(why: string): void {
    this.failures++;
    if (this.gaveUp) {
      this.deps.log(`OpenCode server ${why}; it is not started again until OVIS_OPENCODE_BIN changes or the app restarts.`);
      return;
    }
    const wait = Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * 2 ** (this.failures - 1));
    this.retryAt = this.deps.now() + wait;
    this.deps.log(`OpenCode server ${why}; the next chat that needs it starts it again in ${Math.ceil(wait / 1000)}s.`);
  }

  private async start(): Promise<OpencodeV1Endpoint | null> {
    let child: ServeChild;
    let endpoint: OpencodeV1Endpoint;
    try {
      const port = await this.deps.freePort();
      if (this.stopping !== null) return null;
      const password = randomBytes(24).toString("base64url");
      endpoint = { baseUrl: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
      child = this.deps.spawn([this.bin, "serve", "--port", String(port), "--hostname", "127.0.0.1", "--mdns=false"], serveEnvironment(this.env, password));
    } catch (error) {
      this.backoff(`could not start (${errorClass(error)})`);
      return null;
    }
    this.child = child;
    track(child);
    let exited = false;
    let readyAt: number | null = null;
    let why: string | null = null;
    void child.exited.then((code) => {
      exited = true;
      if (this.child !== child) return;
      this.child = null;
      this.endpointNow = null;
      if (this.stopping !== null) return;
      // a server that dies soon after it answered keeps the backoff growing; one that ran a while starts it over
      if (readyAt !== null && this.deps.now() - readyAt >= this.options.stableMs) this.failures = 0;
      this.backoff(why ?? `exited (code ${code ?? "none"})`);
    });
    const deadline = this.deps.now() + this.options.startTimeoutMs;
    while (!exited && this.stopping === null && this.deps.now() < deadline) {
      const answer = await this.deps.ready(endpoint).catch(() => false as const);
      if (answer === "incompatible") {
        why = "is not OpenCode 1.x";
        this.lastIncompatible = true;
        this.incompatibleStarts++;
        this.failures = Math.max(this.failures, 30);
        break;
      }
      if (answer === "ready") {
        this.lastIncompatible = false;
        // one that answers and exits at once (its port taken, a crash after startup) is not up
        await Promise.race([child.exited, Bun.sleep(this.options.settleMs)]);
        if (exited || this.stopping !== null || this.child !== child) return null;
        readyAt = this.deps.now();
        this.endpointNow = endpoint;
        return endpoint;
      }
      await Bun.sleep(this.options.readyPollMs);
    }
    if (exited) return null;
    why ??= "did not answer its health check";
    // its watchdog stops it, and its exit sets the backoff
    if (this.child === child) child.stop();
    return null;
  }

  /**
   * Stop the server for good (this server is stopping): its watchdog is asked to, and this waits
   * for it up to `stopWaitMs`, longer than the watchdog's own grace. Asked again, the same wait.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.endpointNow = null;
      const child = this.child;
      this.child = null;
      if (child === null) return;
      child.stop();
      // fixed wait: the most a stop waits for the watchdog, raced against its exit
      const waited = Bun.sleep(this.options.stopWaitMs);
      await Promise.race([child.exited.catch(() => undefined), waited]);
    })();
    return this.stopping;
  }
}

/** Tests point the source at a fixture: an environment, the deps a started server uses, a state folder, a clock, a page window, a cache budget. */
export const opencodeV1Options: { env?: Env; deps?: ServeDeps; serve?: ServeOptions; stateDir?: string; now?: () => number; windowBytes?: number; heldBytes?: number } = {};

let serve: { key: string; instance: OpencodeServe } | null = null;
/** Set once this server is stopping: nothing starts another OpenCode server after it. */
let shutdown: Promise<void> | null = null;

const sourceEnv = (): Env => opencodeV1Options.env ?? process.env;
const now = (): number => (opencodeV1Options.now ?? Date.now)();

/** Whether the HTTP source is configured at all; nothing is started by asking. */
export function opencodeV1Configured(): boolean {
  return opencodeV1Mode(sourceEnv()) !== null;
}

/**
 * A named server's health check, once per endpoint: "ready" or "incompatible" is kept until the
 * endpoint changes or this server restarts, and one that did not answer is asked again next time.
 */
let urlCheck: { key: string; state: "unchecked" | "ready" | "incompatible" | "failed"; pending: Promise<void> | null } | null = null;
let loggedIncompatibleUrl = false;

const endpointKey = (endpoint: OpencodeV1Endpoint): string => `${endpoint.baseUrl}\0${endpoint.authorization ?? ""}`;

function urlCheckOf(endpoint: OpencodeV1Endpoint): NonNullable<typeof urlCheck> {
  const key = endpointKey(endpoint);
  if (urlCheck?.key !== key) {
    urlCheck = { key, state: "unchecked", pending: null };
    loggedIncompatibleUrl = false;
  }
  return urlCheck;
}

async function checkedUrl(endpoint: OpencodeV1Endpoint): Promise<OpencodeV1Endpoint | null> {
  const check = urlCheckOf(endpoint);
  if (check.state === "unchecked" || check.state === "failed") {
    check.pending ??= health(endpoint).catch(() => false as const).then((answer) => {
      check.pending = null;
      check.state = answer === false ? "failed" : answer;
      if (answer === "incompatible" && !loggedIncompatibleUrl) {
        loggedIncompatibleUrl = true;
        console.error("The OpenCode server OVIS_OPENCODE_URL names is not OpenCode 1.x; chats are read from opencode.db until it changes or the app restarts.");
      }
    });
    await check.pending;
  }
  return check.state === "ready" ? endpoint : null;
}

/** The server to read from: the configured one, or the one this server starts; null when none is configured or can be had now. */
export async function opencodeV1Endpoint(): Promise<OpencodeV1Endpoint | null> {
  const env = sourceEnv();
  const mode = opencodeV1Mode(env);
  if (mode === null) return null;
  if (mode.kind === "url") return checkedUrl(mode.endpoint);
  if (shutdown !== null) return null;
  if (serve?.key !== mode.bin) {
    void serve?.instance.stop();
    serve = { key: mode.bin, instance: new OpencodeServe(mode.bin, env, opencodeV1Options.deps, opencodeV1Options.serve) };
  }
  return serve.instance.endpoint();
}

/** The server to read from as it stands, starting none. */
function currentEndpoint(): OpencodeV1Endpoint | null {
  const mode = opencodeV1Mode(sourceEnv());
  if (mode === null) return null;
  if (mode.kind === "url") return urlCheck?.key === endpointKey(mode.endpoint) && urlCheck.state === "ready" ? mode.endpoint : null;
  return shutdown === null && serve?.key === mode.bin ? serve.instance.current : null;
}

/**
 * Where the HTTP source stands, asking and starting nothing: what a pane's monitor watches, so that
 * a chat read from the store while the server was starting or backing off is read again once it
 * is ready. "off" when it is not configured.
 */
export function opencodeV1State(): "off" | "starting" | "ready" | "backoff" | "unavailable" {
  const mode = opencodeV1Mode(sourceEnv());
  if (mode === null) return "off";
  if (mode.kind === "url") {
    const check = urlCheck?.key === endpointKey(mode.endpoint) ? urlCheck : null;
    if (check === null || check.state === "unchecked") return "starting";
    return check.state === "ready" ? "ready" : check.state === "failed" ? "backoff" : "unavailable";
  }
  if (shutdown !== null || serve?.key !== mode.bin) return "unavailable";
  const state = serve.instance.state;
  return state === "starting" || state === "ready" || state === "backoff" ? state : "unavailable";
}

/** The source answered as another version than OpenCode 1.x. */
function sourceIncompatible(): boolean {
  const mode = opencodeV1Mode(sourceEnv());
  if (mode === null) return false;
  if (mode.kind === "url") return urlCheck?.key === endpointKey(mode.endpoint) && urlCheck.state === "incompatible";
  return serve?.key === mode.bin && serve.instance.incompatible;
}

/**
 * Stop the server this one started, if any, and the event stream, for good: this server is
 * stopping. Every call gets the same wait, and no server is started after it.
 */
export function stopOpencodeV1(): Promise<void> {
  shutdown ??= (async () => {
    events?.close();
    events = null;
    const running = serve;
    serve = null;
    await running?.instance.stop();
    closeAgents();
  })();
  return shutdown;
}

/** Tests only: after stopOpencodeV1, let the source start again, remembering nothing. */
export async function resetOpencodeV1(): Promise<void> {
  await stopOpencodeV1();
  shutdown = null;
  urlCheck = null;
  loggedIncompatibleUrl = false;
  forgetOpencodeV1State();
}

/* -------------------------------------------------------------------------------------------------
 * What changed: OpenCode's event stream
 * ----------------------------------------------------------------------------------------------- */

/**
 * OpenCode's read-only event stream (`GET /global/event`, else `/event` on a build without it):
 * which sessions a `message.*` or `session.*` event named. A server hears only the writes it makes
 * itself, so a started `opencode serve`, which writes nothing, carries no other process's chat;
 * a session counts as carried once an event named it on this connection.
 */
class EventStream {
  private readonly counts = new Map<string, number>();
  private readonly carried = new Set<string>();
  /** events past MAX_EVENT_CHARS or naming no session: a change of every session */
  private overflow = 0;
  private request: ClientRequest | null = null;
  private connected = false;
  private heardAt = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private path = "/global/event";

  constructor(readonly endpoint: OpencodeV1Endpoint) { this.connect(); }

  live(): boolean {
    if (this.connected && now() - this.heardAt > EVENT_SILENCE_MS) this.drop();
    return this.connected;
  }

  count(sessionId: string): number { return (this.counts.get(sessionId) ?? 0) + this.overflow; }

  carries(sessionId: string): boolean { return this.live() && this.carried.has(sessionId); }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.drop();
  }

  private drop(): void {
    const req = this.request;
    this.request = null;
    this.connected = false;
    this.carried.clear();
    req?.destroy();
    this.retry();
  }

  private retry(delay?: number): void {
    if (this.closed || this.timer !== undefined) return;
    this.failures++;
    const wait = delay ?? Math.min(30_000, 1_000 * 2 ** (this.failures - 1));
    this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, wait);
    this.timer.unref?.();
  }

  private connect(): void {
    if (this.closed) return;
    let url: URL;
    try { url = new URL(`${this.endpoint.baseUrl}${this.path}`); } catch { return; }
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      agent: false,
      method: "GET",
      headers: { Accept: "text/event-stream", ...(this.endpoint.authorization === null ? {} : { Authorization: this.endpoint.authorization }) },
    }, (response) => {
      clearTimeout(headers);
      if (this.request !== req) { response.destroy(); return; }
      if (response.statusCode === 404 && this.path === "/global/event") {
        this.path = "/event";
        this.request = null;
        response.destroy();
        this.retry(0);
        return;
      }
      if (response.statusCode !== 200) { response.destroy(); this.drop(); return; }
      this.connected = true;
      this.heardAt = now();
      this.failures = 0;
      response.setEncoding("utf8");
      let buffer = "";
      let skipping = false;
      response.on("data", (text: string) => {
        this.heardAt = now();
        buffer += text.replace(/\r\n?/g, "\n");
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (skipping) skipping = false;
          else this.take(block);
        }
        if (buffer.length > MAX_EVENT_CHARS) {
          if (!skipping) this.overflow++;
          skipping = true;
          buffer = buffer.endsWith("\n") ? "\n" : "";
        }
      });
      const ended = () => { if (this.request === req) this.drop(); };
      response.once("end", ended);
      response.once("close", ended);
      response.once("error", ended);
    });
    // a server that takes the connection and never answers is a stream that is down
    const headers = setTimeout(() => { if (this.request === req) this.drop(); }, EVENT_HEADERS_MS);
    headers.unref?.();
    this.request = req;
    req.once("error", () => { clearTimeout(headers); if (this.request === req) this.drop(); });
    req.end();
  }

  private take(block: string): void {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data === "") return;
    let value: Row;
    try { value = record(JSON.parse(data)); } catch { return; }
    // /global/event wraps each event as `{ directory, payload }`
    const event = value.payload === undefined ? value : record(value.payload);
    const type = event.type;
    if (typeof type !== "string" || !/^(?:message|session)\./.test(type)) return;
    const properties = record(event.properties);
    const named = [properties.sessionID, record(properties.part).sessionID, record(properties.info).sessionID, type.startsWith("session.") ? record(properties.info).id : undefined]
      .find((id): id is string => typeof id === "string" && OPENCODE_SESSION_ID.test(id));
    if (named === undefined) { this.overflow++; return; }
    remember(this.counts, named, (this.counts.get(named) ?? 0) + 1, 512);
    this.carried.add(named);
  }
}

let events: EventStream | null = null;

/**
 * How a pane's monitor watches a session the server serves: how often OpenCode's event stream
 * named it, and whether that stream carries its changes at all (then its signature is asked
 * less often). Subscribes on the first ask; starts no server.
 */
export function opencodeV1Changes(sessionId: string): { count: number; carried: boolean } {
  const endpoint = currentEndpoint();
  if (endpoint === null) {
    // a started server that is down: its stream goes with it, and one opens to the next
    events?.close();
    events = null;
    return { count: 0, carried: false };
  }
  if (events?.endpoint.baseUrl !== endpoint.baseUrl || events.endpoint.authorization !== endpoint.authorization) {
    events?.close();
    events = new EventStream(endpoint);
  }
  return { count: events.count(sessionId), carried: events.carries(sessionId) };
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
  /** messages the server answered after these, which a later walk took from a newer chunk */
  tail?: number;
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

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Sessions the server said it does not hold, until when that is believed. */
const missing = new Map<string, number>();

function knownMissing(sessionId: string): boolean {
  const until = missing.get(sessionId);
  if (until === undefined) return false;
  if (now() < until) return true;
  missing.delete(sessionId);
  return false;
}

/** The session's info, or null when the server holds no such session. */
async function sessionInfo(endpoint: OpencodeV1Endpoint, sessionId: string): Promise<Row | null> {
  const answer = await getJson(endpoint, `/session/${enc(sessionId)}`);
  if (answer.status === 404) {
    remember(missing, sessionId, now() + OPENCODE_V1_NOT_FOUND_MS, 256);
    served.delete(sessionId);
    return null;
  }
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

/**
 * Chunks older than the newest, by session, size and server cursor, for older pages. What comes
 * before a message stays as it was (a `/undo` hides newer messages, under another history id, and
 * deletes nothing older), so neither these nor a walk's reused chunks (`spines`) are asked again.
 *
 * Both share one budget, OPENCODE_V1_HELD_BYTES of the messages' JSON: a message held by a
 * cached chunk and a spine both, or by a chunk and the cut of it a later walk reused, is counted
 * once (`holders`). Past it, cached chunks go first, oldest first, then spines, oldest first. The
 * parsed copy of each message kept beside its JSON takes about as much again; the pages answered
 * (`answers`) are bounded apart, by count.
 */
const chunks = new Map<string, Chunk>();
export const OPENCODE_V1_HELD_BYTES = 4 * OPENCODE_WINDOW_BYTES;
const CHUNK_CACHE_ENTRIES = 128;
const holders = new Map<Wire, number>();
let heldBytes = 0;

const heldBudget = (): number => opencodeV1Options.heldBytes ?? OPENCODE_V1_HELD_BYTES;
const chunkSize = (found: Chunk): number => found.messages.reduce((sum, each) => sum + each.size, 0);

function hold(found: Chunk): void {
  for (const each of found.messages) {
    const count = holders.get(each) ?? 0;
    if (count === 0) heldBytes += each.size;
    holders.set(each, count + 1);
  }
}

function release(found: Chunk): void {
  for (const each of found.messages) {
    const count = (holders.get(each) ?? 1) - 1;
    if (count > 0) holders.set(each, count);
    else if (holders.delete(each)) heldBytes -= each.size;
  }
}

/** The JSON bytes of the messages the chunk cache and the spines hold, each counted once. */
export const opencodeV1HeldBytes = (): number => heldBytes;

function dropChunk(key: string): void {
  const found = chunks.get(key);
  if (found === undefined) return;
  chunks.delete(key);
  release(found);
}

function dropSpine(sessionId: string): void {
  const found = spines.get(sessionId);
  if (found === undefined) return;
  spines.delete(sessionId);
  for (const each of found) release(each);
}

function keepSpine(sessionId: string, found: Chunk[]): void {
  for (const each of found) hold(each);
  dropSpine(sessionId);
  spines.set(sessionId, found);
  while (spines.size > 8) dropSpine(spines.keys().next().value!);
  trim();
}

function trim(): void {
  while (heldBytes > heldBudget() && chunks.size > 0) dropChunk(chunks.keys().next().value!);
  while (heldBytes > heldBudget() && spines.size > 0) dropSpine(spines.keys().next().value!);
}

function keepChunk(key: string, found: Chunk): void {
  if (chunkSize(found) > heldBudget() / 4) return;
  hold(found);
  dropChunk(key);
  chunks.set(key, found);
  while (chunks.size > CHUNK_CACHE_ENTRIES) dropChunk(chunks.keys().next().value!);
  trim();
}

/** The newest `limit` messages before the server cursor `before`, oldest first; null when the session is gone. */
async function chunk(endpoint: OpencodeV1Endpoint, sessionId: string, limit: number, before: string | undefined): Promise<Chunk | null> {
  const key = before === undefined ? null : `${sessionId}\0${limit}\0${before}`;
  if (key !== null) {
    const cached = chunks.get(key);
    if (cached !== undefined) {
      chunks.delete(key);
      chunks.set(key, cached);
      return cached;
    }
  }
  const answer = await getJson(endpoint, `/session/${enc(sessionId)}/message?limit=${limit}${before === undefined ? "" : `&before=${enc(before)}`}`);
  if (answer.status === 404) return null;
  if (!Array.isArray(answer.value)) throw new SourceFailed("not a list");
  const messages = answer.value.map((value) => wire(value, sessionId));
  if (messages.some((found) => found === null)) throw new SourceFailed("not a message");
  const header = answer.headers["x-next-cursor"];
  const next = typeof header === "string" && SERVER_CURSOR.test(header) ? header : null;
  const found = { before, messages: messages as Wire[], next };
  if (key !== null) keepChunk(key, found);
  return found;
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

/** Per session: the server cursor for the messages before a message, as the server handed it out (never as a chat sent it back). */
const tokens = new Map<string, Map<string, string>>();
/** Per page asked for: the answer, while its signature holds, and the one a failed read answers with. */
const answers = new Map<string, { signature: string; answer: Extract<OpencodeAnswer, { kind: "page" }> }>();
/**
 * Sessions read from the server in this process, and since when the server has failed each (null
 * while it answers): a failed read of one answers from here, not the store, until the pin ends
 * (`pinned`).
 */
const served = new Map<string, number | null>();

function pin(sessionId: string): void {
  served.delete(sessionId);
  served.set(sessionId, null);
  if (served.size > 256) served.delete(served.keys().next().value!);
}

/** A failed read of a pinned session: the first starts its clock. */
function failedFor(sessionId: string): void {
  if (served.get(sessionId) === null) served.set(sessionId, now());
}

/**
 * Whether a session stays with the server: it was read from it, and the pin has not ended. It
 * ends when the server answers as another version than OpenCode 1.x, has failed the session for
 * longer than OPENCODE_V1_PIN_MS, or says it does not hold it; then the store answers again.
 */
function pinned(sessionId: string): boolean {
  if (!served.has(sessionId)) return false;
  if (sourceIncompatible()) {
    served.clear();
    return false;
  }
  const since = served.get(sessionId);
  if (since !== null && since !== undefined && now() - since > OPENCODE_V1_PIN_MS) {
    served.delete(sessionId);
    return false;
  }
  return true;
}

/** What the caches here are keyed by, and what a pane's chat is remembered against (conversation.ts `rememberPaneRead`). */
export const opencodeV1ReadKey = (sessionId: string): string => `opencode-http\0${sessionId}`;

export function forgetOpencodeV1Read(key: string): void {
  if (!key.startsWith("opencode-http\0")) return;
  const sessionId = key.slice("opencode-http\0".length);
  tokens.delete(key);
  for (const entry of [...answers.keys()]) if (entry.startsWith(`${key}\0`)) answers.delete(entry);
  for (const entry of [...chunks.keys()]) if (entry.startsWith(`${sessionId}\0`)) dropChunk(entry);
  dropSpine(sessionId);
}

export function forgetOpencodeV1State(): void {
  tokens.clear();
  answers.clear();
  chunks.clear();
  spines.clear();
  holders.clear();
  heldBytes = 0;
  missing.clear();
  served.clear();
  loggedErrors.clear();
}

/** Whether this session stays with the server (`pinned`): the monitor asks the server about it only then. */
export const opencodeV1Serving = (sessionId: string): boolean => pinned(sessionId);

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

/** Per session: the chunks of its last walk from the newest message, oldest first. */
const spines = new Map<string, Chunk[]>();

/**
 * The last walk's chunks older than the newest chunk asked now: everything before that chunk's
 * oldest message, when the last walk holds it. null when it does not (more new messages than a
 * chunk, or another history), and the walk asks the server.
 */
function reuse(prior: Chunk[] | undefined, newest: Chunk): Chunk[] | null {
  const oldest = newest.messages[0]?.id;
  if (prior === undefined || oldest === undefined || newest.next === null) return null;
  for (let c = prior.length - 1; c >= 0; c--) {
    const cut = prior[c]!;
    const at = cut.messages.findIndex((each) => each.id === oldest);
    if (at < 0) continue;
    const kept = prior.slice(0, c);
    if (at > 0) kept.push({ before: cut.before, messages: cut.messages.slice(0, at), next: cut.next, tail: (cut.tail ?? 0) + cut.messages.length - at });
    return kept;
  }
  return null;
}

/**
 * Walk back from `before` a chunk at a time until `pageStart` finds the page's start, the walk
 * reaches `floor` or the session's start, or it has asked OPENCODE_V1_MAX_WALK_REQUESTS times.
 * A walk from the newest message asks for the newest chunk and takes what is older from the last
 * such walk where it can. Messages from `boundary` on (a staged `/undo`) are left out; meeting it
 * while walking back from an older cursor means the cursor is past it.
 */
async function walk(endpoint: OpencodeV1Endpoint, sessionId: string, options: { before?: string; floor?: string; widen: boolean; boundary: string | null }): Promise<Walk | null> {
  let fetched: Chunk[] = [];
  let before = options.before;
  let limit = FIRST_CHUNK;
  let boundarySeen = false;
  const fromNewest = options.before === undefined;
  for (let requests = 0; ; requests++) {
    const found = await chunk(endpoint, sessionId, limit, before);
    if (found === null) return null;
    fetched.unshift(found);
    if (fromNewest && fetched.length === 1) {
      const older = reuse(spines.get(sessionId), found);
      if (older !== null) fetched = [...older, found];
    }
    const visible: Wire[] = [];
    const place: { chunk: number; index: number }[] = [];
    boundarySeen = false;
    fetched.forEach((each, c) => each.messages.forEach((wired, index) => {
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
    const start = pageStart(rows, -1, options.widen, opencodeV1Options.windowBytes ?? OPENCODE_WINDOW_BYTES);
    const oldest = fetched[0]!;
    const beginning = oldest.next === null;
    const done = start >= 0 || floorAt >= 0 || beginning || requests + 1 >= OPENCODE_V1_MAX_WALK_REQUESTS;
    if (done) {
      let chosen = start >= 0 ? start : floorAt >= 0 ? floorAt : 0;
      if (start < 0 && floorAt < 0 && !beginning) {
        // asked enough: the earliest prompt fetched, as the store reader starts a window with no reach
        const prompt = visible.findIndex((wired) => wired.role === "user");
        if (prompt > 0) chosen = prompt;
      }
      if (fromNewest && fetched.reduce((sum, each) => sum + chunkSize(each), 0) <= heldBudget() / 2) keepSpine(sessionId, fetched);
      return { chunks: fetched, visible, place, start: chosen, floor: floorAt >= 0 ? floorAt : null, beginning, boundarySeen };
    }
    before = oldest.next!;
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
  const again = await chunk(endpoint, sessionId, owner.messages.length + (owner.tail ?? 0) - index, owner.before);
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

/** Error classes already logged: one line each, for a failure the source does not expect. */
const loggedErrors = new Set<string>();

/** A failed read: an unexpected one is logged once by its class, and every one leaves the caller its fallback. */
function readFailed(error: unknown): void {
  if (error instanceof SourceFailed) return;
  const name = errorClass(error);
  if (loggedErrors.has(name)) return;
  loggedErrors.add(name);
  console.error(`Reading a chat from the OpenCode server failed (${name}); it is read from the fallback.`);
}

const pageKey = (sessionId: string, page: OpencodePage): string => `${opencodeV1ReadKey(sessionId)}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}`;

/**
 * One page of the session (as conversation.ts's ConversationPage), from the HTTP source. null when
 * the source is not configured, or cannot answer for a session it never served: the caller reads
 * the store. A session it served before is answered with its last page, or as unavailable
 * (`store_busy`), so the chat neither goes back to a store that may be stale nor changes history.
 */
export async function opencodeV1Conversation(sessionId: string, page: OpencodePage = {}): Promise<OpencodeAnswer | null> {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return { kind: "unavailable", reason: "no_session_id" };
  if (!opencodeV1Configured()) return null;
  if (knownMissing(sessionId)) return { kind: "unavailable", reason: "session_not_found" };
  const cacheKey = pageKey(sessionId, page);
  const held = (): OpencodeAnswer | null => {
    failedFor(sessionId);
    return pinned(sessionId) ? answers.get(cacheKey)?.answer ?? { kind: "unavailable", reason: "store_busy" } : null;
  };
  const endpoint = await opencodeV1Endpoint();
  if (endpoint === null) return held();
  try {
    const answer = await conversationAt(endpoint, sessionId, page, cacheKey);
    if (answer.kind === "page") pin(sessionId);
    return answer;
  } catch (error) {
    readFailed(error);
    return held();
  }
}

async function conversationAt(endpoint: OpencodeV1Endpoint, sessionId: string, page: OpencodePage, cacheKey: string): Promise<OpencodeAnswer> {
  const info = await sessionInfo(endpoint, sessionId);
  if (info === null) return { kind: "unavailable", reason: "session_not_found" };
  const boundary = revertBoundary(info);
  const historyId = `opencode-http-${sessionId}${boundary === null ? "" : `-r${boundary}`}`;
  const key = opencodeV1ReadKey(sessionId);

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
      // a chat that shows older pages keeps every turn after its held start while they are inside the
      // newest page; its cursor goes back as it came, and its token is not learned from it
      start = held;
      cursor = page.from!;
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
 * One message a page ref names, unless an undo hid it. undefined when the store should answer
 * instead: the source is not configured, does not hold the session (a page the store reader
 * gave), or cannot answer for a session it never served. A session it served is not handed to the
 * store: a failed read there is null.
 */
async function refMessage(sessionId: string, id: string): Promise<Wire | null | undefined> {
  if (!OPENCODE_SESSION_ID.test(sessionId) || !OPENCODE_MESSAGE_ID.test(id)) return null;
  if (!opencodeV1Configured() || knownMissing(sessionId)) return undefined;
  const fallback = (): null | undefined => {
    failedFor(sessionId);
    return pinned(sessionId) ? null : undefined;
  };
  const endpoint = await opencodeV1Endpoint();
  if (endpoint === null) return fallback();
  try {
    const info = await sessionInfo(endpoint, sessionId);
    if (info === null) return undefined;
    const found = await message(endpoint, sessionId, id);
    if (found === null) return null;
    return await hiddenByRevert(endpoint, sessionId, info, found) ? null : found;
  } catch (error) {
    readFailed(error);
    return fallback();
  }
}

/** The whole output of a tool call a page cut, by its ref; undefined when the store should answer instead (refMessage). */
export async function opencodeV1ToolOutput(sessionId: string, ref: string): Promise<string | null | undefined> {
  const match = OPENCODE_TOOL_REF.exec(ref);
  if (match === null) return null;
  const found = await refMessage(sessionId, match[1]!);
  return found === null || found === undefined ? found : opencodeMessage1ToolOutput(found, ref);
}

/** An image a page named by its ref, decoded; undefined when the store should answer instead (refMessage). */
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
  if (!OPENCODE_SESSION_ID.test(sessionId) || knownMissing(sessionId)) return null;
  try {
    const endpoint = await opencodeV1Endpoint();
    if (endpoint === null) {
      failedFor(sessionId);
      return null;
    }
    const [info, newest] = await Promise.all([
      opencodeV1Get(endpoint, `/session/${enc(sessionId)}`, 1024 * 1024),
      opencodeV1Get(endpoint, `/session/${enc(sessionId)}/message?limit=1`),
    ]);
    if (info === null || newest === null || info.status >= 500 || newest.status >= 500) {
      failedFor(sessionId);
      return null;
    }
    if (served.has(sessionId) && info.status === 200) served.set(sessionId, null);
    return createHash("sha256").update(`${info.status}\0${info.body}\0${newest.status}\0${newest.body}`).digest("base64url").slice(0, 22);
  } catch (error) {
    readFailed(error);
    return null;
  }
}
