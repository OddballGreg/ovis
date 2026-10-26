import { afterEach, describe, expect, it } from "bun:test";
import { lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBridge, createHub, enabled, isTuiProcess, listen, OvisQuestionsPlugin, socketPathFor, validateAnswers, type BridgeClient, type BridgeRequest } from "./ovis-questions.js";

const asked = (id = "que_a1", sessionID = "ses_child1"): BridgeRequest & { tool?: unknown } => ({
  id, sessionID,
  questions: [
    { question: "Pick colors", header: "Colors", options: [{ label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" }], multiple: true, custom: true },
    { question: "Pick a size", header: "Size", options: [{ label: "Small", description: "" }, { label: "Medium", description: "" }], multiple: false, custom: false },
  ],
  tool: { messageID: "msg_1", callID: "call_1" },
});

/** OpenCode's question routes and session lookups as the 1.x SDK client reaches them. */
function fakeClient() {
  const calls: { url: string; path?: Record<string, string>; body?: unknown }[] = [];
  const state = { live: null as unknown[] | null, status: 200, parents: { ses_child1: "ses_root1" } as Record<string, string> };
  const client: BridgeClient = {
    _client: {
      get: async ({ url }) => {
        calls.push({ url });
        return state.live === null ? { error: "down", response: { status: 500 } } : { data: state.live, response: { status: 200 } };
      },
      post: async ({ url, path, body }) => {
        calls.push({ url, path, body });
        return state.status < 400 ? { data: true, response: { status: state.status } } : { error: {}, response: { status: state.status } };
      },
    },
    session: { get: async ({ path }) => ({ data: { ...(state.parents[path.id] ? { parentID: state.parents[path.id] } : {}) } }) },
  };
  return { client, calls, state };
}

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-questions-"));
  roots.push(root);
  return root;
}

/** One line out, one line back, over the real socket. */
function call(socketPath: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let input = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) { socket.destroy(); resolve(JSON.parse(input.split("\n")[0]!)); }
    });
    socket.once("error", reject);
  });
}

