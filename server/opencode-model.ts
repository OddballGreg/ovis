/**
 * The model of an OpenCode 1.x pane, listed and chosen from the browser.
 *
 * OpenCode 1.x keeps the model a TUI uses in the TUI itself (its local state, sent with each
 * prompt), and a TUI listens on no port, so nothing over HTTP can set it. What can: the TUI's own
 * "Select model" dialog, driven with keys as a person would (`driveModelDialog`). The list comes
 * from the OpenCode HTTP source (opencode-v1.ts, HERDR_WEB_OPENCODE_URL or
 * HERDR_WEB_OPENCODE_SERVE=1): any 1.x server answers GET /config/providers from the same
 * configuration and credentials the TUI reads, `{ providers: [{ id, name, models: { <id>: { name,
 * status, release_date } } }], default }`. Without that source nothing here is offered.
 *
 * The dialog, as drawn by OpenCode 1.x (packages/tui component/dialog-model.tsx, ui/dialog-select.tsx;
 * fixtures opencode-model-1.19-*): a panel over the screen whose first row is the title, then `esc`
 * at its right edge four columns in; a search line two rows down; then the rows. Typing filters
 * them fuzzily and moves the cursor to the first; a filtered row is `<model name>[ (Favorite)]`,
 * then the provider's name at the right. The cursor is drawn only as the row's background, in the
 * theme's primary colour, so the row under it is the one whose background differs from the panel's
 * (read off the title row): no theme's colour is assumed. `●` marks the model in use. The prompt's
 * footer says `<agent> · <model name> <provider name>[ · <variant>]`.
 */
