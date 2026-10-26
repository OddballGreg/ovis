import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { MAX_ANSWER_CHARS, MAX_HEADER_CHARS, MAX_LABEL_CHARS, MAX_OPTIONS, MAX_QUESTIONS, socketPathFor } from "../integrations/opencode/ovis-questions.js";
import { OPENCODE_HTTP_TIMEOUT_MS, type OpenCodeFormInfo } from "./opencode-service.ts";

/**
 * An OpenCode 1.x TUI keeps its questions in its own process and opens no port. They reach Ovis
 * through the ovis-questions plugin (integrations/opencode/ovis-questions.js), which runs inside
 * that process and serves them on a unix socket named after the herdr pane: list, reply and
 * reject, for a question pending now and nothing else. When there is no socket, or it does not
 * answer, these calls return null and Ovis reads the prompt off the screen (dialogs/opencode.ts).
 */
export const openCodeQuestionSocketOptions: { runtimeDir?: string } = {};

const MAX_REPLY_BYTES = 1024 * 1024;
/** a reply makes two calls inside OpenCode (its pending list, then the reply), a second each at most */
const REPLY_TIMEOUT_MS = 3_000;

/** The pane's socket by the plugin's own rule, under this server's XDG_RUNTIME_DIR (tests point it elsewhere). */
export function openCodeQuestionSocket(paneId: string, env: Record<string, string | undefined> = process.env): string | null {
  const runtime = openCodeQuestionSocketOptions.runtimeDir ?? env["XDG_RUNTIME_DIR"];
  if (!runtime || !isAbsolute(runtime)) return null;
  return socketPathFor({ XDG_RUNTIME_DIR: runtime, HERDR_PANE_ID: paneId });
}

/**
 * This user's own socket in this user's own directories, or nothing: a path someone else made
 * never gets an answer written to it.
 */
function ownSocket(path: string): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    const socket = lstatSync(path);
    if (!socket.isSocket() || (uid !== null && socket.uid !== uid)) return false;
    for (const dir of [dirname(path), dirname(dirname(path))]) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * One request line and its one answer line. `sent` says whether the request left: an answer that
 * never came after it may still have been acted on.
 */
function exchange(path: string, message: unknown, signal?: AbortSignal, timeoutMs = OPENCODE_HTTP_TIMEOUT_MS): Promise<{ answer: Record<string, unknown> | null; sent: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted || !ownSocket(path)) { resolve({ answer: null, sent: false }); return; }
    let sent = false;
    let done = false;
    let input = "";
    const socket = connect({ path });
    const finish = (answer: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve({ answer, sent });
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("connect", () => { sent = true; socket.write(`${JSON.stringify(message)}\n`); });
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > MAX_REPLY_BYTES) { finish(null); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      let parsed: unknown;
      try { parsed = JSON.parse(input.slice(0, end)); } catch { parsed = null; } // not the plugin's answer: none
      finish(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null);
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const ID_CHARS = 200;

/** One question request from the plugin as the form the native card reads, or null for any other shape. */
function formOf(item: unknown, sessionID: string): OpenCodeFormInfo | null {
  if (typeof item !== "object" || item === null) return null;
  const { id, sessionID: asker, rootSessionID, questions } = item as Record<string, unknown>;
  if (!text(id, ID_CHARS) || !id || !text(asker, ID_CHARS) || (asker !== sessionID && rootSessionID !== sessionID)) return null;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return null;
  const fields: OpenCodeFormInfo["fields"] = [];
  for (const [index, question] of questions.entries()) {
    if (typeof question !== "object" || question === null) return null;
    const { question: asked, header, options, multiple, custom } = question as Record<string, unknown>;
    if (!text(asked, MAX_ANSWER_CHARS) || !text(header ?? "", MAX_HEADER_CHARS) || !Array.isArray(options) || options.length > MAX_OPTIONS) return null;
    const choices: { value: string; label: string; description?: string }[] = [];
    for (const option of options) {
      if (typeof option !== "object" || option === null) return null;
      const { label, description } = option as Record<string, unknown>;
      if (!text(label, MAX_LABEL_CHARS) || !label || !text(description ?? "", MAX_ANSWER_CHARS)) return null;
      choices.push({ value: label, label, ...(description ? { description: description as string } : {}) });
    }
    fields.push({
      key: `q${index}`,
      type: multiple === true ? "multiselect" : "select",
      ...(header ? { title: header as string } : {}),
      description: asked,
      required: true,
      options: choices,
      // OpenCode's default: a typed answer is allowed unless the question says otherwise
      custom: custom !== false,
    });
  }
  return { id, sessionID, title: fields[0]?.title || "Question", metadata: { kind: "question" }, fields };
}

/**
 * The questions the pane's TUI waits on in this session (its own or its subagents'), oldest
 * first, or null when the plugin is not there or did not answer.
 */
export async function listPluginQuestionForms(paneId: string, sessionID: string, signal?: AbortSignal): Promise<OpenCodeFormInfo[] | null> {
  const path = openCodeQuestionSocket(paneId);
  if (!path) return null;
  const { answer } = await exchange(path, { op: "list" }, signal);
  if (answer?.ok !== true || !Array.isArray(answer.questions)) return null;
  return answer.questions.flatMap((item) => {
    const form = formOf(item, sessionID);
    return form ? [form] : [];
  });
}

/** The card's answers, keyed by field, as OpenCode takes them: one list of labels per question, in order. */
export function pluginAnswers(fieldKeys: readonly string[], answers: Record<string, string | string[]>): string[][] {
  return fieldKeys.map((key) => {
    const value = answers[key];
    if (Array.isArray(value)) return value.filter((item) => item !== "");
    return value ? [value] : [];
  });
}

/**
 * Sends one reply through the plugin. Status follows the HTTP form the card's other path reads:
 * 200 sent, 409 no longer pending, 400 refused by the plugin's checks, 503 not sent (no plugin, or
 * it was busy), 0 sent but unconfirmed, 502 any other failure OpenCode reported.
 */
export async function replyPluginQuestion(paneId: string, requestID: string, answers: string[][], signal?: AbortSignal): Promise<{ ok: boolean; status: number }> {
  const path = openCodeQuestionSocket(paneId);
  if (!path) return { ok: false, status: 503 };
  const { answer, sent } = await exchange(path, { op: "reply", requestID, answers }, signal, REPLY_TIMEOUT_MS);
  if (!answer) return { ok: false, status: sent ? 0 : 503 };
  if (answer.ok === true) return { ok: true, status: 200 };
  if (answer.code === "not_pending") return { ok: false, status: 409 };
  if (answer.code === "busy") return { ok: false, status: 503 };
  if (answer.code === "unconfirmed") return { ok: false, status: 0 };
  if (answer.code === "invalid_answer" || answer.code === "invalid_request") return { ok: false, status: 400 };
  return { ok: false, status: 502 };
}
