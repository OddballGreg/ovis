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
 * default store. A source with no CLAUDE_CONFIG_DIR exported is bound only where herdr's own
 * environment, which a new tab inherits, proves none either (claude-store.ts herdrLaunchSource).
 */
import type { SessionHistoryResponse, SessionResumeResponse, SessionSnapshot } from "../shared/protocol.ts";
import { claudeStoreOf, herdrLaunchSource, paneClaudeSource, type ClaudeSource, type PaneProcess } from "./claude-store.ts";
import { agentLaunch } from "./agent-launch.ts";
import { herdrSocketPath, paneProcessInfo, sessionSnapshot, tabCreate } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject } from "./http.ts";
import { isSessionHistoryAgent, listSessions, type SessionHistoryOptions } from "./session-history.ts";

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

/** The Claude store of a pane (claude-store.ts claudeStoreOf); null when it cannot be told. */
async function paneStore(paneId: string, options: StoreOptions): Promise<{ store: NonNullable<Awaited<ReturnType<typeof claudeStoreOf>>> } | null> {
  let processes: PaneProcesses | undefined;
  try { processes = await (options.paneProcesses ?? herdrPaneProcesses)(paneId); } catch { return null; }
  // only processes herdr reported say there is no Claude: an answer without them is no answer
  const foreground = processes?.foreground_processes;
  if (processes === undefined || !Array.isArray(foreground) || foreground.length === 0) return null;
  const home = options.stores?.home ?? process.env["HOME"] ?? "";
  const store = await claudeStoreOf(await paneClaudeSource(foreground, home), home, options.stores?.env ?? process.env);
  return store === null ? null : { store };
}

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
  // the pane is checked before any store is read: a pane of another workspace lists nothing
  if (paneId !== null && !snapshot.panes.some((pane) => pane.pane_id === paneId && pane.workspace_id === workspaceId)) {
    return badRequest("pane_not_in_workspace", "pane_id must name a pane of the workspace");
  }
  const cwd = workspaceFolder(snapshot, workspaceId);
  if (cwd === null) return jsonResponse({ error: { code: "no_folder", message: "the workspace has no folder to list sessions for" } }, 409);
  let sessions;
  if (agent === "claude" && paneId !== null) {
    const found = await paneStore(paneId, options);
    if (found === null) return storeUnknown();
    const { store } = found;
    // a store whose choice cannot be repeated in a new tab is listed without a source: its Resume is withheld
    const repeatable = store.env === "unsupported" ? false : store.env !== null || await launchKeepsAbsence(options);
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
 * is created for either. A pane of the workspace that reports the session and is on the same store
 * is answered `opened` (the client selects it; herdr's focus is not moved). Otherwise a new tab gets
 * the session's `claude --resume`, with only the CLAUDE_CONFIG_DIR the source had exported in its
 * environment. A source with none exported is started with none, and only where herdr's own
 * environment proves it hands none down (herdrLaunchSource); a source whose choice cannot be
 * repeated (that, or a Windows ~/.claude, where an override cannot be told from none) is 409
 * launch_unsupported before any tab is made.
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
    if (showing?.store.key === store.key) return jsonResponse({ action: "opened", workspace_id: workspaceId, pane_id: pane.pane_id } satisfies SessionResumeResponse);
  }
  if (store.env === "unsupported") return refuse(409, "launch_unsupported", "this Claude's store cannot be chosen again for a new tab");
  // none exported: herdr's own environment, which the new tab inherits, must hand none down
  if (store.env === null && !await launchKeepsAbsence(options)) return refuse(409, "launch_unsupported", "a new tab here would not start Claude in the same store");
  options.extendTimeout?.();
  try {
    const created = await tabCreate({ workspaceId, cwd, ...(store.env === null ? {} : { env: store.env }) });
    const launched = await agentLaunch(created.root_pane.pane_id, { kind: "claude", args: ["--resume", sessionId] });
    return jsonResponse({ action: "created", workspace_id: created.tab.workspace_id, pane_id: created.root_pane.pane_id, ...launched } satisfies SessionResumeResponse);
  } catch (error) {
    return errorResponse(error);
  }
}
