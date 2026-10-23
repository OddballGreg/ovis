/**
 * GET /api/sessions/history?workspace_id=&agent=&pane_id=: the earlier sessions of one agent in a
 * workspace's folder (session-history.ts). A row's first message is prompt text, so a device
 * that may only watch is refused here as well as by the access gate in index.ts, and nothing
 * the listing returns is logged.
 *
 * Claude keeps one store per CLAUDE_CONFIG_DIR, and two stores can hold the same session id. A
 * Claude listing asked for from a pane (`pane_id`) lists the store of that pane's Claude, found as
 * the live chat finds it (claude-store.ts paneClaudeSource), and binds each row's Resume to that
 * pane and store: POST /api/sessions/resume finds the store again, refuses one that changed, and
 * starts the session in it. A pane herdr reports processes for and no Claude among them has the
 * server's default store; one whose processes or store cannot be told gets an error, never the
 * default store. On Windows herdr names only the pane's shell, so its Claude is looked for under
 * `shell_pid` in the process table. A source with no CLAUDE_CONFIG_DIR exported is bound only where
 * the environment a new tab inherits exports none either (claude-store.ts herdrLaunchSource).
 */
import type { SessionHistoryResponse, SessionResumeResponse, SessionSnapshot } from "../shared/protocol.ts";
import { claudeProcessSession, claudeStoreOf, herdrLaunchSource, isClaudeProcess, paneClaudeSource, type ClaudeSource, type PaneProcess } from "./claude-store.ts";
import { agentLaunch } from "./agent-launch.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import { herdrSocketPath, paneProcessInfo, sessionSnapshot, tabClose, tabCreate } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject } from "./http.ts";
import { isSessionHistoryAgent, listSessions, type SessionHistoryOptions } from "./session-history.ts";
import { descendantProcesses, type ProcessRow } from "./windows-processes.ts";

export const SESSION_HISTORY_PATH = "/api/sessions/history";
export const SESSION_RESUME_PATH = "/api/sessions/resume";

type Snapshot = Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">;
/** A pane's processes as herdr's `pane.process_info` reports them. */
export interface PaneProcesses { shell_pid?: number | null; foreground_processes?: PaneProcess[] }

interface StoreOptions {
  stores?: SessionHistoryOptions;
  snapshot?: () => Promise<Snapshot>;
  /** herdr's `pane.process_info` for a pane (tests hand in their own processes) */
  paneProcesses?: (paneId: string) => Promise<PaneProcesses | undefined>;
  /** the store source a new herdr tab inherits (tests hand in their own) */
  launchSource?: () => Promise<ClaudeSource>;
  /** the platform and Windows process table a pane's Claude is looked for in (tests hand in their own) */
  platform?: string;
  table?: () => Promise<ProcessRow[]>;
  /** the tab a resume makes, its Claude's start, and the tab's close (tests hand in their own) */
  tabs?: { create: typeof tabCreate; start: typeof agentLaunch; close: typeof tabClose };
  /** how long a resumed Claude is waited for to say its store (tests shorten it) */
  launchCheckMs?: number;
}

const CLAUDE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_KEY = /^[0-9a-f]{24}$/;
const refuse = (status: number, code: string, message: string) => jsonResponse({ error: { code, message } }, status);
const storeUnknown = () => refuse(409, "claude_store_unknown", "which Claude store this pane uses cannot be told");

const herdrPaneProcesses = (paneId: string): Promise<PaneProcesses | undefined> => paneProcessInfo(paneId);

/** Whether a source with none exported would be started with none exported in a new tab. */
const launchKeepsAbsence = async (options: StoreOptions): Promise<boolean> =>
  (await (options.launchSource ?? (() => herdrLaunchSource(herdrSocketPath())))()).state === "absent";

/**
 * A workspace's folder: its worktree checkout when herdr names one, else the folder of its
 * first tab's first pane, where herdr opens a new tab.
 */
export function workspaceFolder(snapshot: Snapshot, workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === workspaceId);
  if (!workspace) return null;
  if (workspace.worktree?.checkout_path) return workspace.worktree.checkout_path;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspaceId).sort((a, b) => a.number - b.number);
  for (const tab of tabs) {
    const pane = snapshot.panes.find((entry) => entry.tab_id === tab.tab_id && typeof entry.cwd === "string" && entry.cwd !== "");
    if (pane?.cwd) return pane.cwd;
  }
  return null;
}

