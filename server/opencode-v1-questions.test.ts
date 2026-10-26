import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBridge, listen, socketPathFor, type BridgeClient } from "../integrations/opencode/ovis-questions.js";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { openCodeQuestionSocket, openCodeQuestionSocketOptions, pluginAnswers } from "./opencode-v1-questions.ts";
import { handlePromptRequest } from "./prompt.ts";

const SESSION = "ses_fixtureroot1";
const v1Screen = readFileSync(join(import.meta.dir, "fixtures", "opencode-question-1.2.27-single-wide.txt"), "utf8");

const colors = { question: "Pick colors", header: "Colors", options: [{ label: "Red", description: "warm" }, { label: "Green", description: "" }, { label: "Blue", description: "" }], multiple: true };
const size = { question: "Pick a size", header: "Size", options: [{ label: "Small", description: "" }, { label: "Medium", description: "" }], multiple: false, custom: false };

let serial = 0;
let root = "";
let previous: string | undefined;
let cleanup: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-v1-questions-"));
  previous = openCodeQuestionSocketOptions.runtimeDir;
  openCodeQuestionSocketOptions.runtimeDir = root;
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  openCodeQuestionSocketOptions.runtimeDir = previous;
  rmSync(root, { recursive: true, force: true });
});

/**
 * A pane whose OpenCode 1.x TUI runs the real ovis-questions plugin: herdr is a fixture socket,
 * OpenCode's question routes a fake SDK client, and the plugin's socket is real. No v2 service.
 */
