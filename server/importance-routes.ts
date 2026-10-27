/** POST /api/agent/importance: sets the pane's OpenCode session's importance by hand at opencode-memory (server/session-importance.ts). */
import { isImportanceLevel, type AgentImportanceRequest } from "../shared/protocol.ts";
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import type { SessionImportance } from "./session-importance.ts";

export const IMPORTANCE_PATH = "/api/agent/importance";
const MAX_TTL_HOURS = 24 * 30;

export async function handleImportanceRequest(request: Request, pathname: string, importance: SessionImportance): Promise<Response | null> {
  if (pathname !== IMPORTANCE_PATH) return null;
  setRequestRoute(pathname);
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  const payload = await readJsonObject<Partial<Record<keyof AgentImportanceRequest, unknown>>>(request);
  if (payload instanceof Response) return payload;
  if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
  if (payload.level !== null && !isImportanceLevel(payload.level)) return badRequest("invalid_level", "level must be P0, P1, P2 or P3, or null for Auto");
  const ttl = payload.ttl_hours;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_HOURS)) return badRequest("invalid_ttl", `ttl_hours must be a number of hours up to ${MAX_TTL_HOURS}`);
  const result = await importance.set(payload.pane_id, payload.level, ttl);
  if (!result.ok) return jsonResponse({ error: { code: result.code, message: result.message } }, result.status);
  return jsonResponse({ ok: true });
}
