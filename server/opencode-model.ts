/**
 * The model of an OpenCode 1.x pane, listed and chosen from the browser.
 *
 * OpenCode 1.x keeps the model a TUI uses in the TUI itself (its local state, sent with each
 * prompt), and a TUI listens on no port, so nothing over HTTP can set it. What can: the TUI's own
 * "Select model" dialog, driven with keys as a person would (`driveModelDialog`). The list comes
 * from the OpenCode HTTP source (opencode-v1.ts, OVIS_OPENCODE_URL or
 * OVIS_OPENCODE_SERVE=1): any 1.x server answers GET /config/providers from the same
 * configuration and credentials the TUI reads, `{ providers: [{ id, name, models: { <id>: { name,
 * status, release_date } } }], default }`. Without that source nothing here is offered.
 *
 * The dialog, as drawn by OpenCode 1.x (packages/tui component/dialog-model.tsx, ui/dialog-select.tsx;
 * fixtures opencode-model-1.19-*): a panel over the screen whose first row is the title, then `esc`
 * at its right edge four columns in; a search line two rows down; then the rows. Typing filters
 * them fuzzily and moves the cursor to the first; a filtered row is `<model name>[ (Favorite)]`,
 * then the provider's name at the right. The cursor is drawn only as the row's background, in the
 * theme's primary colour, so the row under it is the one whose background differs from the panel's
 * (read off the title row): no theme's colour is assumed. `●` marks the model in use. Every dialog
 * of the TUI (ui/dialog.tsx) is that panel over a dimmed backdrop, with a header ending in `esc`,
 * which is how one of any title is seen (`dialogOnScreen`). The prompt is a box after a `┃` border,
 * ended by a `╹▀▀…` row: a padding row, the draft, a padding row, and its footer,
 * `<agent> · <model name> <provider name>[ · <variant>]` (component/prompt/index.tsx).
 */
import type { OpencodeModelCatalog, OpencodeModelFailure, OpencodeProvider } from "../shared/protocol.ts";
import { paneGet, paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { opencodeV1Configured, opencodeV1Endpoint, opencodeV1Get, type OpencodeV1Endpoint } from "./opencode-v1.ts";
import { resolveAgent } from "./pane-context.ts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/* -------------------------------------------------------------------------------------------------
 * The list
 * ----------------------------------------------------------------------------------------------- */

/** A provider list is asked again after this. */
export const OPENCODE_MODEL_CATALOG_MS = 60_000;
/** A list read before answers for a failed read only while it is younger than this. */
export const OPENCODE_MODEL_STALE_MS = 10 * 60_000;
/** A provider list larger than this is not read. */
const MAX_PROVIDERS_BYTES = 8 * 1024 * 1024;
/** A provider's or a model's id or name longer than this is not listed: the name is typed into the TUI. */
export const OPENCODE_MODEL_MAX_NAME = 200;

/**
 * What no name typed into the pane may hold: a control character (an Escape or a carriage return
 * would be a key to the TUI), a format character (bidi overrides, zero-width marks) or a line or
 * paragraph separator.
 */
const UNTYPEABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Whether `value` can be typed into the pane's TUI and compared with what it draws: short, and no key or invisible mark in it. */
export const typeableName = (value: string): boolean => value.length > 0 && value.length <= OPENCODE_MODEL_MAX_NAME && !UNTYPEABLE.test(value);

/** A model's reasoning levels kept from the list: at most this many, each at most this long. */
const OPENCODE_MODEL_MAX_VARIANTS = 16;
const OPENCODE_MODEL_MAX_VARIANT = 40;

/** a string field as the list keeps it, trimmed; null when absent, empty, or not typeable */
const listedText = (value: unknown): string | null | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return typeableName(value) ? value.trim() : null;
};

/**
 * The providers of a GET /config/providers answer, as the TUI's dialog lists them: OpenCode's own
 * provider first, then by name; in each, models newest first, then by name. A deprecated model is
 * not listed, nor OpenCode's `-nano` ones, which the dialog shows disabled. Neither is a provider or
 * model whose id or name holds a control or format character or is longer than
 * OPENCODE_MODEL_MAX_NAME: names are typed into the pane. Null when it is not that answer.
 */
