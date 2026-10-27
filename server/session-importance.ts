/**
 * How much each agent pane matters, for Settings → Agents order → Importance. A pane running an
 * OpenCode session (`agent_session` kind `id`, a `ses_` id) is asked about at opencode-memory's
 * `session_importance` tool, at most every POLL_MS and only while a browser watches; memory that
 * is down, refuses or does not know the tool yet leaves every pane neutral (P2), which orders the
 * list as Longest wait does. The wait clocks stamp when this server first saw each pane in its
 * current state, and are kept beside the shared preferences so a restart keeps them.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isImportanceLevel, type AgentStatus, type HerdrPane, type ImportanceLevel, type PaneImportance, type PaneWait } from "../shared/protocol.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";

export const POLL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** memory without the tool yet is asked again this much later */
const MISSING_TOOL_BACKOFF_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_SESSIONS = 200;
const MAX_REASON = 300;
const DEFAULT_MEMORY_URL = "http://127.0.0.1:9824";

export interface MemoryEndpoint {
  url: string;
  /** the API key, read at each call so a rotated key is picked up; null when none is set or it may not be sent there */
  key: () => string | null;
}

const loopback = (host: string): boolean => host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);

/** The memory key file opencode-memory itself reads (http_server.py `_api_key_file`). */
export function memoryKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_CONFIG_HOME"]?.trim() || join(homedir(), ".config");
  return join(base, "opencode-memory", "secrets", "api_key");
}

/**
 * Where opencode-memory answers: OVIS_MEMORY_URL, else its default loopback address; `off` turns
 * importance off. The key comes from OPENCODE_MEMORY_API_KEY, else memory's own key file, and is
 * never sent over plain http to another host. Under `bun test` nothing is asked unless a test says so.
 */
export function memoryEndpoint(env: NodeJS.ProcessEnv = process.env): MemoryEndpoint | null {
  const raw = env["OVIS_MEMORY_URL"]?.trim();
  if (raw === "off" || raw === "0" || raw === "false") return null;
  if (!raw && env["NODE_ENV"] === "test") return null;
  let url: URL;
  try { url = new URL(raw || DEFAULT_MEMORY_URL); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const mayCarryKey = url.protocol === "https:" || loopback(url.hostname);
  const keyFile = memoryKeyFile(env);
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ""),
    key: () => {
      if (!mayCarryKey) return null;
      const fromEnv = env["OPENCODE_MEMORY_API_KEY"]?.trim();
      if (fromEnv) return fromEnv;
      try { return existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() || null : null; } catch { return null; }
    },
  };
}

/** A pane's OpenCode session id, when herdr reports one. */
export function paneSessionId(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  return session && session.kind === "id" && typeof session.value === "string" && session.value.startsWith("ses_") ? session.value : null;
}

/**
 * A /tools answer as the tool gave it: opencode-memory sends a dict as it is, a dispatcher's
 * result as a JSON string, and an MCP-style call as `{content: [{type: "text", text}]}`.
 */
export function unwrapToolResult(body: unknown): unknown {
  let value = body;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); continue; } catch { return value; }
    }
    if (Array.isArray(value)) {
      const text = value.find((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
      if (!text) return value;
      value = text.text;
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if ("sessions" in record || "error" in record || "ok" in record) return record;
      if ("result" in record) { value = record["result"]; continue; }
      if (Array.isArray(record["content"])) { value = record["content"]; continue; }
    }
    return value;
  }
  return value;
}

function readImportance(raw: unknown): PaneImportance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isImportanceLevel(record["level"])) return null;
  const override = record["override"];
  const overrideRecord = typeof override === "object" && override !== null ? override as Record<string, unknown> : null;
  return {
    level: record["level"],
    source: typeof record["source"] === "string" ? record["source"].slice(0, 40) : "unknown",
    reason: typeof record["reason"] === "string" ? record["reason"].slice(0, MAX_REASON) : "",
    ...(overrideRecord && isImportanceLevel(overrideRecord["level"])
      ? { override: { level: overrideRecord["level"], expires_at: typeof overrideRecord["expires_at"] === "string" ? overrideRecord["expires_at"] : null } }
      : {}),
  };
}

export type ImportanceSetResult = { ok: true } | { ok: false; status: number; code: string; message: string };

export interface SessionImportanceDeps {
  endpoint: MemoryEndpoint | null;
  /** whether a browser watches: nothing is asked while none does */
  active: () => boolean;
  /** some pane's importance changed */
  onChange: () => void;
  fetch?: typeof fetch;
  now?: () => number;
  pollMs?: number;
  log?: (line: string) => void;
}