async function pane({ plugin = true, screen = "", v2Forms = null as unknown[] | null } = {}) {
  const paneId = `w9:p${++serial}`;
  const posted: { url: string; body?: unknown }[] = [];
  /** how OpenCode answers a reply: 200 by default, any other status, or never */
  const replying = { status: 200 as number | "never" };
  /** OpenCode's own pending list: unread (the plugin keeps its events) until `live` is set */
  const upstream = { live: null as unknown[] | null, settleAfter: Infinity, changeAfter: Infinity, changed: null as unknown[] | null };
  const client: BridgeClient = {
    _client: {
      get: async () => {
        if (upstream.live === null) return { error: "not used", response: { status: 500 } };
        if (--upstream.settleAfter < 0) upstream.live = [];
        if (--upstream.changeAfter < 0 && upstream.changed) { upstream.live = upstream.changed; upstream.changed = null; }
        return { data: upstream.live, response: { status: 200 } };
      },
      post: async ({ url, body }) => {
        posted.push({ url, body });
        if (replying.status === "never") return new Promise(() => {});
        return replying.status < 400 ? { data: true, response: { status: replying.status } } : { error: {}, response: { status: replying.status } };
      },
    },
    session: { get: async ({ path }) => ({ data: path.id === "ses_childfix1" ? { parentID: SESSION } : {} }) },
  };
  const bridge = createBridge({ client });
  let handle: Awaited<ReturnType<typeof listen>> = null;
  if (plugin) {
    handle = await listen(bridge, openCodeQuestionSocket(paneId)!);
    cleanup.push(() => handle?.close());
  }
  const herdr = join(root, `herdr-${serial}.sock`);
  const sockets = new Set<Socket>();
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input.split("\n")[0]!) as { id: string; method: string };
      const live = {
        pane_id: paneId, agent: "opencode", agent_status: "blocked",
        agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: SESSION },
      };
      const result = req.method === "session.snapshot" ? { snapshot: { panes: [live], layouts: [] } } : { read: { text: screen } };
      socket.end(`${JSON.stringify({ id: req.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { rpc.once("error", reject); rpc.listen(herdr, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = herdr;
  cleanup.push(() => {
    if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    rpc.close();
  });
  const options = { openCodeStateDir: join(root, "no-v2-service") };
  const v2Replies: unknown[] = [];
  if (v2Forms) {
    // OpenCode 2's own service, as opencode-answer.test.ts fakes it
    const service = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (request.method === "GET" && new URL(request.url).pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: root } });
        if (request.method === "GET") return Response.json(v2Forms);
        v2Replies.push(await request.json());
        return new Response(null, { status: 204 });
      },
    });
    cleanup.push(() => service.stop(true));
    options.openCodeStateDir = join(root, `v2-${serial}`);
    mkdirSync(options.openCodeStateDir);
    writeFileSync(join(options.openCodeStateDir, "service.json"), JSON.stringify({ url: service.url.origin, password: ["fixture", "only"].join("-"), pid: process.pid }));
  }
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
  return {
    bridge, posted, upstream, replying, v2Replies,
    stopPlugin() { handle?.close(); },
    ask(questions: unknown[], sessionID = SESSION, id = `que_fix${serial}`) {
      bridge.handleEvent({ type: "question.asked", properties: { id, sessionID, questions } });
      if (upstream.live) upstream.live.push({ id, sessionID, questions });
      return id;
    },
    async read(): Promise<InteractivePrompt | null> {
      const response = await handlePromptRequest(new Request(url), url, options);
      expect(response?.status).toBe(200);
      return ((await response!.json()) as { prompt: InteractivePrompt | null }).prompt;
    },
    async answer(prompt: InteractivePrompt, choice: Omit<PromptAnswer, "pane_id" | "prompt_id">): Promise<Response> {
      const response = await handlePromptRequest(new Request(answerUrl, {
        method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: prompt.id, ...choice }),
      }), answerUrl, options);
      return response!;
    },
  };
}

describe("OpenCode 1.x questions through the ovis-questions plugin", () => {
  it("shows a single choice with its typed-answer row and sends the pick", async () => {
    const p = await pane();
    const id = p.ask([{ ...size, custom: undefined }]);
    const prompt = (await p.read())!;
    expect(prompt).toMatchObject({ title: "Size", question: "Pick a size", multi_select: false, custom_option_index: 2 });
    expect(prompt.options.map((option) => option.label)).toEqual(["Small", "Medium", "Type your own answer"]);
    expect(prompt.steps).toBeUndefined();
    expect((await p.answer(prompt, { option_index: 1 })).status).toBe(200);
    expect(p.posted).toEqual([{ url: "/question/{requestID}/reply", body: { answers: [["Medium"]] } }]);
    expect(p.bridge.pending.has(id)).toBe(false);
    expect(await p.read()).toBeNull();
  });

  it("shows a multiple choice and sends its checks with a typed answer", async () => {
    const p = await pane();
    p.ask([colors]);
    const prompt = (await p.read())!;
    expect(prompt).toMatchObject({ title: "Colors", multi_select: true, custom_option_index: 3 });
    expect(prompt.options[0]).toEqual({ label: "Red", description: "warm" });
    expect((await p.answer(prompt, { option_indices: [0, 2], custom_text: "teal" })).status).toBe(200);
    expect(p.posted).toEqual([{ url: "/question/{requestID}/reply", body: { answers: [["Red", "Blue", "teal"]] } }]);
  });

  it("steps through a form of two questions and sends both answers at the end", async () => {
    const p = await pane();
    p.ask([colors, size]);
    const first = (await p.read())!;
    expect(first.title).toBe("Question 1 of 2");
    expect(first.steps).toEqual([{ label: "Colors", answered: false, current: true }, { label: "Size", answered: false, current: false }]);
    expect((await p.answer(first, { option_indices: [0, 1] })).status).toBe(200);
    expect(p.posted).toEqual([]);
    const second = (await p.read())!;
    expect(second).toMatchObject({ title: "Question 2 of 2", question: "Pick a size", multi_select: false, custom_option_index: null, can_step_back: true });
    expect(second.steps?.map((step) => step.answered)).toEqual([true, false]);
    // no typed answer for a question that does not take one
    expect((await p.answer(second, { custom_text: "Huge" })).status).toBe(400);
    expect((await p.answer(second, { option_index: 0 })).status).toBe(200);
    expect(p.posted).toEqual([{ url: "/question/{requestID}/reply", body: { answers: [["Red", "Green"], ["Small"]] } }]);
  });

  it("shows a subagent's question in its root session's pane", async () => {
    const p = await pane();
    p.ask([size], "ses_childfix1");
    expect((await p.read())?.title).toBe("Size");
  });

  it("asks the plugin again just before sending, and sends nothing to a question settled by then", async () => {
    const p = await pane();
    p.upstream.live = [];
    p.ask([size]);
    const prompt = (await p.read())!;
    // the answer reads the card once more, then the plugin is asked right before the reply: settled there
    p.upstream.settleAfter = 1;
    const response = await p.answer(prompt, { option_index: 1 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    expect(p.posted).toEqual([]);
  });

  it("refuses an answer to a card whose question was settled before the answer arrived", async () => {
    const p = await pane();
    const id = p.ask([size]);
    const prompt = (await p.read())!;
    // answered in the terminal before the card's answer arrives
    p.bridge.handleEvent({ type: "question.replied", properties: { sessionID: SESSION, requestID: id, answers: [["Small"]] } });
    expect((await p.answer(prompt, { option_index: 1 })).status).toBe(409);
    expect(p.posted).toEqual([]);
  });

  it("sends nothing when the question's fields changed under the same id just before the reply", async () => {
    const p = await pane();
    p.upstream.live = [];
    const id = p.ask([size]);
    const prompt = (await p.read())!;
    // the card's own re-read sees the old fields, the check just before the reply sees new ones
    p.upstream.changed = [{ id, sessionID: SESSION, questions: [{ ...size, options: [{ label: "Large", description: "" }, { label: "Small", description: "" }] }] }];
    p.upstream.changeAfter = 1;
    const response = await p.answer(prompt, { option_index: 0 });
    expect(response.status).toBe(409);
    expect(p.posted).toEqual([]);
  });

  it("shows OpenCode 2's form when the plugin has no question for the session", async () => {
    const p = await pane({ v2Forms: [{ id: "form_v2", sessionID: SESSION, title: "From v2", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", custom: true }] }] });
    const prompt = (await p.read())!;
    expect(prompt.title).toBe("From v2");
    expect((await p.answer(prompt, { custom_text: "native" })).status).toBe(200);
    expect(p.v2Replies).toEqual([{ answer: { q0: "native" } }]);
    expect(p.posted).toEqual([]);
  });

  it("keeps the card but sends nothing when the plugin stops answering", async () => {
    const p = await pane();
    p.ask([size]);
    const prompt = (await p.read())!;
    p.stopPlugin();
    const response = await p.answer(prompt, { option_index: 0 });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "service_unavailable", message: "OpenCode's question plugin did not answer. Your answer has not been sent.",
    });
    expect(p.posted).toEqual([]);
  });

  it("reports an unknown delivery when OpenCode does not confirm the reply", async () => {
    const p = await pane();
    p.ask([size]);
    p.replying.status = "never";
    const response = await p.answer((await p.read())!, { option_index: 0 });
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("reply_unconfirmed");
    expect(p.posted).toHaveLength(1);
  }, 5_000);

  it("treats a question OpenCode no longer knows as settled", async () => {
    const p = await pane();
    p.ask([size]);
    p.replying.status = 404;
    const response = await p.answer((await p.read())!, { option_index: 0 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
  });

  it("reads OpenCode 1.x's own prompt off the screen when the pane has no plugin", async () => {
    const p = await pane({ plugin: false, screen: v1Screen });
    const prompt = (await p.read())!;
    expect(prompt.title).toBe("Question");
    expect(prompt.multi_select).toBe(false);
    expect(prompt.options.length).toBeGreaterThan(1);
  });

  it("reads the screen when the plugin has nothing pending for this session", async () => {
    const p = await pane({ screen: v1Screen });
    p.ask([size], "ses_someoneelse1");
    expect((await p.read())?.title).toBe("Question");
  });
});

describe("the pane's socket", () => {
  it("is where the plugin listens", () => {
    for (const pane of ["w1:p5", "w2:p1C", "x"]) expect(openCodeQuestionSocket(pane)).toBe(socketPathFor({ XDG_RUNTIME_DIR: root, HERDR_PANE_ID: pane }));
    for (const pane of ["../x", "w1/p5", ""]) expect(openCodeQuestionSocket(pane)).toBeNull();
  });

  it("is never under the user's runtime directory in a test run", () => {
    openCodeQuestionSocketOptions.runtimeDir = previous;
    expect(previous).toBeDefined();
    const real = process.env["XDG_RUNTIME_DIR"];
    if (real) expect(openCodeQuestionSocket("w1:p1")!.startsWith(real)).toBe(false);
  });
});

describe("pluginAnswers", () => {
  it("lists one answer per question in form order", () => {
    expect(pluginAnswers(["q0", "q1", "q2"], { q1: "Small", q0: ["Red", ""], q2: "" })).toEqual([["Red"], ["Small"], []]);
  });
});