import type { OpencodeModelCatalog, OpencodeModelFailure, OpencodeProvider } from "../shared/protocol.ts";
import { paneGet, paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { opencodeV1Configured, opencodeV1Endpoint, opencodeV1Get, type OpencodeV1Endpoint } from "./opencode-v1.ts";
import { resolveAgent } from "./pane-context.ts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/* -------------------------------------------------------------------------------------------------
 * The list
 * ----------------------------------------------------------------------------------------------- */

/** A provider list is asked again after this. */
export const OPENCODE_MODEL_CATALOG_MS = 60_000;
/** A provider list larger than this is not read. */
const MAX_PROVIDERS_BYTES = 8 * 1024 * 1024;

/**
 * The providers of a GET /config/providers answer, as the TUI's dialog lists them: OpenCode's own
 * provider first, then by name; in each, models newest first, then by name. A deprecated model is
 * not listed, nor OpenCode's `-nano` ones, which the dialog shows disabled. Null when it is not that answer.
 */
export function opencodeProviders(value: unknown): OpencodeProvider[] | null {
  const body = record(value);
  if (!Array.isArray(body.providers)) return null;
  const providers: OpencodeProvider[] = [];
  for (const raw of body.providers) {
    const provider = record(raw);
    const id = text(provider.id);
    if (id === null) continue;
    const models = Object.entries(record(provider.models)).flatMap(([key, rawModel]) => {
      const model = record(rawModel);
      if (key.trim() === "" || model.status === "deprecated" || (id === "opencode" && key.includes("-nano"))) return [];
      return [{ id: key, name: text(model.name) ?? key, release: typeof model.release_date === "string" ? model.release_date : "" }];
    });
    models.sort((a, b) => a.release !== b.release ? (a.release < b.release ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (models.length > 0) providers.push({ id, name: text(provider.name) ?? id, models: models.map(({ id: modelId, name }) => ({ id: modelId, name })) });
  }
  providers.sort((a, b) => (a.id === "opencode") !== (b.id === "opencode") ? (a.id === "opencode" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return providers;
}

/** Tests point the list at a fixture: the server, its answer, a clock. */
export const opencodeModelOptions: {
  endpoint?: () => Promise<OpencodeV1Endpoint | null>;
  read?: (endpoint: OpencodeV1Endpoint) => Promise<unknown>;
  now?: () => number;
} = {};

const clock = (): number => (opencodeModelOptions.now ?? Date.now)();

async function readProviders(endpoint: OpencodeV1Endpoint): Promise<unknown> {
  if (opencodeModelOptions.read) return opencodeModelOptions.read(endpoint);
  const answer = await opencodeV1Get(endpoint, "/config/providers", MAX_PROVIDERS_BYTES);
  if (answer?.status !== 200) return null;
  try { return JSON.parse(answer.body) as unknown; } catch { return null; }
}

let cached: { key: string; at: number; providers: OpencodeProvider[] } | null = null;
let pending: { key: string; promise: Promise<OpencodeProvider[] | null> } | null = null;

/** Forget the list read last (tests). */
export function forgetOpencodeModels(): void {
  cached = null;
  pending = null;
}

/**
 * The models OpenCode offers, read at most once a minute per server; null when the HTTP source is
 * not configured or not to be had now. A failed read answers the list read before, if any.
 */
export async function opencodeModelCatalog(): Promise<OpencodeProvider[] | null> {
  if (opencodeModelOptions.endpoint === undefined && !opencodeV1Configured()) return null;
  const endpoint = await (opencodeModelOptions.endpoint ?? opencodeV1Endpoint)();
  if (endpoint === null) return null;
  const key = `${endpoint.baseUrl}\0${endpoint.authorization ?? ""}`;
  if (cached?.key === key && clock() - cached.at < OPENCODE_MODEL_CATALOG_MS) return cached.providers;
  if (pending?.key === key) return pending.promise;
  const promise = readProviders(endpoint).catch(() => null).then((value) => {
    const providers = opencodeProviders(value);
    if (providers !== null) cached = { key, at: clock(), providers };
    return providers ?? (cached?.key === key ? cached.providers : null);
  }).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = { key, promise };
  return promise;
}

/* -------------------------------------------------------------------------------------------------
 * The screen
 * ----------------------------------------------------------------------------------------------- */

/** One column of a terminal row: its character ("" for the second column of a wide one) and its background. */
export interface Cell { ch: string; bg: string }

const ESCAPE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A colour's SGR parameters from `index` (`5;n` or `2;r;g;b`), and how many it took. */
function extendedColour(codes: number[], index: number): [string, number] {
  if (codes[index + 1] === 5) return [`5;${codes[index + 2] ?? 0}`, 2];
  if (codes[index + 1] === 2) return [`2;${codes[index + 2] ?? 0};${codes[index + 3] ?? 0};${codes[index + 4] ?? 0}`, 4];
  return ["", 0];
}

/**
 * The columns of one ANSI row with the background each is drawn on, inverse video applied. Only SGR
 * sequences change the state; other escapes are dropped. A wide character takes two columns.
 */
export function ansiCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let fg = "default";
  let bg = "default";
  let inverse = false;
  const put = (segment: string): void => {
    for (const ch of segment) {
      if (ch === "\r" || ch === "\n") continue;
      const width = Bun.stringWidth(ch);
      const back = inverse ? (fg === "default" ? "inverse" : fg) : bg;
      if (width === 0) {
        if (cells.length > 0) cells[cells.length - 1]!.ch += ch;
        continue;
      }
      cells.push({ ch, bg: back });
      if (width > 1) cells.push({ ch: "", bg: back });
    }
  };
  let offset = 0;
  for (const match of line.matchAll(ESCAPE)) {
    if (match.index > offset) put(line.slice(offset, match.index));
    offset = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0) { fg = "default"; bg = "default"; inverse = false; }
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
      else if (code === 39) fg = "default";
      else if (code === 49) bg = "default";
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code - 10);
      else if (code === 38 || code === 48 || code === 58) {
        const [colour, taken] = extendedColour(codes, index);
        if (code === 38) fg = colour || fg;
        if (code === 48) bg = colour || bg;
        index += taken;
      }
    }
  }
  if (offset < line.length) put(line.slice(offset));
  return cells;
}

const cellText = (cells: readonly Cell[], from: number, to: number): string => cells.slice(Math.max(0, from), Math.max(0, to)).map((cell) => cell.ch).join("");
const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** The background most of these columns are drawn on. */
function mainBackground(cells: readonly Cell[], from: number, to: number): string | null {
  const counts = new Map<string, number>();
  for (const cell of cells.slice(Math.max(0, from), Math.max(0, to))) counts.set(cell.bg, (counts.get(cell.bg) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [bg, count] of counts) if (count > most) { best = bg; most = count; }
  return best;
}

/** The column where `needle` starts in a row of cells at or after `from`, or -1. */
function columnOf(cells: readonly Cell[], needle: string, from = 0): number {
  const chars = Array.from(needle);
  outer: for (let column = from; column + chars.length <= cells.length; column++) {
    for (let index = 0; index < chars.length; index++) if (cells[column + index]!.ch !== chars[index]) continue outer;
    return column;
  }
  return -1;
}

/** The titles of the dialogs this file reads and closes: the model list, and the variant list choosing a model can open. */
export type SelectTitle = "Select model" | "Select variant";
const TITLE_RE = /(Select (?:model|variant)) +esc(?= |$)/u;

export interface SelectRow {
  /** the row's words, spaces collapsed, without the `●` */
  text: string;
  /** `●`: the model or variant in use */
  current: boolean;
}

export interface SelectDialog {
  title: SelectTitle;
  /** the search line as drawn: what was typed, or the placeholder */
  query: string;
  /** the rows from the top of the list down to its first gap: all of them once something is typed */
  rows: SelectRow[];
  /** the row under the cursor, or -1 when no row, or more than one, is drawn apart */
  highlighted: number;
}

const screenLines = (screen: string): string[] => screen.split("\n").map((line) => line.replace(/\r$/u, ""));

/** The dialog on the screen, or null when none is open. */
export function parseSelectDialog(screen: string): SelectDialog | null {
  const rows = screenLines(screen).map(ansiCells);
  for (let header = 0; header < rows.length; header++) {
    const line = rows[header]!;
    const found = TITLE_RE.exec(line.map((cell) => cell.ch).join(""));
    if (found === null) continue;
    const titleColumn = columnOf(line, found[1]!);
    const escColumn = columnOf(line, "esc", titleColumn + found[1]!.length);
    if (titleColumn < 4 || escColumn < 0) continue;
    // the list's rows span the panel less a column at each side; the header pads four
    const left = titleColumn - 3;
    const right = escColumn + 6;
    const panel = mainBackground(line, left, right);
    const query = collapse(cellText(rows[header + 2] ?? [], titleColumn, escColumn + 3));
    let at = header + 3;
    if (at < rows.length && collapse(cellText(rows[at]!, left, right)) === "") at += 1;
    const list: (SelectRow & { bg: string | null })[] = [];
    for (; at < rows.length; at++) {
      const shown = collapse(cellText(rows[at]!, left, right));
      if (shown === "") break;
      const current = shown.startsWith("●");
      list.push({ text: current ? shown.replace(/^●\s*/u, "") : shown, current, bg: mainBackground(rows[at]!, left, right) });
    }
    const apart = list.flatMap((row, index) => row.bg !== panel ? [index] : []);
    return {
      title: found[1] as SelectTitle,
      query,
      rows: list.map(({ text: words, current }) => ({ text: words, current })),
      highlighted: apart.length === 1 ? apart[0]! : -1,
    };
  }
  return null;
}

const plainLines = (screen: string): string[] => screenLines(screen).map((line) => ansiCells(line).map((cell) => cell.ch).join(""));

/** The prompt's footer row: `┃  <agent> · <model name> <provider name>[ · <variant>]`, then whatever stands at its right. */
const FOOTER_RE = /┃ {2}([^\s·┃][^·┃]*?) · (.+)$/u;

/** What the prompt's footer says after the agent, or null when no prompt footer is on the screen (another screen is open). */
export function promptFooter(screen: string): string | null {
  const lines = plainLines(screen);
  for (let index = lines.length - 1; index >= 0; index--) {
    const found = FOOTER_RE.exec(lines[index]!.trimEnd());
    if (found) return collapse(found[2]!.split(/ {3,}/u)[0]!);
  }
  return null;
}

/** Whether a footer's words name this model: the name, then the provider's name (cut at the pane's edge, perhaps), then nothing or the variant. */
export function footerNames(footer: string, name: string, provider: string): boolean {
  if (!footer.startsWith(`${name} `)) return false;
  const rest = footer.slice(name.length + 1);
  if (rest === provider || rest.startsWith(`${provider} · `)) return true;
  return rest.length > 0 && !rest.includes(" · ") && provider.startsWith(rest);
}

/** The model the footer names, the longest name and provider when several fit; null when none does. */
export function footerModel(screen: string, providers: readonly OpencodeProvider[]): { provider_id: string; model_id: string } | null {
  const footer = promptFooter(screen);
  if (footer === null) return null;
  let best: { provider_id: string; model_id: string; length: number; whole: boolean } | null = null;
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!footerNames(footer, model.name, provider.name)) continue;
      const rest = footer.slice(model.name.length + 1);
      const whole = rest === provider.name || rest.startsWith(`${provider.name} · `);
      const length = model.name.length + provider.name.length;
      if (best === null || (whole && !best.whole) || (whole === best.whole && length > best.length)) best = { provider_id: provider.id, model_id: model.id, length, whole };
    }
  }
  return best === null ? null : { provider_id: best.provider_id, model_id: best.model_id };
}