const isClaude = (entry: PaneProcess) => isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined });

/**
 * The Claude processes under a Windows pane's shell, from the process table: the nearest one, and
 * any other not started by it (two of them: which one a session belongs to cannot be told). Null
 * when the table says nothing, which is no proof that no Claude runs there.
 */
async function windowsPaneClaude(shellPid: number, table: () => Promise<ProcessRow[]>): Promise<PaneProcess[] | null> {
  const rows = await table();
  if (rows.length === 0) return null;
  const claude = descendantProcesses(rows, shellPid).filter(isClaude);
  const first = claude[0];
  if (first === undefined) return [];
  const below = new Set(descendantProcesses(rows, first.pid).map((entry) => entry.pid));
  return claude.filter((entry) => entry === first || !below.has(entry.pid));
}

/**
 * The Claude store of a pane (claude-store.ts claudeStoreOf), whether a Claude was found there (no
 * Claude: the server's default store) and its pid; null when it cannot be told.
 */
async function paneStore(paneId: string, options: StoreOptions): Promise<{ store: NonNullable<Awaited<ReturnType<typeof claudeStoreOf>>>; claude: boolean; pid: number | null } | null> {
  let processes: PaneProcesses | undefined;
  try { processes = await (options.paneProcesses ?? herdrPaneProcesses)(paneId); } catch { return null; }
  // only processes herdr reported say there is no Claude: an answer without them is no answer
  let foreground = processes?.foreground_processes;
  if (processes === undefined || !Array.isArray(foreground) || foreground.length === 0) return null;
  const platform = options.platform ?? process.platform;
  const table = options.table ?? recentProcessTable;
  if (platform === "win32" && !foreground.some(isClaude)) {
    // herdr names only the shell on Windows, even while Claude runs in it
    if (typeof processes.shell_pid !== "number") return null;
    let below: PaneProcess[] | null;
    try { below = await windowsPaneClaude(processes.shell_pid, table); } catch { return null; }
    if (below === null) return null;
    foreground = below;
  }
  const home = options.stores?.home ?? process.env["HOME"] ?? "";
  const source = await paneClaudeSource(foreground, home, platform, table);
  const store = await claudeStoreOf(source, home, options.stores?.env ?? process.env);
  const claude = foreground.filter(isClaude);
  return store === null ? null : { store, claude: source !== null, pid: claude.length === 1 ? claude[0]!.pid : null };
}

/**
 * The store the Claude a resume started in `paneId` came up on, once it says one, and whether it
 * writes `listedDir`; null when it says no store within `launchCheckMs`. Only Linux reads a
 * process's environment exactly: elsewhere the store it came up on is read from `ps` text (macOS)
 * or found by its PID record (Windows), so Claude's own live PID record must also be in the listed
 * store's folder, a proof that does not depend on that reading. Claude writes the record as it
 * starts, so it is waited for too.
 */
async function startedStore(paneId: string, listedDir: string, options: StoreOptions): Promise<{ store: NonNullable<Awaited<ReturnType<typeof paneStore>>>["store"]; writesListed: boolean } | null> {
  const deadline = Date.now() + (options.launchCheckMs ?? 15_000);
  const platform = options.platform ?? process.platform;
  const home = options.stores?.home ?? process.env["HOME"] ?? "";
  let landed: Awaited<ReturnType<typeof paneStore>> = null;
  for (;;) {
    const found = await paneStore(paneId, options);
    if (found?.claude) {
      landed = found;
      if (platform === "linux") return { store: found.store, writesListed: true };
      if (found.pid !== null && await claudeProcessSession(home, found.pid, listedDir, platform, options.table ?? recentProcessTable) !== null) return { store: found.store, writesListed: true };
    }
    if (Date.now() >= deadline) return landed === null ? null : { store: landed.store, writesListed: false };
    await Bun.sleep(200);
  }
}

/**
 * Whether a started Claude came up on the listed store: the same key, or, where its store was found
 * by its Windows PID record (which cannot say how the store was chosen), the same folder.
 */
