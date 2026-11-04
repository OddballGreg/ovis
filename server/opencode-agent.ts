/**
 * The agent of an OpenCode 1.x pane (Build, Plan or a custom primary one), shown and switched from
 * the browser.
 *
 * As with the model (opencode-model.ts), OpenCode 1.x keeps the agent a TUI uses in the TUI itself,
 * and the TUI draws it first in its prompt footer: `<agent> · <model name> <provider name>`. Nothing
 * over HTTP sets it for a pane's TUI, so it is switched the way a person does: Tab (the TUI's
 * `agent_cycle` key) moves to the next primary agent, and the footer is read back after each press
 * until it names the agent asked for. Tab keeps the draft, but with the prompt's autocomplete open
 * it accepts the row under the cursor instead, so nothing is sent while a dialog or the autocomplete
 * is drawn. The presses are capped at the number of primary agents OpenCode lists (GET /agent on the
 * HTTP source, when it answers), else at OPENCODE_AGENT_MAX_TABS, and stop early once the footer is
 * back on the agent it started from (every agent Tab reaches has been seen) or OPENCODE_AGENT_DRIVE_MS
 * has gone: either means the agent asked for is not one Tab reaches.
 */
import type { OpencodeAgentFailure } from "../shared/protocol.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { anyDialog, OPENCODE_MODEL_MAX_NAME, paneDeps, promptBox, typeableName, type DriveDeps } from "./opencode-model.ts";
import { opencodeV1Configured, opencodeV1Endpoint, opencodeV1Get } from "./opencode-v1.ts";
import { resolveAgent } from "./pane-context.ts";

/** Tab presses before the agent asked for is given up on, when OpenCode's agent list cannot be read. */
export const OPENCODE_AGENT_MAX_TABS = 4;
/** The footer shows the next agent within this of a Tab. */
const STEP_MS = 1_500;
/** The whole switch, from the first key to the footer read back. */
export const OPENCODE_AGENT_DRIVE_MS = 8_000;
const POLL_MS = 50;
const IO_MS = 2_000;
const IO_MIN_MS = 100;

export type AgentDriveResult =
  | { ok: true; agent: string }
  | { ok: false; code: OpencodeAgentFailure; message: string; agent?: string };

const MESSAGES: Readonly<Record<OpencodeAgentFailure, string>> = {
  not_opencode: "the pane does not run OpenCode",
  busy: "OpenCode is working or waiting for an answer; switch the agent once it is idle",
  read_only: "this connection can only watch",
  dialog_open: "a dialog is open in OpenCode",
  popup_open: "OpenCode's autocomplete is open over the prompt; Tab would accept its row",
  not_ready: "OpenCode's prompt is not on the screen",
  aborted: "the request was given up before its turn",
  pane_error: "the pane could not be read or written",
  agent_not_found: "Tab did not reach that agent in OpenCode",
  not_confirmed: "OpenCode's prompt did not show another agent after Tab",
};

/** The agent's first word, in any case: `Build auto` is Build. */
const agentKey = (agent: string): string => agent.trim().split(/\s+/u)[0]!.toLowerCase();

/** Whether the footer's agent is the one asked for. */
export const agentNamed = (shown: string, target: string): boolean => agentKey(shown) === agentKey(target);

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, OPENCODE_MODEL_MAX_NAME);

/**
 * Moves the TUI to `target` with Tab, reading the footer back after each press, at most `maxTabs`
 * presses; with no target, one press. Refuses before any key when a dialog or the autocomplete is
 * open, the prompt's footer names no agent, or `signal` was aborted. A target already shown sends
 * nothing.
 */
export async function cycleAgent(deps: DriveDeps, target: string | undefined, maxTabs: number, budgetMs = OPENCODE_AGENT_DRIVE_MS, signal?: AbortSignal): Promise<AgentDriveResult> {
  const deadline = deps.now() + budgetMs;
  const io = (): number => Math.max(IO_MIN_MS, Math.min(IO_MS, deadline - deps.now()));
  const refuse = (code: OpencodeAgentFailure, detail?: string, agent?: string): AgentDriveResult => ({
    ok: false, code, message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code], ...(agent === undefined ? {} : { agent }),
  });
  /** what the screen says now: a reason not to press Tab, or the agent the footer names */
  const look = (screen: string): { stop: OpencodeAgentFailure } | { agent: string } => {
    if (anyDialog(screen)) return { stop: "dialog_open" };
    const box = promptBox(screen);
    if (box === null || box.agent === null) return { stop: "not_ready" };
    if (box.popup) return { stop: "popup_open" };
    return { agent: box.agent };
  };
  let screen: string;
  try { screen = await deps.read(io()); } catch (error) { return refuse("pane_error", reason(error)); }
  const first = look(screen);
  if ("stop" in first) return refuse(first.stop);
  if (signal?.aborted) return refuse("aborted");
  if (target !== undefined && agentNamed(first.agent, target)) return { ok: true, agent: first.agent };

  let shown = first.agent;
  for (let tabs = 0; tabs < Math.max(1, maxTabs); tabs++) {
    try { await deps.keys(["tab"], io()); } catch (error) { return refuse("pane_error", reason(error), shown); }
    const end = Math.min(deadline, deps.now() + STEP_MS);
    let next: string | null = null;
    for (;;) {
      let now: { stop: OpencodeAgentFailure } | { agent: string };
      try { now = look(await deps.read(io())); } catch (error) { return refuse("pane_error", reason(error), shown); }
      // a dialog or the autocomplete drawn after a Tab is not pressed into again: its row would be taken
      if ("stop" in now && now.stop !== "not_ready") return refuse(now.stop, "it opened while the agent was switched", shown);
      if ("agent" in now && now.agent !== shown) { next = now.agent; break; }
      if (deps.now() >= end) break;
      await deps.sleep(POLL_MS);
    }
    if (next === null) return refuse("not_confirmed", `its footer shows ${JSON.stringify(shown)}`, shown);
    shown = next;
    if (target === undefined || agentNamed(shown, target)) return { ok: true, agent: shown };
    // back where it started: every agent Tab reaches has been seen, and the pane is left as it was
    if (shown === first.agent) break;
    if (deps.now() >= deadline) break;
  }
  return refuse("agent_not_found", `${JSON.stringify(target)}; its footer shows ${JSON.stringify(shown)}`, shown);
}