/**
 * Whether a filtered row is this model: `<name>[ (Favorite)]` and the provider's name at the right.
 * "exact" when the name is whole; "prefix" when the pane's width cut it and what is left starts it.
 */
export function rowMatch(row: string, name: string, provider: string): "exact" | "prefix" | null {
  if (!row.endsWith(` ${provider}`)) return null;
  const left = row.slice(0, row.length - provider.length - 1).trimEnd();
  if (left.startsWith(name)) {
    const rest = left.slice(name.length);
    if (rest === "" || " (Favorite)".startsWith(rest)) return "exact";
    return null;
  }
  const cut = left.replace(/…$/u, "");
  return cut.length >= 4 && name.startsWith(cut) ? "prefix" : null;
}

/* -------------------------------------------------------------------------------------------------
 * Choosing a model in the TUI
 * ----------------------------------------------------------------------------------------------- */

/** The whole switch, from the first key to the footer read back. */
export const OPENCODE_MODEL_DRIVE_MS = 8_000;
/** The dialog opens within this of ctrl+x m. */
const OPEN_MS = 2_500;
/** The screen answers a typed filter or a move within this. */
const STEP_MS = 1_500;
/** The pause between two reads of the screen while waiting for it. */
const POLL_MS = 50;
/** Down presses before the row is given up on. */
export const OPENCODE_MODEL_MAX_MOVES = 80;