const sameStore = (landed: { key: string; place: string; chosen: boolean }, listed: { key: string; place: string }) =>
  landed.key === listed.key || (!landed.chosen && landed.place === listed.place);

/** The listing options with Claude's store set to `dir`. */
const inStore = (stores: SessionHistoryOptions | undefined, dir: string): SessionHistoryOptions => ({ ...stores, env: { ...(stores?.env ?? process.env), CLAUDE_CONFIG_DIR: dir } });

export async function handleSessionHistoryRequest(request: Request, url: URL, options: { readOnly: boolean } & StoreOptions): Promise<Response> {
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  if (options.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  const workspaceId = url.searchParams.get("workspace_id") ?? "";
  if (workspaceId === "") return badRequest("missing_workspace_id", "workspace_id is required");
  const agent = url.searchParams.get("agent") ?? "";
  if (!isSessionHistoryAgent(agent)) return badRequest("invalid_agent", "agent must name an agent whose sessions are listed");
  const paneId = url.searchParams.get("pane_id");
  if (paneId === "") return badRequest("invalid_pane_id", "pane_id must name a pane");
  let snapshot;
  try { snapshot = await (options.snapshot ?? sessionSnapshot)(); } catch (error) { return errorResponse(error); }
  if (!snapshot.workspaces.some((entry) => entry.workspace_id === workspaceId)) {
    return jsonResponse({ error: { code: "workspace_not_found", message: "no such workspace" } }, 404);
  }
  // the pane is checked before any store is read: a pane of another workspace lists nothing, and a
  // pane that is gone is a stale source, as the resume route answers it
  if (paneId !== null) {
    const pane = snapshot.panes.find((entry) => entry.pane_id === paneId);
    if (pane === undefined) return refuse(409, "stale_source", "the pane the list was asked for is gone: list the sessions again");
    if (pane.workspace_id !== workspaceId) return badRequest("pane_not_in_workspace", "pane_id must name a pane of the workspace");
  }
  const cwd = workspaceFolder(snapshot, workspaceId);
  if (cwd === null) return jsonResponse({ error: { code: "no_folder", message: "the workspace has no folder to list sessions for" } }, 409);
  let sessions;
  if (agent === "claude" && paneId !== null) {
    const found = await paneStore(paneId, options);
    if (found === null) return storeUnknown();
    const { store } = found;
    // a store whose choice cannot be repeated in a new tab is listed without a source: its Resume is withheld
    const repeatable = store.env !== null || await launchKeepsAbsence(options);
    const source = repeatable ? { pane_id: paneId, store_key: store.key } : null;
    sessions = listSessions("claude", cwd, inStore(options.stores, store.dir)).map((row) => row.resume === null || source === null ? row : { ...row, resume: { ...row.resume, source } });
  } else {
    sessions = listSessions(agent, cwd, options.stores);
  }
  const answer: SessionHistoryResponse = { workspace_id: workspaceId, agent, cwd, sessions };
  const response = jsonResponse(answer);
  response.headers.set("cache-control", "no-store");
  return response;
}

/** Whether a pane reports `id` as its Claude session: by id, or a transcript file named after it. */
function reportsSession(pane: Snapshot["panes"][number], id: string): boolean {
  const session = pane.agent_session;
  if (!session || session.agent !== "claude" || typeof session.value !== "string") return false;
  return session.kind === "id" ? session.value === id : session.kind === "path" && (session.value.split(/[/\\]/).pop() ?? "") === `${id}.jsonl`;
}

/**
 * POST /api/sessions/resume (SessionResumeRequest): one listed Claude session, started in the store
 * its row was listed from. The store is found again from the pane: a pane gone, moved or now on
 * another store is 409 stale_source, one that cannot be told 409 claude_store_unknown, and nothing
 * is created for either. A pane of the workspace that reports the session from the same store
 * folder (however that folder was chosen: both would write one transcript) is answered `opened`
 * (the client selects it; herdr's focus is not moved). Otherwise a new tab gets the session's
 * `claude --resume`, with only the CLAUDE_CONFIG_DIR the source had exported in its environment. A
 * source with none exported is started with none, and only where the environment a new tab
 * inherits exports none either (herdrLaunchSource); otherwise 409 launch_unsupported before any tab
 * is made. The tab's shell can still export the variable itself (a startup file): the started
 * Claude's store is read back, and one on another store has its tab closed and is 409
 * launch_store_changed; one that does not say its store in time is closed too, 409
 * launch_store_unknown.
 */
export async function handleSessionResumeRequest(request: Request, options: { readOnly: boolean; extendTimeout?: () => void } & StoreOptions): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  if (options.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  const body = await readJsonObject<{ workspace_id?: unknown; pane_id?: unknown; agent?: unknown; session_id?: unknown; store_key?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body.workspace_id !== "string" || body.workspace_id === "") return badRequest("missing_workspace_id", "workspace_id is required");
  if (typeof body.pane_id !== "string" || body.pane_id === "") return badRequest("invalid_pane_id", "pane_id must name the pane the list came from");
  if (body.agent !== "claude") return badRequest("invalid_agent", "only a Claude session is resumed here");
  if (typeof body.session_id !== "string" || !CLAUDE_SESSION.test(body.session_id)) return badRequest("invalid_session_id", "session_id must be a Claude session id");
  if (typeof body.store_key !== "string" || !STORE_KEY.test(body.store_key)) return badRequest("invalid_store_key", "store_key must be the key the list gave");
  const { workspace_id: workspaceId, pane_id: paneId, session_id: sessionId, store_key: storeKey } = body as { workspace_id: string; pane_id: string; session_id: string; store_key: string };
  let snapshot;
  try { snapshot = await (options.snapshot ?? sessionSnapshot)(); } catch (error) { return errorResponse(error); }
  if (!snapshot.workspaces.some((entry) => entry.workspace_id === workspaceId)) return refuse(404, "workspace_not_found", "no such workspace");
  const source = snapshot.panes.find((pane) => pane.pane_id === paneId);
  if (source === undefined) return refuse(409, "stale_source", "the pane the list came from is gone: list the sessions again");
  if (source.workspace_id !== workspaceId) return badRequest("pane_not_in_workspace", "pane_id must name a pane of the workspace");
  const cwd = workspaceFolder(snapshot, workspaceId);
  if (cwd === null) return refuse(409, "no_folder", "the workspace has no folder to list sessions for");
  const found = await paneStore(paneId, options);
  if (found === null) return storeUnknown();
  const { store } = found;
  if (store.key !== storeKey) return refuse(409, "stale_source", "the pane's Claude store changed since the list: list the sessions again");
  if (!listSessions("claude", cwd, inStore(options.stores, store.dir)).some((row) => row.id === sessionId && row.resume !== null)) {
    return refuse(404, "session_not_found", "no such session in this folder's store");
  }
  for (const pane of snapshot.panes) {
    if (pane.workspace_id !== workspaceId || !reportsSession(pane, sessionId)) continue;
    const showing = pane.pane_id === paneId ? found : await paneStore(pane.pane_id, options);
    if (showing?.store.place === store.place) return jsonResponse({ action: "opened", workspace_id: workspaceId, pane_id: pane.pane_id } satisfies SessionResumeResponse);
  }
  // none exported: the environment the new tab inherits must hand none down
  if (store.env === null && !await launchKeepsAbsence(options)) return refuse(409, "launch_unsupported", "a new tab here would not start Claude in the same store");
  options.extendTimeout?.();
  const tabs = options.tabs ?? { create: tabCreate, start: agentLaunch, close: tabClose };
  try {
    const created = await tabs.create({ workspaceId, cwd, ...(store.env === null ? {} : { env: store.env }) });
    const launched = await tabs.start(created.root_pane.pane_id, { kind: "claude", args: ["--resume", sessionId] });
    if (launched.agent_started) {
      const landed = await startedStore(created.root_pane.pane_id, store.dir, options);
      if (landed === null) {
        await tabs.close(created.tab.tab_id);
        return refuse(409, "launch_store_unknown", "the new tab's Claude did not say its store in time, so its tab was closed");
      }
      if (!landed.writesListed || !sameStore(landed.store, store)) {
        await tabs.close(created.tab.tab_id);
        return refuse(409, "launch_store_changed", "the new tab's shell chose another Claude store, so its tab was closed");
      }
    }
    return jsonResponse({ action: "created", workspace_id: created.tab.workspace_id, pane_id: created.root_pane.pane_id, ...launched } satisfies SessionResumeResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