async function serve() {
  const runtime = temp();
  const socketPath = socketPathFor({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p5" })!;
  const fake = fakeClient();
  const bridge = createBridge({ client: fake.client });
  const handle = await listen(bridge, socketPath);
  if (!handle) throw new Error("not listening");
  closers.push(handle.close);
  return { ...fake, bridge, socketPath, runtime, handle };
}

describe("OpenCode question bridge", () => {
  it("is off unless opted in, in the pane's TUI", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1", HERDR_PANE_ID: "w1:p5", OVIS_OPENCODE_QUESTIONS: "1" };
    expect(enabled(env, ["bun", "worker.js"])).toBe(true);
    expect(enabled({ ...env, OVIS_OPENCODE_QUESTIONS: undefined }, ["bun", "worker.js"])).toBe(false);
    expect(enabled({ ...env, HERDR_PANE_ID: undefined }, ["bun", "worker.js"])).toBe(false);
    expect(enabled({ ...env, XDG_RUNTIME_DIR: undefined }, ["bun", "worker.js"])).toBe(false);
    expect(enabled({ ...env, HERDR_PANE_ID: "../escape" }, ["bun", "worker.js"])).toBe(false);
    expect(isTuiProcess(["opencode", "opencode", "run", "hi"])).toBe(false);
    expect(isTuiProcess(["opencode", "opencode", "--print-logs", "serve"])).toBe(false);
    expect(isTuiProcess(["opencode", "opencode", "/some/project"])).toBe(true);
    expect(isTuiProcess(["opencode", "opencode", "--log-level", "DEBUG", "run", "hi"])).toBe(false);
    expect(isTuiProcess(["opencode", "opencode", "--model", "a/b", "/some/project"])).toBe(true);
    expect(isTuiProcess(["opencode", "opencode", "providers"])).toBe(false);
  });

  it("makes the socket and its directory private, and removes the socket on close", async () => {
    const { socketPath, handle } = await serve();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(socketPath, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(join(socketPath, "..", "..")).mode & 0o777).toBe(0o700);
    handle.close();
    expect(() => lstatSync(socketPath)).toThrow();
  });

  it("replaces a stale socket but never a live one", async () => {
    const { socketPath, bridge } = await serve();
    // a second TUI on the same pane id leaves the live one alone
    expect(await listen(bridge, socketPath)).toBeNull();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
  });

  it("cleans up a socket left by a process that died", async () => {
    const runtime = temp();
    const socketPath = socketPathFor({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p6" })!;
    const { client } = fakeClient();
    await listen(createBridge({ client }), socketPath).then((handle) => handle?.close());
    // a process killed outright leaves its socket file behind
    const child = Bun.spawn([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    const second = await listen(createBridge({ client }), socketPath);
    expect(second).not.toBeNull();
    closers.push(second!.close);
    expect((await call(socketPath, { op: "list" })).ok).toBe(true);
  });

  it("refuses a socket path that is not a socket", async () => {
    const runtime = temp();
    const socketPath = socketPathFor({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p7" })!;
    const { client } = fakeClient();
    await listen(createBridge({ client }), socketPath).then((handle) => handle?.close());
    writeFileSync(socketPath, "not a socket");
    await expect(listen(createBridge({ client }), socketPath)).rejects.toThrow();
  });

  it("lists pending questions from every session with the root session they belong to", async () => {
    const { bridge, socketPath } = await serve();
    bridge.handleEvent({ type: "session.updated", properties: { info: { id: "ses_child1", parentID: "ses_root1" } } });
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    const listed = await call(socketPath, { op: "list" });
    const { tool: _tool, ...request } = asked();
    expect(listed).toEqual({ ok: true, questions: [{ ...request, rootSessionID: "ses_root1" }] });
    bridge.handleEvent({ type: "question.replied", properties: { sessionID: "ses_child1", requestID: "que_a1", answers: [] } });
    expect(await call(socketPath, { op: "list" })).toEqual({ ok: true, questions: [] });
  });

  it("follows OpenCode's own list when it answers, so a question settled elsewhere is gone", async () => {
    const { bridge, socketPath, state } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    state.live = [];
    expect(await call(socketPath, { op: "list" })).toEqual({ ok: true, questions: [] });
    state.live = [asked("que_b2", "ses_root1")];
    expect(((await call(socketPath, { op: "list" })).questions as { id: string }[]).map((q) => q.id)).toEqual(["que_b2"]);
  });

  it("replies only to a pending question, through OpenCode's reply route", async () => {
    const { bridge, socketPath, calls } = await serve();
    expect(await call(socketPath, { op: "reply", requestID: "que_a1", answers: [["Red"], ["Small"]] })).toMatchObject({ ok: false, code: "not_pending" });
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    expect(await call(socketPath, { op: "reply", requestID: "que_a1", answers: [["Red", "Green"], ["Medium"]] })).toEqual({ ok: true });
    expect(calls.filter((c) => c.body)).toEqual([{ url: "/question/{requestID}/reply", path: { requestID: "que_a1" }, body: { answers: [["Red", "Green"], ["Medium"]] } }]);
    // answered: a second reply is refused before it reaches OpenCode
    expect(await call(socketPath, { op: "reply", requestID: "que_a1", answers: [["Red"], ["Small"]] })).toMatchObject({ ok: false, code: "not_pending" });
    expect(calls.filter((c) => c.body)).toHaveLength(1);
  });

  it("rejects a pending question through OpenCode's reject route", async () => {
    const { bridge, socketPath, calls } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    expect(await call(socketPath, { op: "reject", requestID: "que_a1" })).toEqual({ ok: true });
    expect(calls.filter((c) => c.path)).toEqual([{ url: "/question/{requestID}/reject", path: { requestID: "que_a1" }, body: undefined }]);
    expect(await call(socketPath, { op: "reject", requestID: "que_a1" })).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("forgets a question OpenCode no longer knows", async () => {
    const { bridge, socketPath, state } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    state.status = 404;
    expect(await call(socketPath, { op: "reject", requestID: "que_a1" })).toMatchObject({ ok: false, code: "not_pending" });
    expect(bridge.pending.size).toBe(0);
  });

  it("refuses unknown operations, bad JSON and oversized messages", async () => {
    const { socketPath } = await serve();
    expect(await call(socketPath, { op: "permission", requestID: "per_1", reply: "always" })).toMatchObject({ ok: false, code: "unknown_op" });
    expect(await call(socketPath, "{not json")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(await call(socketPath, [1, 2])).toMatchObject({ ok: false, code: "invalid_message" });
    expect(await call(socketPath, { op: "reply", requestID: "../../x", answers: [] })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await call(socketPath, `{"op":"list","pad":"${"x".repeat(70 * 1024)}"}`)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("checks each answer against its question before anything is sent", async () => {
    const { bridge, socketPath, calls } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    for (const answers of [
      [["Red"]],
      [["Red"], ["Small", "Medium"]],
      [["Red"], ["Huge"]],
      [["Red"], [7]],
      [["Red"], [""]],
      [["x".repeat(12_001)], ["Small"]],
      "Red",
    ]) expect(await call(socketPath, { op: "reply", requestID: "que_a1", answers })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(calls.filter((c) => c.body)).toEqual([]);
    // the first question takes a typed answer, and a multiple choice may take none
    expect(validateAnswers(bridge.pending.get("que_a1")!, [["my own colour"], ["Small"]])).toBeNull();
    expect(validateAnswers(bridge.pending.get("que_a1")!, [[], ["Small"]])).toBeNull();
  });

  it("forgets questions OpenCode settled or whose session it deleted", async () => {
    const { bridge, socketPath } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked("que_r1", "ses_child1") });
    bridge.handleEvent({ type: "question.asked", properties: asked("que_d1", "ses_gone1") });
    bridge.handleEvent({ type: "question.rejected", properties: { sessionID: "ses_child1", requestID: "que_r1" } });
    bridge.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_gone1" } } });
    expect(await call(socketPath, { op: "list" })).toEqual({ ok: true, questions: [] });
  });

  it("says so when it cannot reach OpenCode's question routes, or OpenCode does not confirm", async () => {
    const { bridge, socketPath, client } = await serve();
    bridge.handleEvent({ type: "question.asked", properties: asked() });
    client._client!.post = () => new Promise(() => {});
    expect(await call(socketPath, { op: "reject", requestID: "que_a1" })).toMatchObject({ ok: false, code: "unconfirmed" });
    delete client._client!.post;
    expect(await call(socketPath, { op: "reject", requestID: "que_a1" })).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("answers busy past the connection cap, and runs at most a few operations per connection", async () => {
    const { socketPath } = await serve();
    const held = await Promise.all(Array.from({ length: 16 }, () => new Promise<ReturnType<typeof connect>>((resolve) => {
      const socket = connect({ path: socketPath });
      socket.once("connect", () => resolve(socket));
    })));
    try { expect(await call(socketPath, { op: "list" })).toMatchObject({ ok: false, code: "busy" }); }
    finally { for (const socket of held) socket.destroy(); }
    const lines = await new Promise<string[]>((resolve) => {
      const socket = connect({ path: socketPath });
      let input = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${'{"op":"list"}\n'.repeat(50)}`));
      socket.on("data", (chunk) => { input += chunk; });
      socket.once("close", () => resolve(input.trim().split("\n")));
    });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: false, code: "busy" });
  });

  it("leaves a socket that another process made at the path after it", async () => {
    const { socketPath, handle, client } = await serve();
    rmSync(socketPath);
    const other = await listen(createBridge({ client }), socketPath);
    closers.push(() => other?.close());
    handle.close();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect((await call(socketPath, { op: "list" })).ok).toBe(true);
  });

  it("serves every OpenCode instance in the process on one socket, until the last is gone", async () => {
    const runtime = temp();
    const socketPath = socketPathFor({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p8" })!;
    const hub = createHub();
    const first = fakeClient();
    const second = fakeClient();
    const a = createBridge({ client: first.client });
    const b = createBridge({ client: second.client });
    await hub.add(a, socketPath, () => {});
    await hub.add(b, socketPath, () => {});
    closers.push(() => { void hub.remove(a, socketPath, () => {}); void hub.remove(b, socketPath, () => {}); });
    a.handleEvent({ type: "question.asked", properties: asked("que_a1") });
    b.handleEvent({ type: "question.asked", properties: asked("que_b1", "ses_other1") });
    expect(((await call(socketPath, { op: "list" })).questions as { id: string }[]).map((q) => q.id).sort()).toEqual(["que_a1", "que_b1"]);
    // the reply goes to the instance that asked
    expect(await call(socketPath, { op: "reply", requestID: "que_b1", answers: [["Red"], ["Small"]] })).toEqual({ ok: true });
    expect(first.calls.filter((c) => c.body)).toEqual([]);
    expect(second.calls.filter((c) => c.body)).toHaveLength(1);
    await hub.remove(a, socketPath, () => {});
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await hub.remove(b, socketPath, () => {});
    expect(() => lstatSync(socketPath)).toThrow();
  });

  it("removes its socket when OpenCode disposes the plugin", async () => {
    const runtime = temp();
    const saved = { ...process.env };
    Object.assign(process.env, { XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: "w1:p9", OVIS_OPENCODE_QUESTIONS: "1" });
    try {
      const hooks = await OvisQuestionsPlugin({ client: fakeClient().client });
      const socketPath = socketPathFor()!;
      for (let tries = 0; tries < 100; tries++) {
        try { if (lstatSync(socketPath).isSocket()) break; } catch { /* not yet */ }
        await Bun.sleep(5);
      }
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      await hooks.dispose!();
      expect(() => lstatSync(socketPath)).toThrow();
    } finally {
      for (const key of ["XDG_RUNTIME_DIR", "HERDR_PANE_ID", "OVIS_OPENCODE_QUESTIONS"]) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });

  it("drops malformed question events", () => {
    const bridge = createBridge({ client: fakeClient().client });
    bridge.handleEvent({ type: "question.asked", properties: { id: "que_x", sessionID: "ses_x", questions: [{ question: 1 }] } });
    bridge.handleEvent({ type: "question.asked", properties: { id: "nope", sessionID: "ses_x", questions: asked().questions } });
    expect(bridge.pending.size).toBe(0);
  });
});
