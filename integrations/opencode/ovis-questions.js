// Ovis question bridge for OpenCode 1.x (plain JS, no dependencies).
//
// Goes in an OpenCode plugins folder, such as ~/.config/opencode/plugins beside herdr's own
// herdr-agent-state.js. An OpenCode 1.x TUI keeps its questions in its own process and opens no
// port, so inside that process this plugin keeps the questions it waits on and takes Ovis's
// replies to them over a unix socket only this user can open:
//   $XDG_RUNTIME_DIR/ovis/opencode-questions/<HERDR_PANE_ID>.sock
// One JSON object per line, three operations and nothing else:
//   {"op":"list"}                                 -> {"ok":true,"questions":[...]}
//   {"op":"reply","requestID":"que_…","answers":[["Red","Green"],["Medium"]]}
//   {"op":"reject","requestID":"que_…"}
// A reply or reject is taken only for a question that is pending now. No TCP port is opened.
// Off unless HERDR_PANE_ID is set and OVIS_OPENCODE_QUESTIONS=1.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_ANSWER_CHARS = 12_000;
export const MAX_LABEL_CHARS = 1_000;
export const MAX_HEADER_CHARS = 200;
export const MAX_QUESTIONS = 64;
export const MAX_OPTIONS = 64;
const MAX_CONNECTIONS = 16;
// operations one connection may have waiting: Ovis sends one per connection
const MAX_QUEUED = 4;
const IDLE_MS = 5_000;
// each call to OpenCode inside the process; a reply makes two (the pending list, then the reply)
const UPSTREAM_MS = 1_000;
const PANE_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const REQUEST_RE = /^que_[A-Za-z0-9]{1,120}$/;
const SESSION_RE = /^ses_[A-Za-z0-9]{1,120}$/;
// OpenCode 1.19's commands other than the TUI: processes that carry the pane's environment
// (an agent's `opencode run`, a `serve`) but are not the pane's TUI
const OTHER_COMMANDS = new Set([
  "run", "serve", "web", "attach", "acp", "mcp", "github", "pr", "debug", "export", "import", "stats",
  "models", "providers", "auth", "agent", "upgrade", "uninstall", "session", "generate", "db", "console", "plugin", "plug",
]);
// global options that take a value as the next argument
const VALUE_OPTIONS = new Set(["--log-level", "--port", "--hostname", "--model", "-m", "--agent", "--session", "-s", "--prompt"]);

/** The socket for this pane, or null when the pane id or runtime directory is unusable. */
export function socketPathFor(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR;
  const pane = env.HERDR_PANE_ID;
  if (!runtime || !path.isAbsolute(runtime) || !pane || !PANE_RE.test(pane)) return null;
  return path.join(runtime, "ovis", "opencode-questions", `${pane}.sock`);
}

/** Whether this process is the pane's interactive OpenCode (its TUI worker), not a run or serve. */
export function isTuiProcess(argv = process.argv) {
  const args = argv.slice(2);
  while (args.length && args[0].startsWith("-")) {
    const option = args.shift();
    if (VALUE_OPTIONS.has(option)) args.shift();
  }
  return !OTHER_COMMANDS.has(args[0] ?? "");
}

export function enabled(env = process.env, argv = process.argv) {
  return env.OVIS_OPENCODE_QUESTIONS === "1" && !!env.HERDR_PANE_ID && socketPathFor(env) !== null && isTuiProcess(argv);
}

const string = (value, max) => typeof value === "string" && value.length <= max;

/** A question.asked payload reduced to what Ovis shows, or null when its shape is not OpenCode's. */
export function normalizeRequest(value) {
  if (!value || typeof value !== "object") return null;
  const { id, sessionID, questions } = value;
  if (!string(id, 200) || !REQUEST_RE.test(id) || !string(sessionID, 200) || !SESSION_RE.test(sessionID)) return null;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return null;
  const out = [];
  for (const question of questions) {
    if (!question || typeof question !== "object" || !string(question.question, MAX_ANSWER_CHARS) || !string(question.header ?? "", MAX_HEADER_CHARS)) return null;
    if (!Array.isArray(question.options) || question.options.length > MAX_OPTIONS) return null;
    const options = [];
    for (const option of question.options) {
      if (!option || typeof option !== "object" || !string(option.label, MAX_LABEL_CHARS) || !option.label || !string(option.description ?? "", MAX_ANSWER_CHARS)) return null;
      options.push({ label: option.label, description: option.description ?? "" });
    }
    out.push({
      question: question.question,
      header: question.header ?? "",
      options,
      multiple: question.multiple === true,
      // OpenCode's own default: a typed answer is allowed unless the question says otherwise
      custom: question.custom !== false,
    });
  }
  return { id, sessionID, questions: out };
}