/* -------------------------------------------------------------------------------------------------
 * How many agents Tab walks through
 * ----------------------------------------------------------------------------------------------- */

/** The primary agents of a GET /agent answer: those not only a subagent, and not hidden; null when it is not that answer. */
export function primaryAgentCount(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const count = value.filter((agent) => {
    if (agent === null || typeof agent !== "object") return false;
    const { mode, hidden } = agent as { mode?: unknown; hidden?: unknown };
    return mode !== "subagent" && hidden !== true;
  }).length;
  return count > 0 ? count : null;
}

const AGENTS_MS = 60_000;
const cache = new Map<string, { at: number; count: number }>();

/** Tests answer the agent list themselves. */
export const opencodeAgentOptions: { count?: (directory: string) => Promise<number | null> } = {};

/** Forget the agent lists read (tests). */
export function forgetOpencodeAgents(): void {
  cache.clear();
}

/** How many primary agents OpenCode lists for a folder, read at most once a minute; null when the HTTP source cannot say. */
async function primaryAgents(directory: string): Promise<number | null> {
  if (opencodeAgentOptions.count) return opencodeAgentOptions.count(directory);
  if (!opencodeV1Configured()) return null;
  const hit = cache.get(directory);
  if (hit && Date.now() - hit.at < AGENTS_MS) return hit.count;
  const endpoint = await opencodeV1Endpoint().catch(() => null);
  if (endpoint === null) return null;
  const answer = await opencodeV1Get(endpoint, `/agent${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`, 1024 * 1024, 2_000);
  if (answer?.status !== 200) return null;
  let count: number | null = null;
  try { count = primaryAgentCount(JSON.parse(answer.body)); } catch { count = null; }
  if (count !== null) cache.set(directory, { at: Date.now(), count });
  return count;
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ----------------------------------------------------------------------------------------------- */

const STATUS: Readonly<Record<OpencodeAgentFailure, number>> = {
  read_only: 403,
  not_opencode: 409, busy: 409, dialog_open: 409, popup_open: 409, not_ready: 409, aborted: 409,
  pane_error: 502, agent_not_found: 502, not_confirmed: 502,
};

const failure = (code: OpencodeAgentFailure, message = MESSAGES[code], agent?: string): Response =>
  jsonResponse({ error: { code, message, ...(agent === undefined ? {} : { agent }) } }, STATUS[code]);

export interface OpencodeAgentRouteOptions {
  /** runs the switch in the pane's turn, after a message in flight (core's serialize) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** the drive's deps for a pane (tests) */
  deps?: (paneId: string) => DriveDeps;
  /** a device that can only watch: nothing is sent for it */
  readOnly?: boolean;
}

/** An agent's name as asked for: a short word or two, nothing that is a key. */
const AGENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u;

/** The answer for POST /api/pane/opencode-agent, or null when the path is not it. */
export async function handleOpencodeAgentRequest(request: Request, pathname: string, options: OpencodeAgentRouteOptions = {}): Promise<Response | null> {
  if (pathname !== "/api/pane/opencode-agent") return null;
  setRequestRoute(pathname);
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  if (options.readOnly) return failure("read_only");
  const payload = await readJsonObject<{ pane_id?: unknown; agent?: unknown }>(request);
  if (payload instanceof Response) return payload;
  if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
  if (payload.agent !== undefined && (typeof payload.agent !== "string" || !typeableName(payload.agent) || !AGENT_NAME.test(payload.agent))) {
    return badRequest("invalid_agent", "agent must be an agent's name");
  }
  const paneId = payload.pane_id;
  const target = payload.agent as string | undefined;
  const serialize = options.serialize ?? (<T>(_pane: string, task: () => Promise<T>) => task());
  try {
    return await serialize(paneId, async () => {
      if (request.signal.aborted) return failure("aborted");
      const pane = await paneGet(paneId);
      if (resolveAgent(pane).agent !== "opencode") return failure("not_opencode");
      if (pane.agent_status === "working" || pane.agent_status === "blocked") return failure("busy");
      const cwd = typeof pane.foreground_cwd === "string" ? pane.foreground_cwd : typeof pane.cwd === "string" ? pane.cwd : "";
      const maxTabs = target === undefined ? 1 : await primaryAgents(cwd).catch(() => null) ?? OPENCODE_AGENT_MAX_TABS;
      const result = await cycleAgent((options.deps ?? paneDeps)(paneId), target, maxTabs, OPENCODE_AGENT_DRIVE_MS, request.signal);
      if (!result.ok) {
        console.warn(`OpenCode agent switch for ${paneId} failed or was refused: ${result.code}: ${result.message}`);
        return failure(result.code, result.message, result.agent);
      }
      return jsonResponse({ ok: true, agent: result.agent });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