/** What driving the TUI takes, apart so the walk can be tested with a screen that answers keys. */
export interface DriveDeps {
  /** the pane's visible screen, with its colours */
  read(): Promise<string>;
  keys(keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type DriveResult = { ok: true } | { ok: false; code: OpencodeModelFailure; message: string };

const MESSAGES: Readonly<Record<OpencodeModelFailure, string>> = {
  unavailable: "the OpenCode HTTP source is not configured or does not answer",
  not_opencode: "the pane does not run OpenCode",
  busy: "OpenCode is working or waiting for an answer; switch the model once it is idle",
  dialog_open: "a dialog is already open in OpenCode",
  not_ready: "OpenCode's prompt is not on the screen",
  unknown_model: "OpenCode does not offer that model",
  dialog_not_opened: "OpenCode's model dialog did not open (ctrl+x m)",
  model_not_found: "the model's row was not found in OpenCode's model dialog",
  not_confirmed: "OpenCode's prompt did not show the new model",
  timeout: "OpenCode did not answer in time",
};

/** The key of the row under the cursor where it is drawn: a move that changes neither did not land. */
const cursorKey = (dialog: SelectDialog): string => `${dialog.highlighted}\0${dialog.rows[dialog.highlighted]?.text ?? ""}`;

/**
 * Picks `target` in the TUI's model dialog: ctrl+x m (the dialog's default keys), the name typed
 * into its search, Down until the row under the cursor is that name with that provider, Enter, then
 * the footer read back. A variant list that opens after the pick is closed with Escape, which keeps
 * the model and its default variant. Refuses before any key when a dialog is open or the prompt's
 * footer is not on the screen. On any failure after the first key, the dialog it opened is closed
 * with one Escape, and only while it is still drawn.
 */
export async function driveModelDialog(deps: DriveDeps, target: { name: string; provider: string }, budgetMs = OPENCODE_MODEL_DRIVE_MS): Promise<DriveResult> {
  const deadline = deps.now() + budgetMs;
  const refuse = (code: OpencodeModelFailure): DriveResult => ({ ok: false, code, message: MESSAGES[code] });
  const first = await deps.read();
  if (parseSelectDialog(first) !== null) return refuse("dialog_open");
  if (promptFooter(first) === null) return refuse("not_ready");

  const fail = async (code: OpencodeModelFailure): Promise<DriveResult> => {
    const screen = await deps.read().catch(() => null);
    if (screen === null || parseSelectDialog(screen) !== null) await deps.keys(["esc"]).catch(() => undefined);
    return refuse(code);
  };
  /** the first answer `test` finds on the screen within `ms` (and the whole budget), or null */
  const until = async <T>(ms: number, test: (screen: string) => T | null): Promise<T | null> => {
    const end = Math.min(deadline, deps.now() + ms);
    for (;;) {
      const found = test(await deps.read());
      if (found !== null) return found;
      if (deps.now() >= end) return null;
      await deps.sleep(POLL_MS);
    }
  };
  const modelDialog = (screen: string): SelectDialog | null => {
    const dialog = parseSelectDialog(screen);
    return dialog?.title === "Select model" ? dialog : null;
  };

  await deps.keys(["ctrl+x", "m"]);
  if (await until(OPEN_MS, modelDialog) === null) return fail("dialog_not_opened");

  await deps.type(target.name);
  const wanted = collapse(target.name);
  let dialog = await until(STEP_MS, (screen) => {
    const shown = modelDialog(screen);
    // a name wider than the search line scrolls it: its end is drawn, where the cursor is
    const typed = shown !== null && (shown.query === wanted || (shown.query.length >= 8 && wanted.endsWith(shown.query)));
    return shown !== null && typed && (shown.rows.length === 0 || shown.highlighted >= 0) ? shown : null;
  });
  if (dialog === null) return fail(deps.now() >= deadline ? "timeout" : "model_not_found");

  const seen = new Set<string>();
  for (let moves = 0; ;) {
    if (dialog.rows.length === 0) return fail("model_not_found");
    const matches = dialog.rows.map((row) => rowMatch(row.text, target.name, target.provider));
    const exact = matches.indexOf("exact");
    const prefixes = matches.filter((match) => match === "prefix").length;
    if (matches[dialog.highlighted] === "exact" || (exact < 0 && prefixes === 1 && matches[dialog.highlighted] === "prefix")) break;
    // the row is in view below the cursor: straight to it; otherwise one row on, which scrolls the list
    const step = exact > dialog.highlighted ? exact - dialog.highlighted : 1;
    const before = cursorKey(dialog);
    // the list wraps from its last row to its first: a cursor seen before has been all the way round
    if (seen.has(before) || moves + step > OPENCODE_MODEL_MAX_MOVES) return fail("model_not_found");
    seen.add(before);
    await deps.keys(Array.from({ length: step }, () => "down"));
    moves += step;
    const moved = await until(STEP_MS, (screen) => {
      const shown = modelDialog(screen);
      return shown !== null && shown.highlighted >= 0 && cursorKey(shown) !== before ? shown : null;
    });
    if (moved === null) return fail(deps.now() >= deadline ? "timeout" : "model_not_found");
    dialog = moved;
  }

  await deps.keys(["enter"]);
  let variantClosed = false;
  for (;;) {
    const screen = await deps.read();
    const open = parseSelectDialog(screen);
    if (open?.title === "Select variant" && !variantClosed) {
      await deps.keys(["esc"]);
      variantClosed = true;
    } else if (open === null) {
      const footer = promptFooter(screen);
      if (footer !== null && footerNames(footer, target.name, target.provider)) return { ok: true };
    }
    if (deps.now() >= deadline) return fail("not_confirmed");
    await deps.sleep(POLL_MS);
  }
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ----------------------------------------------------------------------------------------------- */

const STATUS: Readonly<Record<OpencodeModelFailure, number>> = {
  unavailable: 503, not_opencode: 409, busy: 409, dialog_open: 409, not_ready: 409, unknown_model: 422,
  dialog_not_opened: 502, model_not_found: 502, not_confirmed: 502, timeout: 502,
};

const failure = (code: OpencodeModelFailure): Response => jsonResponse({ error: { code, message: MESSAGES[code] } }, STATUS[code]);

const NONE: OpencodeModelCatalog = { available: false, providers: [], current: null };

/** A screen read, bounded: the drive reads it many times. */
const READ_MS = 2_000;

function paneDeps(paneId: string): DriveDeps {
  return {
    read: async () => (await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: READ_MS })).text,
    keys: (keys) => paneSendKeys(paneId, keys),
    type: (typed) => paneSendText(paneId, typed),
    sleep: Bun.sleep,
    now: Date.now,
  };
}

export interface OpencodeModelRouteOptions {
  /** runs the switch in the pane's turn, after a message in flight (core's serialize) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** the drive's deps for a pane (tests) */
  deps?: (paneId: string) => DriveDeps;
}

/** The answer for a model route, or null when the path is not one. */
export async function handleOpencodeModelRequest(request: Request, url: URL, pathname: string, options: OpencodeModelRouteOptions = {}): Promise<Response | null> {
  if (pathname === "/api/agent/models") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const agent = url.searchParams.get("agent");
    if (!agent) return badRequest("missing_agent", "agent query parameter is required");
    if (agent !== "opencode") return jsonResponse(NONE);
    const providers = await opencodeModelCatalog();
    return jsonResponse(providers === null ? NONE : { available: true, providers, current: null } satisfies OpencodeModelCatalog);
  }

