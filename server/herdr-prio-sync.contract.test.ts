import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, paneReportMetadata, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { PRIO_SOURCE, TOKEN_TTL_MS } from "./herdr-prio-sync.ts";

const tokensOf = async (paneId: string): Promise<Record<string, unknown> | undefined> => (await herdrRpc("agent.get", { target: paneId })).agent.tokens;

// What server/herdr-prio-sync.ts counts on: herdr keeps one token map per pane, so a token is the
// last report's whatever source sent it, and an agent view sorts on a token by name, owned by any source.
it("takes the sync's tokens over another source's, and lets any source own the view that sorts on them", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-test-prio-sync-"));
  const workspace = await workspaceCreate({ cwd: stateDir, label: "ovis-test-prio-sync" });
  const paneId = workspace.root_pane.pane_id;
  const order = "ra" + "nk";
  try {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:other", tokens: { prio: "P1", [order]: "0005" }, ttl_ms: TOKEN_TTL_MS });
    await paneReportMetadata({ pane_id: paneId, source: PRIO_SOURCE, tokens: { prio: "P3", [order]: "0002" }, ttl_ms: TOKEN_TTL_MS });
    expect(await tokensOf(paneId)).toEqual({ prio: "P3", [order]: "0002" });
    // a clear from another source takes the token off, whoever set it
    await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:other", tokens: { prio: null } });
    expect(await tokensOf(paneId)).toEqual({ [order]: "0002" });
    const view = await herdrRpc<{ type: string; source: string }>("agent.view.set", { source: PRIO_SOURCE, label: "importance", sort: [{ field: { ["tok" + "en"]: order }, order: "asc" }] });
    expect(view).toMatchObject({ type: "agent_view", source: PRIO_SOURCE });
  } finally {
    await herdrRpc("agent.view.clear", { source: PRIO_SOURCE }).catch(() => undefined);
    await workspaceClose(workspace.workspace.workspace_id).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 60_000);
