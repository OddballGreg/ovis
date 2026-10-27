import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

describe("POST /api/agent/importance", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  let stateDir: string;
  let off: ReturnType<typeof createServer>;
  let on: ReturnType<typeof createServer>;
  const asked: string[] = [];
  const post = (server: ReturnType<typeof createServer>, body: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${server.port}/api/agent/importance`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-importance-route-"));
    off = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
    // a memory that is never reached: no pane of this server has a session, so nothing is asked
    on = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(stateDir, "on"), token: "", machines: false, sidecar: false,
      importance: { endpoint: { url: "http://127.0.0.1:9", key: () => null }, fetch: (async (input: string | URL | Request) => { asked.push(String(input)); return new Response("{}"); }) as typeof fetch } });
    servers.push(off, on);
  });
  afterAll(() => {
    for (const server of servers) server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("checks the body before anything reaches memory", async () => {
    expect((await post(on, {}, "GET")).status).toBe(400);
    expect(await (await post(on, { level: "P1" })).json()).toEqual({ error: { code: "missing_pane_id", message: "pane_id is required" } });
    expect((await (await post(on, { pane_id: "p1", level: "P7" })).json() as { error: { code: string } }).error.code).toBe("invalid_level");
    expect((await (await post(on, { pane_id: "p1", level: "P1", ttl_hours: -1 })).json() as { error: { code: string } }).error.code).toBe("invalid_ttl");
    expect(asked).toEqual([]);
  });

  it("says a pane without an OpenCode session has no importance, and a server without memory that it is off", async () => {
    const none = await post(on, { pane_id: "p-unknown", level: "P0" });
    expect(none.status).toBe(404);
    expect((await none.json() as { error: { code: string } }).error.code).toBe("no_session");
    const disabled = await post(off, { pane_id: "p1", level: null });
    expect(disabled.status).toBe(503);
    expect((await disabled.json() as { error: { code: string } }).error.code).toBe("importance_off");
    expect(asked).toEqual([]);
  });
});