/** null when `answers` fits `request`, else why not. Never echoes an answer. */
export function validateAnswers(request, answers) {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) return "one answer list per question is required";
  for (let index = 0; index < answers.length; index++) {
    const answer = answers[index];
    const question = request.questions[index];
    if (!Array.isArray(answer) || answer.length > MAX_OPTIONS + 1) return `answer ${index + 1} must be a list of strings`;
    if (!question.multiple && answer.length > 1) return `question ${index + 1} takes one answer`;
    for (const value of answer) {
      if (typeof value !== "string" || !value.trim() || value.length > MAX_ANSWER_CHARS) return `answer ${index + 1} holds an invalid value`;
      if (!question.custom && !question.options.some((option) => option.label === value)) return `answer ${index + 1} is not one of its options`;
    }
  }
  return null;
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), ms);
  timer.unref?.();
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

const ok = (result) => !!result && !result.error && (result.response?.status ?? 200) < 400;

/**
 * The bridge's state and operations, without the socket: question events in, list/reply/reject
 * out. `client` is the plugin input's SDK client; its raw `_client` is the only way to the
 * question routes, which the 1.x SDK does not wrap.
 */
export function createBridge({ client, log = () => {} }) {
  const pending = new Map();
  const parents = new Map();
  const raw = client?._client;

  const rootOf = async (sessionID) => {
    let id = sessionID;
    for (let depth = 0; depth < 8; depth++) {
      if (!parents.has(id)) {
        let parent = null;
        try {
          const result = await withTimeout(client.session.get({ path: { id } }), UPSTREAM_MS);
          const found = result?.data?.parentID;
          parent = typeof found === "string" && SESSION_RE.test(found) ? found : null;
        } catch { return id; } // unknown: the session itself is the best answer
        parents.set(id, parent);
      }
      const parent = parents.get(id);
      if (!parent) return id;
      id = parent;
    }
    return id;
  };

  /** Pending questions as OpenCode lists them now; the event-tracked set when that read fails. */
  const refresh = async () => {
    if (!raw?.get) return;
    try {
      const result = await withTimeout(raw.get({ url: "/question" }), UPSTREAM_MS);
      if (!ok(result) || !Array.isArray(result.data)) return;
      const live = new Map();
      for (const item of result.data) {
        const request = normalizeRequest(item);
        if (request) live.set(request.id, pending.get(request.id) ?? request);
      }
      pending.clear();
      for (const [id, request] of live) pending.set(id, request);
    } catch { /* keep what the events said */ }
  };

  const handleEvent = (event) => {
    const type = event?.type;
    const properties = event?.properties ?? {};
    const info = properties.info;
    if (info && typeof info.id === "string" && SESSION_RE.test(info.id)) {
      parents.set(info.id, typeof info.parentID === "string" && SESSION_RE.test(info.parentID) ? info.parentID : null);
    }
    if (type === "question.asked") {
      const request = normalizeRequest(properties);
      if (request) { pending.set(request.id, request); log("asked", { requestID: request.id, questions: request.questions.length }); }
    } else if (type === "question.replied" || type === "question.rejected") {
      if (typeof properties.requestID === "string" && pending.delete(properties.requestID)) log(type === "question.replied" ? "replied" : "rejected", { requestID: properties.requestID });
    } else if (type === "session.deleted" && info?.id) {
      for (const [id, request] of pending) if (request.sessionID === info.id) pending.delete(id);
    }
  };

  const list = async () => {
    await refresh();
    const questions = [];
    for (const request of pending.values()) questions.push({ ...request, rootSessionID: await rootOf(request.sessionID) });
    return { ok: true, questions };
  };

  const settle = async (requestID, action, body) => {
    if (typeof requestID !== "string" || !REQUEST_RE.test(requestID)) return { ok: false, code: "invalid_request", message: "requestID is invalid" };
    await refresh();
    const request = pending.get(requestID);
    if (!request) return { ok: false, code: "not_pending", message: "that question is not pending" };
    if (body) {
      const invalid = validateAnswers(request, body.answers);
      if (invalid) return { ok: false, code: "invalid_answer", message: invalid };
    }
    if (!raw?.post) return { ok: false, code: "unavailable", message: "this OpenCode cannot answer questions" };
    let result;
    try {
      result = await withTimeout(raw.post({
        url: `/question/{requestID}/${action}`, path: { requestID },
        ...(body ? { body: { answers: body.answers } } : {}),
        headers: { "Content-Type": "application/json" },
      }), UPSTREAM_MS);
    } catch {
      log(`${action}-unconfirmed`, { requestID });
      return { ok: false, code: "unconfirmed", message: "OpenCode did not confirm" };
    }
    if (!ok(result)) {
      const status = result?.response?.status ?? 0;
      log(`${action}-failed`, { requestID, status });
      if (status === 404) pending.delete(requestID);
      return { ok: false, code: status === 404 ? "not_pending" : "upstream", message: `OpenCode answered ${status || "with an error"}` };
    }
    pending.delete(requestID);
    log(action, { requestID });
    return { ok: true };
  };

  /** One decoded message to its answer. Unknown operations and extra shapes are refused. */
  const handle = async (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, code: "invalid_message", message: "a JSON object is required" };
    if (message.op === "list") return list();
    if (message.op === "reply") return settle(message.requestID, "reply", { answers: message.answers });
    if (message.op === "reject") return settle(message.requestID, "reject", null);
    return { ok: false, code: "unknown_op", message: "op must be list, reply or reject" };
  };

  return { pending, parents, handleEvent, handle, list };
}