export function opencodeProviders(value: unknown): OpencodeProvider[] | null {
  const body = record(value);
  if (!Array.isArray(body.providers)) return null;
  const providers: OpencodeProvider[] = [];
  for (const raw of body.providers) {
    const provider = record(raw);
    const id = listedText(provider.id);
    const providerName = listedText(provider.name);
    if (typeof id !== "string" || providerName === null) continue;
    const models = Object.entries(record(provider.models)).flatMap(([key, rawModel]) => {
      const model = record(rawModel);
      const modelId = listedText(key);
      const name = listedText(model.name);
      if (typeof modelId !== "string" || name === null || model.status === "deprecated" || (id === "opencode" && modelId.includes("-nano"))) return [];
      // the reasoning levels it offers, as the footer draws one: typeable keys only, a short list
      const variants = Object.keys(record(model.variants)).flatMap((key) => {
        const level = listedText(key);
        return typeof level === "string" && level.length <= OPENCODE_MODEL_MAX_VARIANT && !level.includes(" ") ? [level] : [];
      }).slice(0, OPENCODE_MODEL_MAX_VARIANTS);
      return [{ id: modelId, name: name ?? modelId, release: typeof model.release_date === "string" ? model.release_date : "", variants }];
    });
    models.sort((a, b) => a.release !== b.release ? (a.release < b.release ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (models.length > 0) providers.push({ id, name: providerName ?? id, models: models.map(({ id: modelId, name, variants }) => variants.length > 0 ? { id: modelId, name, variants } : { id: modelId, name }) });
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
 * not configured or not to be had now. A failed read answers the list read before, while it is
 * younger than OPENCODE_MODEL_STALE_MS.
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
    return providers ?? (cached?.key === key && clock() - cached.at < OPENCODE_MODEL_STALE_MS ? cached.providers : null);
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

/** The prompt box's left border (component/prompt/index.tsx), and the row under its last that ends it. */
const BORDER = "┃";
const BOX_END = "╹";

/** A run of columns of one row drawn on one background: `from` to `to`, `to` excluded. */
interface Run { from: number; to: number; bg: string }

function backgroundRuns(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  for (let column = 0; column < cells.length; column++) {
    const last = runs.at(-1);
    if (last !== undefined && last.bg === cells[column]!.bg) last.to = column + 1;
    else runs.push({ from: column, to: column + 1, bg: cells[column]!.bg });
  }
  return runs;
}

/** The widths OpenCode 1.x's dialog frame takes (ui/dialog.tsx: medium, large, xlarge), each at most the screen less two columns. */
const DIALOG_WIDTHS = [60, 88, 116];
/** A dialog's header (ui/dialog.tsx and every dialog in OpenCode 1.x's TUI): its title, then `esc` (or `esc/enter`) at the right. */
const DIALOG_HEADER = /\S {2,}esc(?:\/[a-z]+)?$/u;
/** The same header in a read without colours: the backdrop leaves what is under the panel drawn at its sides. */
const PLAIN_DIALOG_HEADER = /\S {2,}esc(?:\/[a-z]+)?(?= {2,}|$)/u;

/**
 * Whether any dialog of OpenCode 1.x's TUI is open, whatever its title: one row whose panel (a run of
 * columns on a background apart from the backdrop at both its sides) reads as a dialog's header, or
 * the dialog frame itself, a panel of one of the frame's widths, centred, three rows or more. A read
 * without colours is checked for the header only. The prompt's own box, drawn after its `┃`, is not a frame.
 */
export function dialogOnScreen(screen: string): boolean {
  const rows = screenLines(screen).map(ansiCells);
  const coloured = rows.some((row) => row.some((cell) => cell.bg !== "default"));
  if (!coloured) return rows.some((row) => PLAIN_DIALOG_HEADER.test(cellText(row, 0, row.length).trimEnd()));
  let frames = new Map<string, number>();
  for (const row of rows) {
    const seen = new Map<string, number>();
    const runs = backgroundRuns(row);
    for (let index = 1; index < runs.length - 1; index++) {
      const run = runs[index]!;
      const span = run.to - run.from;
      if (span < 20) continue;
      if (DIALOG_HEADER.test(cellText(row, run.from, run.to).trim())) return true;
      if (row[run.from - 1]?.ch === BORDER) continue;
      const centred = Math.abs(run.from - (row.length - span) / 2) <= 1;
      if (!centred || !DIALOG_WIDTHS.some((width) => Math.min(width, row.length - 2) === span)) continue;
      const key = `${run.from}:${run.to}:${run.bg}`;
      const count = (frames.get(key) ?? 0) + 1;
      if (count >= 3) return true;
      seen.set(key, count);
    }
    frames = seen;
  }
  return false;
}

/** Whether a model dialog, the variant list or any other dialog is open. */
export const anyDialog = (screen: string): boolean => parseSelectDialog(screen) !== null || dialogOnScreen(screen);

/** The prompt box as drawn: what is typed into it and what its footer says. */
export interface PromptBox {
  /** the draft's rows as drawn, the box's padding left out: the placeholder while nothing is typed */
  draft: string[];
  /** the footer's words after the agent, `<model name> <provider name>[ · <variant>]`; "" when it names no model (a shell prompt) */
  footer: string;
}

/** The footer's agent, ` · `, then the rest: the agent may be two words (`Build auto`) but holds no `·`. */
const FOOTER_WORDS = /^(\S[^·]*?) · (.+)$/u;

/**
 * The prompt box on the screen, or null when none is (another screen is open). It is found by where
 * it is drawn, not by what its rows say, so a transcript line drawn after a `┃` is never read as it:
 * the bottom-most row that starts with `╹` under a row that starts with `┃` in the same column ends
 * the box, whatever pair a transcript draws above it or `┃` row is drawn below it (a theme with no
 * element background draws that row blank, and no pair is drawn: then the bottom-most `┃` row is
 * the footer). The box's rows are those with `┃` in that column above it: a padding row, the draft,
 * a padding row and the footer, read up to the end of the box's background.
 */
export function promptBox(screen: string): PromptBox | null {
  const rows = screenLines(screen).map(ansiCells);
  const start = (row: readonly Cell[]): number => row.findIndex((cell) => cell.ch !== " " && cell.ch !== "");
  let footer = -1;
  let column = -1;
  for (let index = rows.length - 1; index > 0 && footer < 0; index--) {
    const at = start(rows[index]!);
    if (at >= 0 && rows[index]![at]!.ch === BOX_END && rows[index - 1]![at]?.ch === BORDER) { footer = index - 1; column = at; }
  }
  for (let index = rows.length - 1; index >= 0 && footer < 0; index--) {
    const at = start(rows[index]!);
    if (at >= 0 && rows[index]![at]!.ch === BORDER) { footer = index; column = at; }
  }
  if (footer < 0) return null;
  let top = footer;
  while (top > 0 && rows[top - 1]![column]?.ch === BORDER) top -= 1;
  if (footer - top < 3) return null;
  /** a row's words inside the box: from the column after the border's padding to where the box's background ends */
  const inside = (row: readonly Cell[]): string => {
    const bg = row[column + 1]?.bg;
    let end = column + 1;
    while (end < row.length && row[end]!.bg === bg) end += 1;
    return cellText(row, column + 3, end).trimEnd();
  };
  const words = FOOTER_WORDS.exec(inside(rows[footer]!).trim().split(/ {3,}/u)[0]!);
  return {
    draft: rows.slice(top + 1, footer - 1).map(inside),
    footer: words === null ? "" : collapse(words[2]!),
  };
}

/** What the prompt's footer says after the agent ("" when it names no model), or null when no prompt is on the screen. */
export function promptFooter(screen: string): string | null {
  return promptBox(screen)?.footer ?? null;
}

/** Whether a footer's words name this model: the name, then the provider's name (cut at the pane's edge, perhaps), then nothing or the variant. */
export function footerNames(footer: string, name: string, provider: string): boolean {
  if (!footer.startsWith(`${name} `)) return false;
  const rest = footer.slice(name.length + 1);
  if (rest === provider || rest.startsWith(`${provider} · `)) return true;
  return rest.length > 0 && !rest.includes(" · ") && provider.startsWith(rest);
}

/** Whether a footer is the start of a listed model's name and provider as the footer draws them: a pane's edge cut it. */
export function cutListedModel(footer: string, providers: readonly OpencodeProvider[]): boolean {
  const words = collapse(footer);
  return providers.some((provider) => provider.models.some((model) => {
    const drawn = `${collapse(model.name)} ${collapse(provider.name)}`;
    return drawn.length > words.length && drawn.startsWith(words);
  }));
}

/** How a model is told apart on the screen: its name and its provider's, as the TUI draws them. */
const shownAs = (name: string, provider: string): string => `${collapse(name)}\0${collapse(provider)}`;

/** How many models of the list are drawn as each name and provider: a pair drawn for two cannot be told apart on the screen. */
export function shownCounts(providers: readonly OpencodeProvider[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const provider of providers) for (const model of provider.models) {
    const key = shownAs(model.name, provider.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Whether this model is the only one of the list drawn with its name and provider. */
export const shownOnce = (providers: readonly OpencodeProvider[], name: string, provider: string): boolean => shownCounts(providers).get(shownAs(name, provider)) === 1;

/**
 * The model the footer names, the longest name and provider when several fit; null when none does,
 * when two fit equally, or when the one that fits shares its name and provider with another model.
 */
export function footerModel(screen: string, providers: readonly OpencodeProvider[]): { provider_id: string; model_id: string; variant?: string } | null {
  const footer = promptFooter(screen);
  if (!footer) return null;
  const counts = shownCounts(providers);
  let best: { provider_id: string; model_id: string; key: string; length: number; whole: boolean; variant: string | null }[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!footerNames(footer, model.name, provider.name)) continue;
      const rest = footer.slice(model.name.length + 1);
      const whole = rest === provider.name || rest.startsWith(`${provider.name} · `);
      const length = model.name.length + provider.name.length;
      // the reasoning level the footer draws after the provider's name (` · high`), when it draws one and
      // the model offers it: a level the pane's edge cut (`· hi`) is not one, so no level is read
      const drawn = rest.startsWith(`${provider.name} · `) ? rest.slice(provider.name.length + 3).trim() || null : null;
      const variant = drawn !== null && model.variants?.includes(drawn) ? drawn : null;
      const found = { provider_id: provider.id, model_id: model.id, key: shownAs(model.name, provider.name), length, whole, variant };
      const top = best[0];
      if (top === undefined || (whole && !top.whole) || (whole === top.whole && length > top.length)) best = [found];
      else if (whole === top.whole && length === top.length) best.push(found);
    }
  }
  if (best.length !== 1 || counts.get(best[0]!.key) !== 1) return null;
  const { provider_id, model_id, variant } = best[0]!;
  return variant === null ? { provider_id, model_id } : { provider_id, model_id, variant };
}

/**
 * Whether a filtered row is this model: `<name>[ (Favorite)]` and the provider's name at the right.
 * "exact" when the name is whole; "prefix" when the pane's width cut it and what is left starts it.
 * A row cut short (ending in `…`) whose visible part is at least as long as the name is a longer
 * name's: it is not this model, so it is neither chosen nor counted as a second row alike.
 */
export function rowMatch(row: string, name: string, provider: string): "exact" | "prefix" | null {
  if (!row.endsWith(` ${provider}`)) return null;
  const left = row.slice(0, row.length - provider.length - 1).trimEnd();
  const cut = left.endsWith("…") ? left.slice(0, -1) : null;
  if (cut !== null && cut.length >= name.length) return null;
  if (left.startsWith(name)) {
    const rest = left.slice(name.length);
    return rest === "" || " (Favorite)".startsWith(rest) ? "exact" : null;
  }
  const shown = cut ?? left;
  return shown.length >= 4 && name.startsWith(shown) ? "prefix" : null;
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
/** After the closing Escape, the dialog is gone within this, or it is said to be still open. */
export const OPENCODE_MODEL_CLOSE_MS = 500;
/**
 * After a write to the pane that failed (herdr may time out once the keys are delivered), what they
 * do is watched for this long, the budget left permitting, and never less than LATE_MIN_MS: a dialog
 * they open is drawn within it.
 */
export const OPENCODE_MODEL_LATE_MS = 1_000;
const LATE_MIN_MS = 500;
/** After the footer shows the model, the screen is read once more this much later: a variant list may open after it. */
const SETTLE_MS = 150;
/** The most one read or one write to the pane may take: never more than the budget left, never less than IO_MIN_MS. */
const IO_MS = 2_000;
const IO_MIN_MS = 100;
/** Down presses before the row is given up on. */
export const OPENCODE_MODEL_MAX_MOVES = 80;

/** What driving the TUI takes, apart so the walk can be tested with a screen that answers keys. Each call is bounded by `timeoutMs`. */
export interface DriveDeps {
  /** the pane's visible screen, with its colours */
  read(timeoutMs: number): Promise<string>;
  keys(keys: string[], timeoutMs: number): Promise<void>;
  type(text: string, timeoutMs: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type DriveResult =
  | { ok: true; /** a variant list that opened after the footer showed the model did not close with Escape */ dialog_left_open?: true }
  | { ok: false; code: OpencodeModelFailure; message: string; /** the closing Escape did not close the dialog */ dialog_left_open?: true };

const MESSAGES: Readonly<Record<OpencodeModelFailure, string>> = {
  unavailable: "the OpenCode HTTP source is not configured or does not answer",
  not_opencode: "the pane does not run OpenCode",
  busy: "OpenCode is working or waiting for an answer; switch the model once it is idle",
  dialog_open: "a dialog is already open in OpenCode",
  not_ready: "OpenCode's prompt is not on the screen",
  unknown_model: "OpenCode does not offer that model",
  ambiguous_model: "another model OpenCode offers has the same name and provider, so its row cannot be told apart; choose it in the terminal",
  aborted: "the request was given up before its turn",
  pane_error: "the pane could not be read or written",
  dialog_not_opened: "OpenCode's model dialog did not open (ctrl+x m)",
  model_not_found: "the model's row was not found in OpenCode's model dialog",
  not_confirmed: "OpenCode's prompt did not show the new model",
  timeout: "OpenCode did not answer in time",
};

/** The key of the row under the cursor where it is drawn: a move that changes neither did not land. */
const cursorKey = (dialog: SelectDialog): string => `${dialog.highlighted}\0${dialog.rows[dialog.highlighted]?.text ?? ""}`;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, OPENCODE_MODEL_MAX_NAME);
const quoted = (value: string): string => JSON.stringify(value.slice(0, OPENCODE_MODEL_MAX_NAME));

/**
 * Picks `target` in the TUI's model dialog: ctrl+x m (the dialog's default keys), the name typed
 * into its search, Down until the row under the cursor is that name with that provider, Enter, then
 * the footer read back. A variant list that opens after the pick is closed with Escape: OpenCode then
 * stores no variant for the model, which runs with none, and asks again the next time it is picked
 * (component/dialog-model.tsx, dialog-variant.tsx); once the footer shows the model the screen is
 * read once more, SETTLE_MS later, for a variant list that opened late. Refuses before any key when a
 * name holds a key or an invisible mark, any dialog is open, the prompt's footer is not on the screen
 * or names no model, or `signal` was aborted. More than one row that reads as the model (two cut
 * short by a narrow pane alike) is not chosen between; only the rows in view are compared, so a row
 * that reads alike but is scrolled out of view below the one chosen is not seen (a known limit).
 * Once the first key is sent, every failure, a pane that cannot be read or written included, sends
 * one Escape when a dialog is drawn or the screen cannot be read, and waits up to
 * OPENCODE_MODEL_CLOSE_MS for the dialog to go; one still open is said (`dialog_left_open`). After a
 * write that failed, its keys may still land: until OPENCODE_MODEL_LATE_MS after it (the budget
 * permitting) nothing is said to be drawn and no Escape is sent, so they land in the dialog and not
 * in the prompt, and an Enter that failed but whose pick the footer then shows is a switch made. An
 * Enter that failed and still has not landed then gets no Escape at all, whatever the screen shows
 * or if it cannot be read (`dialog_left_open`): an Enter that lands even later only picks the model
 * list's highlighted row, where one after an Escape would send the prompt's draft. At most two
 * Escapes are sent in all: one for a variant list, one to close (or to a variant list that opened
 * late). When ctrl+x m opened no
 * dialog, an `m` it left at the end of the draft is taken back with one Backspace, and any other
 * change to the draft is said and left alone.
 */
export async function driveModelDialog(deps: DriveDeps, target: { name: string; provider: string }, budgetMs = OPENCODE_MODEL_DRIVE_MS, signal?: AbortSignal): Promise<DriveResult> {
  const deadline = deps.now() + budgetMs;
  const io = (): number => Math.max(IO_MIN_MS, Math.min(IO_MS, deadline - deps.now()));
  type Failed = Extract<DriveResult, { ok: false }>;
  const refuse = (code: OpencodeModelFailure, detail?: string): Failed => ({ ok: false, code, message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code] });
  if (!typeableName(target.name) || !typeableName(target.provider)) return refuse("unknown_model", "its name holds a character that cannot be typed into the pane");
  let first: string;
  try { first = await deps.read(io()); } catch (error) { return refuse("pane_error", reason(error)); }
  if (anyDialog(first)) return refuse("dialog_open");
  const before = promptBox(first);
  if (before === null) return refuse("not_ready");
  if (before.footer === "") return refuse("not_ready", "its footer names no model");
  if (signal?.aborted) return refuse("aborted");

  /** how long the keys of a failed write are waited on: the budget left, at most LATE_MS, never less than LATE_MIN_MS */
  const lateMs = (): number => Math.max(LATE_MIN_MS, Math.min(OPENCODE_MODEL_LATE_MS, deadline - deps.now()));
  /** until when the keys of a write that failed may still land, measured from that write; 0 while none failed */
  let lateUntil = 0;
  const failed = (): void => { lateUntil = Math.max(lateUntil, deps.now() + lateMs()); };
  const send = async (keys: string[]): Promise<void> => {
    try { await deps.keys(keys, io()); } catch (error) { failed(); throw error; }
  };
  const typeText = async (text: string): Promise<void> => {
    try { await deps.type(text, io()); } catch (error) { failed(); throw error; }
  };
  /** whether the screen shows no dialog within OPENCODE_MODEL_CLOSE_MS (the cleanup has a budget of its own) */
  const gone = async (): Promise<boolean> => {
    const end = deps.now() + OPENCODE_MODEL_CLOSE_MS;
    for (;;) {
      const after = await deps.read(IO_MS).catch(() => null);
      if (after !== null && !anyDialog(after)) return true;
      if (deps.now() >= end) return false;
      await deps.sleep(POLL_MS);
    }
  };
  const STILL_OPEN = "a dialog is still open in OpenCode after Escape; close it in the terminal";
  /**
   * A dialog drawn, or a screen that cannot be read, gets one Escape, then is waited on: null when
   * none is left open. After a write that failed, its keys may land until lateUntil: that is waited
   * out before the Escape, a dialog drawn or not, so they fall into the dialog, where they do no
   * harm, and not into the prompt's draft once the dialog is closed (a late Enter would send it).
   */
  const close = async (): Promise<string | null> => {
    while (deps.now() < lateUntil) await deps.sleep(Math.min(POLL_MS, lateUntil - deps.now()));
    const screen = await deps.read(IO_MS).catch(() => null);
    if (screen !== null && !anyDialog(screen)) return null;
    await deps.keys(["esc"], IO_MS).catch(() => undefined);
    return await gone() ? null : STILL_OPEN;
  };
  const fail = async (code: OpencodeModelFailure, detail?: string): Promise<DriveResult> => {
    const left = await close();
    const result = refuse(code, [detail, left].filter((part) => part).join("; ") || undefined);
    return left === null ? result : { ...result, dialog_left_open: true };
  };
  /** the first answer `test` finds on the screen within `ms` (and the whole budget), or null */
  const until = async <T>(ms: number, test: (screen: string) => T | null): Promise<T | null> => {
    const end = Math.min(deadline, deps.now() + ms);
    for (;;) {
      const found = test(await deps.read(io()));
      if (found !== null) return found;
      if (deps.now() >= end) return null;
      await deps.sleep(POLL_MS);
    }
  };
  const modelDialog = (screen: string): SelectDialog | null => {
    const dialog = parseSelectDialog(screen);
    return dialog?.title === "Select model" ? dialog : null;
  };
  /** ctrl+x m opened no dialog: what it did to the draft instead, put back when that is one `m` at its end */
  const notOpened = async (): Promise<DriveResult> => {
    const screen = await deps.read(io());
    if (anyDialog(screen)) return fail("dialog_not_opened", "a dialog opened late, or another one did");
    const after = promptBox(screen);
    if (after === null) return refuse("dialog_not_opened", "the prompt is no longer on the screen; check it in the terminal");
    const was = before.draft.join("\n");
    const is = after.draft.join("\n");
    if (is === was) return refuse("dialog_not_opened", "the prompt's draft is as it was");
    // one key adds one character: a draft that is now just "m" was empty (its placeholder was drawn)
    if (is !== `${was}m` && !(is === "m" && before.draft.length === 1)) return refuse("dialog_not_opened", "the prompt's draft changed and was left as it is; check it in the terminal");
    await send(["backspace"]);
    const restored = await until(STEP_MS, (shown) => !anyDialog(shown) && promptBox(shown)?.draft.join("\n") === was ? true : null);
    return refuse("dialog_not_opened", restored ? "the \"m\" it typed into the prompt was taken back" : "it typed an \"m\" at the end of the prompt's draft and could not take it back; check it in the terminal");
  };

  try {
    await send(["ctrl+x", "m"]);
    if (await until(OPEN_MS, modelDialog) === null) return await notOpened();

    await typeText(target.name);
    const wanted = collapse(target.name);
    let dialog = await until(STEP_MS, (screen) => {
      const shown = modelDialog(screen);
      // a name wider than the search line scrolls it: its end is drawn, where the cursor is
      const typed = shown !== null && (shown.query === wanted || (shown.query.length >= 8 && wanted.endsWith(shown.query)));
      return shown !== null && typed && (shown.rows.length === 0 || shown.highlighted >= 0) ? shown : null;
    });
    if (dialog === null) return await fail(deps.now() >= deadline ? "timeout" : "model_not_found");

    const seen = new Set<string>();
    for (let moves = 0; ;) {
      if (dialog.rows.length === 0) return await fail("model_not_found");
      const matches = dialog.rows.map((row) => rowMatch(row.text, target.name, target.provider));
      const found = matches.flatMap((match, index) => match !== null ? [index] : []);
      // two rows that both read as it (a narrow pane cuts names short alike): neither is chosen.
      // Only the rows in view are compared: one alike scrolled out of view is not seen (a known limit)
      if (found.length > 1) return await fail("model_not_found", "more than one row reads as this model; choose it in the terminal");
      if (found[0] !== undefined && found[0] === dialog.highlighted) break;
      // the row is in view below the cursor: straight to it; otherwise one row on, which scrolls the list
      const step = found[0] !== undefined && found[0] > dialog.highlighted ? found[0] - dialog.highlighted : 1;
      const at = cursorKey(dialog);
      // the list wraps from its last row to its first: a cursor seen before has been all the way round
      if (seen.has(at) || moves + step > OPENCODE_MODEL_MAX_MOVES) return await fail("model_not_found");
      seen.add(at);
      await send(Array.from({ length: step }, () => "down"));
      moves += step;
      const moved = await until(STEP_MS, (screen) => {
        const shown = modelDialog(screen);
        return shown !== null && shown.highlighted >= 0 && cursorKey(shown) !== at ? shown : null;
      });
      if (moved === null) return await fail(deps.now() >= deadline ? "timeout" : "model_not_found");
      dialog = moved;
    }

    // an Enter whose write failed may still land: its pick is looked for while its keys would be
    let enterError: unknown = null;
    let enterFailed = false;
    try { await send(["enter"]); } catch (error) { enterFailed = true; enterError = error; }
    const end = enterFailed ? lateUntil : deadline;
    let variantClosed = false;
    let shown: string | null = null;
    /** the footer shows the model: a variant list that opens a moment after it is closed too */
    const settled = async (): Promise<DriveResult> => {
      await deps.sleep(SETTLE_MS);
      const screen = await deps.read(IO_MS).catch(() => null);
      if (screen === null || parseSelectDialog(screen)?.title !== "Select variant") return { ok: true };
      await deps.keys(["esc"], IO_MS).catch(() => undefined);
      return await gone() ? { ok: true } : { ok: true, dialog_left_open: true };
    };
    /**
     * An Enter that failed and has not landed: no Escape is sent, whatever the screen shows, since an
     * Enter landing after one would send the prompt's draft. What is left is said from one more read.
     */
    const leftOpen = async (detail: string): Promise<DriveResult> => {
      const screen = await deps.read(IO_MS).catch(() => null);
      if (screen !== null && !anyDialog(screen)) {
        // the Enter landed in this last moment: the footer says whether it switched
        const footer = promptFooter(screen);
        if (footer !== null && footerNames(footer, target.name, target.provider)) return await settled();
        return refuse("pane_error", `${detail}; the model was not changed`);
      }
      const list = screen === null ? null : modelDialog(screen);
      const row = list?.rows[list.highlighted];
      const onTarget = row !== undefined && rowMatch(row.text, target.name, target.provider) !== null;
      const what = screen === null
        ? "the pane could not be read, and OpenCode's model list may still be open: check it in the terminal"
        : list === null ? "a dialog is still open in OpenCode: close it in the terminal with Escape"
        : onTarget ? `OpenCode's model list is still open on ${target.name}: press Enter there to pick it, or Escape`
        : "OpenCode's model list is still open, on another row: press Escape there";
      return { ...refuse("pane_error", `${detail}; ${what}`), dialog_left_open: true };
    };
    for (;;) {
      const screen = await deps.read(io()).catch((error: unknown) => {
        if (!enterFailed) throw error;
        return null;
      });
      const open = screen === null ? null : parseSelectDialog(screen);
      if (open?.title === "Select variant" && !variantClosed) {
        await send(["esc"]);
        variantClosed = true;
      } else if (screen !== null && open === null && !dialogOnScreen(screen)) {
        const footer = promptFooter(screen);
        if (footer !== null && footerNames(footer, target.name, target.provider)) return await settled();
        shown = footer;
      }
      if (deps.now() >= end) {
        // an Enter that failed and has shown no sign of landing (no variant list, no footer naming the
        // model) may land later still: after an Escape it would send the prompt's draft, so none is sent.
        // A model list it lands in later only picks the highlighted row; the screen is read once more to
        // say what is left open
        if (enterFailed && !variantClosed) return await leftOpen(reason(enterError));
        if (enterFailed) return await fail("pane_error", reason(enterError));
        return await fail("not_confirmed", shown ? `its footer shows ${quoted(shown)}` : undefined);
      }
      await deps.sleep(POLL_MS);
    }
  } catch (error) {
    return await fail("pane_error", reason(error));
  }
}

/* -------------------------------------------------------------------------------------------------
 * The routes
 * ----------------------------------------------------------------------------------------------- */

const STATUS: Readonly<Record<OpencodeModelFailure, number>> = {
  unavailable: 503, not_opencode: 409, busy: 409, dialog_open: 409, not_ready: 409, aborted: 409,
  unknown_model: 422, ambiguous_model: 422,
  pane_error: 502, dialog_not_opened: 502, model_not_found: 502, not_confirmed: 502, timeout: 502,
};

const failure = (code: OpencodeModelFailure, message = MESSAGES[code], extra: { dialog_left_open?: true } = {}): Response =>
  jsonResponse({ error: { code, message, ...extra } }, STATUS[code]);

const NONE: OpencodeModelCatalog = { available: false, providers: [], current: null };

/** A screen read for the list's `current`, bounded. */
const READ_MS = 2_000;

function paneDeps(paneId: string): DriveDeps {
  return {
    read: async (timeoutMs) => (await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs })).text,
    keys: (keys, timeoutMs) => paneSendKeys(paneId, keys, undefined, undefined, timeoutMs),
    type: (typed, timeoutMs) => paneSendText(paneId, typed, undefined, undefined, timeoutMs),
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
      const current = screen === null ? null : footerModel(screen, providers);
      const words = screen === null ? null : promptFooter(screen);
      // "unmatched" only when the footer names a model the list lacks: then the pill must not keep the last
      // one read. A footer a narrow pane cut inside a listed model's name and provider is only unreadable
      const footer = current !== null ? "model" : words && !cutListedModel(words, providers) ? "unmatched" : "unreadable";
      return jsonResponse({ available: true, providers, current, footer } satisfies OpencodeModelCatalog);
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
    // the list keeps no name a key could hide in (opencodeProviders); checked again before any is typed
    if (!typeableName(model.name) || !typeableName(provider.name)) return failure("unknown_model");
    if (!shownOnce(providers, model.name, provider.name)) return failure("ambiguous_model");
    const serialize = options.serialize ?? (<T>(_pane: string, task: () => Promise<T>) => task());
    try {
      return await serialize(paneId, async () => {
        // given up while it waited its turn: nothing is read or sent for it
        if (request.signal.aborted) return failure("aborted");
        const pane = await paneGet(paneId);
        if (resolveAgent(pane).agent !== "opencode") return failure("not_opencode");
        if (pane.agent_status === "working" || pane.agent_status === "blocked") return failure("busy");
        const result = await driveModelDialog((options.deps ?? paneDeps)(paneId), { name: model.name, provider: provider.name }, OPENCODE_MODEL_DRIVE_MS, request.signal);
        if (!result.ok) {
          // one line per switch that failed or was refused, so a refusal, a failed drive and a switch the footer
          // did not confirm can be told apart: the code and the drive's own words (model and provider names,
          // what the footer showed), never a draft
          console.warn(`OpenCode model switch for ${paneId} failed or was refused: ${result.code}${result.dialog_left_open ? " (dialog left open)" : ""}: ${result.message}`);
          return failure(result.code, result.message, result.dialog_left_open ? { dialog_left_open: true } : {});
        }
        return jsonResponse({ ok: true, model: { provider_id: provider.id, model_id: model.id }, ...(result.dialog_left_open ? { dialog_left_open: true } : {}) });
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return null;
}