  if (pathname === "/api/pane/opencode-models") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    try {
      const pane = await paneGet(paneId);
      if (resolveAgent(pane).agent !== "opencode") return jsonResponse(NONE);
      const providers = await opencodeModelCatalog();
      if (providers === null) return jsonResponse(NONE);
      const screen = await paneRead({ paneId, source: "visible", format: "text", timeoutMs: READ_MS }).then((read) => read.text, () => null);
      return jsonResponse({ available: true, providers, current: screen === null ? null : footerModel(screen, providers) } satisfies OpencodeModelCatalog);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/opencode-model") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ pane_id?: unknown; provider_id?: unknown; model_id?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (typeof payload.provider_id !== "string" || payload.provider_id.length === 0 || typeof payload.model_id !== "string" || payload.model_id.length === 0) {
      return badRequest("missing_model", "provider_id and model_id are required");
    }
    const paneId = payload.pane_id;
    const providers = await opencodeModelCatalog();
    if (providers === null) return failure("unavailable");
    const provider = providers.find((each) => each.id === payload.provider_id);
    const model = provider?.models.find((each) => each.id === payload.model_id);
    if (provider === undefined || model === undefined) return failure("unknown_model");
    const serialize = options.serialize ?? (<T>(_pane: string, task: () => Promise<T>) => task());
    try {
      return await serialize(paneId, async () => {
        const pane = await paneGet(paneId);
        if (resolveAgent(pane).agent !== "opencode") return failure("not_opencode");
        if (pane.agent_status === "working" || pane.agent_status === "blocked") return failure("busy");
        const result = await driveModelDialog((options.deps ?? paneDeps)(paneId), { name: model.name, provider: provider.name });
        if (!result.ok) return failure(result.code);
        return jsonResponse({ ok: true, model: { provider_id: provider.id, model_id: model.id } });
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return null;
}