/** A path someone else made is never ours: on POSIX the owner must be this user. */
function ownedBy(stat, uid) {
  return typeof process.getuid !== "function" || stat.uid === uid;
}

function prepareDirectory(dir) {
  const uid = process.getuid?.();
  const parent = path.dirname(dir);
  for (const each of [parent, dir]) {
    try { fs.mkdirSync(each, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(each);
    if (!stat.isDirectory() || !ownedBy(stat, uid)) throw new Error(`${each} is not a directory of this user`);
    fs.chmodSync(each, 0o700);
  }
}

/**
 * Removes a socket nobody listens on; true when the path is free. A socket that answers, or one
 * whose probe fails any other way than a refused connection, is left alone (false).
 */
function clearStale(socketPath) {
  let stat;
  try { stat = fs.lstatSync(socketPath); } catch (error) { if (error?.code === "ENOENT") return Promise.resolve(true); throw error; }
  if (!stat.isSocket() || !ownedBy(stat, process.getuid?.())) return Promise.reject(new Error(`${socketPath} is not this user's socket`));
  return new Promise((resolve) => {
    const probe = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
    probe.once("error", (error) => {
      clearTimeout(timer);
      if (error?.code !== "ECONNREFUSED") { resolve(false); return; }
      try { fs.unlinkSync(socketPath); } catch { /* gone already */ }
      resolve(true);
    });
  });
}

/** Serves `bridge` (anything with handle(message)) on `socketPath`. Resolves to a handle with close(), or null when another process holds it. */
export async function listen(bridge, socketPath, { log = () => {} } = {}) {
  prepareDirectory(path.dirname(socketPath));
  if (!(await clearStale(socketPath))) { log("busy", {}); return null; }
  const sockets = new Set();
  let closed = false;
  const refuse = (socket, code, message) => { socket.end(`${JSON.stringify({ ok: false, code, message })}\n`); };
  const server = net.createServer((socket) => {
    if (closed) { socket.destroy(); return; }
    if (sockets.size >= MAX_CONNECTIONS) { refuse(socket, "busy", "too many connections"); return; }
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    let buffer = "";
    let refused = false;
    let queued = 0;
    let chain = Promise.resolve();
    const send = (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.on("data", (chunk) => {
      if (refused) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES && !buffer.includes("\n")) {
        refused = true;
        buffer = "";
        chain = chain.then(() => refuse(socket, "too_large", `a message is at most ${MAX_MESSAGE_BYTES} bytes`));
        return;
      }
      for (let end = buffer.indexOf("\n"); end >= 0 && !refused; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (++queued > MAX_QUEUED) {
          refused = true;
          buffer = "";
          chain = chain.then(() => refuse(socket, "busy", `at most ${MAX_QUEUED} operations wait on one connection`));
          break;
        }
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { chain = chain.then(() => { queued--; send({ ok: false, code: "too_large", message: `a message is at most ${MAX_MESSAGE_BYTES} bytes` }); }); continue; }
        let message;
        try { message = JSON.parse(line); } catch { message = undefined; }
        chain = chain.then(async () => {
          // a client gone meanwhile gets nothing done for it
          if (socket.destroyed) return;
          try {
            if (message === undefined) send({ ok: false, code: "invalid_json", message: "each line must be one JSON object" });
            else send(await bridge.handle(message));
          } catch { send({ ok: false, code: "internal", message: "the bridge failed" }); }
          finally { queued--; }
        });
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  fs.chmodSync(socketPath, 0o600);
  const stamp = (stat) => `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
  const mine = stamp(fs.lstatSync(socketPath));
  server.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    let ours = false;
    try { ours = stamp(fs.lstatSync(socketPath)) === mine; } catch { /* gone already */ }
    // Bun's close unlinks the path whoever made it: when a later process holds the path now, this
    // listener is left open, unreferenced, to end with the process, rather than delete its socket
    if (ours) {
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* Bun removed it */ }
    }
    process.off("exit", close);
  };
  process.on("exit", close);
  log("listening", {});
  return { close, server };
}

/**
 * Every OpenCode instance in this process (one per project folder the TUI opens) gets a bridge of
 * its own, since each has its own client and events; the pane has one socket, served once for
 * all of them.
 */
export function createHub() {
  const bridges = new Set();
  let handle = null;
  let chain = Promise.resolve();

  const dispatch = {
    async handle(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, code: "invalid_message", message: "a JSON object is required" };
      if (message.op === "list") {
        const seen = new Set();
        const questions = [];
        for (const listed of await Promise.all([...bridges].map((bridge) => bridge.list()))) {
          for (const question of listed.questions ?? []) if (!seen.has(question.id)) { seen.add(question.id); questions.push(question); }
        }
        return { ok: true, questions };
      }
      if (message.op !== "reply" && message.op !== "reject") return { ok: false, code: "unknown_op", message: "op must be list, reply or reject" };
      if (typeof message.requestID !== "string" || !REQUEST_RE.test(message.requestID)) return { ok: false, code: "invalid_request", message: "requestID is invalid" };
      // only the instance that holds the question settles it
      for (const bridge of bridges) {
        const answer = await bridge.handle(message);
        if (answer.ok || answer.code !== "not_pending") return answer;
      }
      return { ok: false, code: "not_pending", message: "that question is not pending" };
    },
  };

  /** Listens while any bridge is registered, and stops when the last one goes; one change at a time. */
  const sync = (socketPath, log) => {
    chain = chain.then(async () => {
      if (bridges.size > 0 && !handle) {
        handle = await listen(dispatch, socketPath, { log }).catch((error) => {
          log("listen-failed", { error: String(error?.code ?? error?.message ?? error) });
          return null;
        });
      } else if (bridges.size === 0 && handle) {
        handle.close();
        handle = null;
      }
    });
    return chain;
  };

  return {
    bridges, dispatch,
    add(bridge, socketPath, log) { bridges.add(bridge); return sync(socketPath, log); },
    remove(bridge, socketPath, log) { bridges.delete(bridge); return sync(socketPath, log); },
    get listening() { return handle !== null; },
  };
}

const hub = createHub();

function fileLog(env) {
  const target = env.OVIS_OPENCODE_QUESTIONS_LOG;
  if (!target || !path.isAbsolute(target)) return () => {};
  return (tag, data) => {
    try { fs.appendFileSync(target, `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`, { mode: 0o600 }); } catch { /* logging never breaks the TUI */ }
  };
}

export const OvisQuestionsPlugin = async (input) => {
  const env = process.env;
  if (!enabled(env)) return {};
  const log = fileLog(env);
  const socketPath = socketPathFor(env);
  const bridge = createBridge({ client: input?.client, log });
  // never delay OpenCode's start, and never fail it: without the socket Ovis reads the question off the screen
  void hub.add(bridge, socketPath, log);
  return {
    event: async ({ event }) => bridge.handleEvent(event),
    // OpenCode disposes an instance on exit and on a reload; the last one out removes the socket
    dispose: async () => { await hub.remove(bridge, socketPath, log); },
  };
};

export default {
  id: "ovis.opencode-questions",
  server: OvisQuestionsPlugin,
};