export class SessionImportance {
  private readonly levels = new Map<string, PaneImportance>();
  private readonly paneSessions = new Map<string, string>();
  private wanted: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private lastPoll = -Infinity;
  private retryAt = 0;
  private failures = 0;
  /** why memory is not answering, said once when it stops and once when it is back */
  private down: string | null = null;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly pollMs: number;

  constructor(private readonly deps: SessionImportanceDeps) {
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetch ?? fetch;
    this.pollMs = deps.pollMs ?? POLL_MS;
  }

  get enabled(): boolean { return this.deps.endpoint !== null; }

  start(): void {
    if (this.timer !== null || !this.enabled) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The panes of the latest snapshot: their sessions are the ones asked about. A stale cache is asked again now. */
  refresh(panes: readonly HerdrPane[]): void {
    if (!this.enabled) return;
    this.paneSessions.clear();
    const ids = new Set<string>();
    for (const pane of panes) {
      const id = paneSessionId(pane);
      if (id === null) continue;
      this.paneSessions.set(pane.pane_id, id);
      if (ids.size < MAX_SESSIONS) ids.add(id);
    }
    this.wanted = [...ids].sort();
    if (this.now() - this.lastPoll >= this.pollMs) void this.poll();
  }

  /** The pane's importance as memory last said it; undefined for neutral. */
  of(pane: Pick<HerdrPane, "agent_session">): PaneImportance | undefined {
    const id = paneSessionId(pane);
    return id === null ? undefined : this.levels.get(id);
  }

  sessionOf(paneId: string): string | null {
    return this.paneSessions.get(paneId) ?? null;
  }

  /** One ask of memory; a second call while one runs waits for it. `force` skips the backoff (a set just landed). */
  poll(force = false): Promise<void> {
    if (this.polling) return this.polling;
    if (!this.enabled || this.wanted.length === 0) return Promise.resolve();
    if (!force && (!this.deps.active() || this.now() < this.retryAt)) return Promise.resolve();
    this.lastPoll = this.now();
    this.polling = this.ask([...this.wanted]).finally(() => { this.polling = null; });
    return this.polling;
  }

  private async ask(ids: string[]): Promise<void> {
    const answer = await this.call("session_importance", { session_ids: ids });
    if (!answer.ok) {
      this.fail(answer.missing ? MISSING_TOOL_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** this.failures), answer.why);
      this.replace(new Map());
      return;
    }
    const sessions = typeof answer.value === "object" && answer.value !== null ? (answer.value as Record<string, unknown>)["sessions"] : undefined;
    if (typeof sessions !== "object" || sessions === null) {
      this.fail(Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** this.failures), "memory's answer has no sessions");
      this.replace(new Map());
      return;
    }
    const next = new Map<string, PaneImportance>();
    for (const id of ids) {
      const importance = readImportance((sessions as Record<string, unknown>)[id]);
      if (importance) next.set(id, importance);
    }
    if (this.down !== null) this.deps.log?.("importance: opencode-memory answers again");
    this.down = null; this.failures = 0; this.retryAt = 0;
    this.replace(next);
  }

  private fail(backoffMs: number, why: string): void {
    this.failures = Math.min(this.failures + 1, 10);
    this.retryAt = this.now() + backoffMs;
    if (this.down !== why) this.deps.log?.(`importance: every agent is neutral (P2) while opencode-memory does not answer: ${why}`);
    this.down = why;
  }

  private replace(next: Map<string, PaneImportance>): void {
    const before = JSON.stringify([...this.levels].sort(([a], [b]) => a < b ? -1 : 1));
    const after = JSON.stringify([...next].sort(([a], [b]) => a < b ? -1 : 1));
    if (before === after) return;
    this.levels.clear();
    for (const [id, importance] of next) this.levels.set(id, importance);
    this.deps.onChange();
  }

  /** Sets (or with null clears) the pane's session's level by hand, then asks memory again. */
  async set(paneId: string, level: ImportanceLevel | null, ttlHours?: number): Promise<ImportanceSetResult> {
    if (!this.enabled) return { ok: false, status: 503, code: "importance_off", message: "Importance is off on this server (OVIS_MEMORY_URL)" };
    const sessionId = this.sessionOf(paneId);
    if (sessionId === null) return { ok: false, status: 404, code: "no_session", message: "This agent has no OpenCode session id, so it has no importance to set" };
    const answer = await this.call("session_importance_set", { session_id: sessionId, level, ...(ttlHours === undefined ? {} : { ttl_hours: ttlHours }) });
    if (!answer.ok) return { ok: false, status: 502, code: answer.missing ? "memory_unsupported" : "memory_refused", message: answer.missing ? "opencode-memory does not offer session_importance_set yet" : `opencode-memory refused: ${answer.why}` };
    const value = answer.value;
    if (typeof value === "object" && value !== null && "error" in value) {
      const error = (value as Record<string, unknown>)["error"];
      return { ok: false, status: 502, code: "memory_refused", message: `opencode-memory refused: ${typeof error === "string" ? error.slice(0, MAX_REASON) : "error"}` };
    }
    this.retryAt = 0;
    // an ask already on its way may have left before the set: ask once more after it
    await this.polling?.catch(() => undefined);
    await this.poll(true).catch(() => undefined);
    return { ok: true };
  }

  private async call(tool: string, body: unknown): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean; why: string }> {
    const endpoint = this.deps.endpoint!;
    const key = endpoint.key();
    let response: Response;
    try {
      response = await this.fetcher(`${endpoint.url}/tools/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, missing: false, why: error instanceof Error && error.name === "TimeoutError" ? "no answer in time" : "not reachable" };
    }
    let parsed: unknown = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    if (!response.ok) {
      const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
      const missing = response.status === 404 && (record["error"] === "Unknown tool" || parsed === null);
      const message = typeof record["message"] === "string" ? record["message"].slice(0, MAX_REASON) : typeof record["error"] === "string" ? record["error"] : "";
      return { ok: false, missing, why: `HTTP ${response.status}${message ? ` (${message})` : ""}` };
    }
    const value = unwrapToolResult(parsed);
    if (typeof value === "object" && value !== null && /unknown action|unknown tool/i.test(String((value as Record<string, unknown>)["error"] ?? ""))) {
      return { ok: false, missing: true, why: String((value as Record<string, unknown>)["error"]).slice(0, MAX_REASON) };
    }
    return { ok: true, value };
  }
}

interface Clock { key: string; since: number; status: AgentStatus }

/**
 * When this server first saw each pane in its state: a pane's clock starts again when its status
 * or herdr's state_change_seq for it changes. Kept in `wait-clocks.json` beside the shared
 * preferences (written a moment after a change), so a restart keeps every wait.
 */
export class WaitClocks {
  private readonly clocks = new Map<string, Clock>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string | null, private readonly now: () => number = Date.now, private readonly saveDelayMs = 2_000) {
    if (path === null) return;
    try {
      const document = readStateDocument(path);
      if (document.kind !== "json" || typeof document.value !== "object" || document.value === null) return;
      const panes = (document.value as Record<string, unknown>)["panes"];
      if (typeof panes !== "object" || panes === null) return;
      for (const [paneId, raw] of Object.entries(panes)) {
        if (typeof raw !== "object" || raw === null) continue;
        const { key, since, status } = raw as Record<string, unknown>;
        if (typeof key === "string" && typeof since === "number" && Number.isFinite(since) && typeof status === "string") this.clocks.set(paneId, { key, since, status: status as AgentStatus });
      }
    } catch { /* an unreadable file starts every clock afresh */ }
  }

  /** Each pane's wait, stamped now for a pane seen in this state for the first time. Panes no longer there are forgotten. */
  stamp(panes: readonly Pick<HerdrPane, "pane_id" | "agent_status">[], seqOf: (paneId: string) => number | undefined): Map<string, PaneWait> {
    const waits = new Map<string, PaneWait>();
    let changed = false;
    const now = this.now();
    for (const pane of panes) {
      const status = pane.agent_status;
      if (status === undefined || status === null) continue;
      const key = `${seqOf(pane.pane_id) ?? ""}|${status}`;
      let clock = this.clocks.get(pane.pane_id);
      if (clock?.key !== key) {
        clock = { key, since: now, status };
        this.clocks.set(pane.pane_id, clock);
        changed = true;
      }
      waits.set(pane.pane_id, { since: clock.since, status: clock.status });
    }
    // an empty read (herdr restarting) is not every pane closing
    if (panes.length > 0) {
      const open = new Set(panes.map((pane) => pane.pane_id));
      for (const paneId of [...this.clocks.keys()]) if (!open.has(paneId)) { this.clocks.delete(paneId); changed = true; }
    }
    if (changed) this.scheduleSave();
    return waits;
  }

  forget(paneId: string): void {
    if (this.clocks.delete(paneId)) this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.path === null || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  /** Writes the clocks now (a pending save included). */
  save(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.path === null) return;
    try { writeStateDocument(this.path, JSON.stringify({ version: 1, panes: Object.fromEntries(this.clocks) }), false); }
    catch (error) { console.error(`importance: the wait clocks were not saved (${error instanceof Error ? error.message : String(error)})`); }
  }
}
