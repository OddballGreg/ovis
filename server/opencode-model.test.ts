import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeModelCatalog, OpencodeProvider } from "../shared/protocol.ts";
import {
  ansiCells,
  dialogOnScreen,
  driveModelDialog,
  footerModel,
  footerNames,
  forgetOpencodeModels,
  handleOpencodeModelRequest,
  OPENCODE_MODEL_CATALOG_MS,
  OPENCODE_MODEL_MAX_NAME,
  OPENCODE_MODEL_STALE_MS,
  opencodeModelCatalog,
  opencodeModelOptions,
  opencodeProviders,
  parseSelectDialog,
  promptBox,
  promptFooter,
  rowMatch,
  type DriveDeps,
} from "./opencode-model.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", `opencode-model-1.19-${name}.ansi`), "utf8");

afterEach(() => {
  delete opencodeModelOptions.endpoint;
  delete opencodeModelOptions.read;
  delete opencodeModelOptions.now;
  forgetOpencodeModels();
});

describe("OpenCode's provider list", () => {
  it("lists providers as the TUI's dialog does: OpenCode first, then by name; models newest first", () => {
    const providers = opencodeProviders({
      providers: [
        { id: "zeta", name: "Zeta", models: { b: { name: "Bravo", release_date: "2026-01-01" }, a: { name: "Alpha", release_date: "2026-05-01" }, c: { name: "Charlie", release_date: "2026-05-01" } } },
        { id: "alpha", name: "Alpha Cloud", models: { old: { name: "Old", status: "deprecated" }, kept: {} } },
        { id: "opencode", name: "OpenCode Zen", models: { "tiny-nano": { name: "Tiny" }, big: { name: "Big" } } },
        { id: "empty", name: "Empty", models: { gone: { status: "deprecated" } } },
        { id: "", name: "No id", models: { x: {} } },
        "not a provider",
      ],
      default: { zeta: "a" },
    });
    expect(providers).toEqual([
      { id: "opencode", name: "OpenCode Zen", models: [{ id: "big", name: "Big" }] },
      { id: "alpha", name: "Alpha Cloud", models: [{ id: "kept", name: "kept" }] },
      { id: "zeta", name: "Zeta", models: [{ id: "a", name: "Alpha" }, { id: "c", name: "Charlie" }, { id: "b", name: "Bravo" }] },
    ]);
  });

  it("lists no provider or model whose id or name holds a key or an invisible mark, or is too long: names are typed into the pane", () => {
    const providers = opencodeProviders({
      providers: [
        { id: "p", name: "P", models: {
          ok: { name: "Fine 1.5 (preview)" },
          esc: { name: "Bad\u001b[2J" },
          cr: { name: "Bad\rName" },
          lf: { name: "Two\nlines" },
          del: { name: "Rub\u007fout" },
          c1: { name: "Csi\u009b2J" },
          bidi: { name: "Left\u202eright" },
          zw: { name: "Zero\u200bwidth" },
          sep: { name: "Line\u2028sep" },
          long: { name: "x".repeat(OPENCODE_MODEL_MAX_NAME + 1) },
          "id\u001bx": { name: "Hidden id" },
          "bare\rid": {},
          [`${"y".repeat(OPENCODE_MODEL_MAX_NAME)}`]: { name: "Longest id" },
        } },
        { id: "q", name: "Provider\u001b", models: { m: { name: "M" } } },
        { id: "r\u0000", name: "R", models: { m: { name: "M" } } },
      ],
    });
    expect(providers).toEqual([{ id: "p", name: "P", models: [{ id: "ok", name: "Fine 1.5 (preview)" }, { id: "y".repeat(OPENCODE_MODEL_MAX_NAME), name: "Longest id" }] }]);
  });

  it("reads nothing from an answer of another shape", () => {
    expect(opencodeProviders(null)).toBeNull();
    expect(opencodeProviders({ all: [] })).toBeNull();
    expect(opencodeProviders({ providers: [] })).toEqual([]);
  });

  it("asks once a minute, and answers the list read before when a read fails", async () => {
    let now = 1_000;
    let reads = 0;
    let answer: unknown = { providers: [{ id: "p", name: "P", models: { m: { name: "M" } } }] };
    opencodeModelOptions.now = () => now;
    opencodeModelOptions.endpoint = async () => ({ baseUrl: "http://127.0.0.1:1", authorization: null });
    opencodeModelOptions.read = async () => { reads += 1; return answer; };
    const [first, again] = await Promise.all([opencodeModelCatalog(), opencodeModelCatalog()]);
    expect(first?.[0]?.models).toEqual([{ id: "m", name: "M" }]);
    expect(again).toBe(first);
    expect(reads).toBe(1);
    now += OPENCODE_MODEL_CATALOG_MS - 1;
    await opencodeModelCatalog();
    expect(reads).toBe(1);
    now += 1;
    answer = null;
    expect(await opencodeModelCatalog()).toEqual(first);
    expect(reads).toBe(2);
    // a list read before answers a failed read only while it is younger than ten minutes
    now = 1_000 + OPENCODE_MODEL_STALE_MS;
    expect(await opencodeModelCatalog()).toBeNull();
    expect(reads).toBe(3);
  });

  it("offers nothing without the HTTP source", async () => {
    opencodeModelOptions.endpoint = async () => null;
    expect(await opencodeModelCatalog()).toBeNull();
  });
});

describe("OpenCode's model dialog on the screen", () => {
  it("reads the filtered rows and the row under the cursor from its background", () => {
    const first = parseSelectDialog(fixture("claude-first"))!;
    expect(first.title).toBe("Select model");
    expect(first.query).toBe("Claude");
    expect(first.rows.length).toBe(13);
    expect(first.highlighted).toBe(0);
    expect(first.rows[0]).toEqual({ text: "Claude Haiku 5.5 OpenCode Go", current: false });
    expect(first.rows.some((row) => row.current)).toBe(false);
    expect(first.rows[7]?.text).toBe("Agentic Chat (Claude Opus 4.8) (Favorite) GitLab Duo");
    const down = parseSelectDialog(fixture("claude-down3"))!;
    expect(down.highlighted).toBe(3);
    expect(down.rows[3]?.text).toBe("Agentic Chat (Claude Fable 5.1) GitLab Duo");
    // `●` on the model in use, here also the row under the cursor
    const current = parseSelectDialog(fixture("claude-current"))!;
    expect(current.highlighted).toBe(2);
    expect(current.rows[2]).toEqual({ text: "Agentic Chat (Claude Opus 5.5) GitLab Duo", current: true });
    expect(current.rows.filter((row) => row.current).length).toBe(1);
  });

  it("finds the cursor in any theme: the row drawn apart from the panel, not one colour", () => {
    const recoloured = fixture("claude-down3").replaceAll("48;2;250;178;131", "48;2;12;99;201").replaceAll("48;2;20;20;20", "48;2;240;240;240");
    expect(parseSelectDialog(recoloured)?.highlighted).toBe(3);
    const inverse = fixture("claude-first").replaceAll("\u001b[48;2;250;178;131m", "\u001b[7m");
    expect(parseSelectDialog(inverse)?.highlighted).toBe(0);
  });

  it("reads the variant list, a filter that matches nothing, and no dialog", () => {
    const variant = parseSelectDialog(fixture("variant"))!;
    expect(variant.title).toBe("Select variant");
    expect(variant.rows.map((row) => row.text)).toEqual(["Default", "low", "medium", "high", "xhigh", "max"]);
    expect(parseSelectDialog(fixture("no-results"))?.rows).toEqual([]);
    expect(parseSelectDialog(fixture("closed"))).toBeNull();
  });

  it("reads the model the prompt's footer names", () => {
    const providers: OpencodeProvider[] = [
      { id: "gitlab", name: "GitLab Duo", models: [{ id: "opus-5-5", name: "Agentic Chat (Claude Opus 5.5)" }, { id: "opus-5", name: "Agentic Chat (Claude Opus 5)" }, { id: "gpt-6-1-sol", name: "Agentic Chat (GPT-6.1 Sol)" }] },
      { id: "go", name: "OpenCode Go", models: [{ id: "haiku", name: "Claude Haiku 5.5" }] },
    ];
    expect(promptFooter(fixture("closed"))).toBe("Agentic Chat (Claude Opus 5.5) GitLab Duo");
    expect(footerModel(fixture("closed"), providers)).toEqual({ provider_id: "gitlab", model_id: "opus-5-5" });
    expect(footerModel(fixture("closed-after-variant"), providers)).toEqual({ provider_id: "gitlab", model_id: "gpt-6-1-sol" });
    expect(footerModel(fixture("closed"), providers.slice(1))).toBeNull();
    // the dialog covers the footer's model: the prompt is there, its model is not read
    expect(promptFooter(fixture("claude-first"))).toBe("");
    expect(footerModel(fixture("claude-first"), providers)).toBeNull();
  });

  it("reads the prompt box of a session by where it is drawn: its draft, and its footer under it", () => {
    // a session's view, with a three-line draft typed (ctrl+j) and not sent, before and after a switch
    const draft = ["Draft line one, not sent", "line two · with a dot", "line three"];
    expect(promptBox(fixture("session-draft"))).toEqual({ draft, footer: "Kimi K3.1 Pro OpenCode Go" });
    expect(promptBox(fixture("session-switched"))).toEqual({ draft, footer: "Agentic Chat (Claude Sonnet 5.5) GitLab Duo" });
    // a prompt with nothing typed draws its placeholder
    expect(promptBox(fixture("closed"))?.draft).toEqual(["Ask anything… \"What is the tech stack of this project?\""]);
    expect(promptBox(`${BASE}Sessions\r\n${BASE}  nothing here`)).toBeNull();
  });

  it("reads no transcript line drawn after a ┃ as the footer, nor a footer that names no model", () => {
    const rows = fixture("session-draft").split("\n");
    // a transcript line above the box, drawn after a ┃ and holding " · "
    const transcript = rows.slice();
    transcript[10] = `${BASE}  ┃  Build · Claude Haiku 5.5 OpenCode Go`;
    transcript[11] = `${BASE}  ┃`;
    expect(promptFooter(transcript.join("\n"))).toBe("Kimi K3.1 Pro OpenCode Go");
    // a footer with no " · " (a shell prompt names no model): the transcript line is still not read
    const shell = transcript.map((row) => row.includes("Kimi K3.1 Pro") ? `${BASE}  ┃  Shell` : row);
    expect(promptFooter(shell.join("\n"))).toBe("");
    // a theme that draws no row under the box: the bottom-most ┃ row is the footer
    const open = shell.map((row) => row.includes("╹") ? `${BASE}` : row);
    expect(promptFooter(open.join("\n"))).toBe("");
    expect(promptFooter(transcript.map((row) => row.includes("╹") ? `${BASE}` : row).join("\n"))).toBe("Kimi K3.1 Pro OpenCode Go");
    // the bottom-most ┃/╹ pair is the box: not one a transcript draws above it, nor a ┃ row under it
    const box = rows.findIndex((row) => row.includes("╹"));
    const quoted = [...rows.slice(0, 8), `${BASE}  ┃  Build · Claude Haiku 5.5 OpenCode Go`, `${BASE}  ╹${"▀".repeat(20)}`, ...rows.slice(10, box + 1), `${BASE}  ┃  status`, ...rows.slice(box + 1)];
    expect(promptFooter(quoted.join("\n"))).toBe("Kimi K3.1 Pro OpenCode Go");
    // "Build auto · …": an agent of two words
    expect(promptFooter(rows.map((row) => row.replace("Plan · ", "Plan auto · ")).join("\n"))).toBe("Kimi K3.1 Pro OpenCode Go");
  });

  it("knows any dialog is open, whatever its title, by its header or its frame", () => {
    for (const name of ["claude-first", "variant", "no-results", "session-dialog", "session-themes"]) expect(dialogOnScreen(fixture(name)), name).toBe(true);
    for (const name of ["closed", "closed-after-variant", "session-draft", "session-switched"]) expect(dialogOnScreen(fixture(name)), name).toBe(false);
    // the themes list is no model dialog, but it is a dialog
    expect(parseSelectDialog(fixture("session-themes"))).toBeNull();
    // a frame with no header row: a panel of a dialog's width, centred, three rows
    const width = 120;
    const panel = (text = ""): string => `${BASE}${" ".repeat(30)}${PANEL}${text.padEnd(60)}${BASE}${" ".repeat(width - 90)}`;
    expect(dialogOnScreen([panel(), panel("  Working on it"), panel()].join("\n"))).toBe(true);
    expect(dialogOnScreen([panel(), panel("  Working on it")].join("\n"))).toBe(false);
    // a header in a read without colours
    expect(dialogOnScreen("\n                     Status                         esc/enter\n")).toBe(true);
    expect(dialogOnScreen(fixture("closed").replace(/\u001b\[[0-9;]*m/gu, ""))).toBe(false);
  });

  it("tells a row and a footer of this model from one of another", () => {
    // a fuzzy filter lists close names: only the second row is GPT-6 Sol
    const gpt = parseSelectDialog(fixture("filtered-gpt"))!;
    expect(gpt.query).toBe("GPT-6 Sol");
    expect(gpt.highlighted).toBe(0);
    expect(gpt.rows.map((row) => rowMatch(row.text, "Agentic Chat (GPT-6 Sol)", "GitLab Duo"))).toEqual([null, "exact", null]);
    expect(rowMatch("Agentic Chat (Claude Opus 4.5) (Favorite) GitLab Duo", "Agentic Chat (Claude Opus 4.5)", "GitLab Duo")).toBe("exact");
    expect(rowMatch("Agentic Chat (Claude Opus 4.5) (Fav GitLab Duo", "Agentic Chat (Claude Opus 4.5)", "GitLab Duo")).toBe("exact");
    expect(rowMatch("Agentic Chat (Claude Opus 4.5) GitLab Duo", "Agentic Chat (Claude Opus 4)", "GitLab Duo")).toBeNull();
    expect(rowMatch("Agentic Chat (Claude Opus 4.5) GitLab Duo", "Agentic Chat (Claude Opus 4.5)", "OpenCode Go")).toBeNull();
    expect(rowMatch("Agentic Chat (Claude Op GitLab Duo", "Agentic Chat (Claude Opus 4.5)", "GitLab Duo")).toBe("prefix");
    expect(footerNames("Kimi K3 OpenCode Go · high", "Kimi K3", "OpenCode Go")).toBe(true);
    expect(footerNames("Kimi K3 OpenCo", "Kimi K3", "OpenCode Go")).toBe(true);
    expect(footerNames("Kimi K3.1 OpenCode Go", "Kimi K3", "OpenCode Go")).toBe(false);
    expect(footerNames("Kimi K3 GitLab Duo", "Kimi K3", "OpenCode Go")).toBe(false);
  });

  it("measures a wide character as two columns", () => {
    expect(ansiCells("\u001b[48;2;1;2;3m語a").map((cell) => [cell.ch, cell.bg])).toEqual([["語", "2;1;2;3"], ["", "2;1;2;3"], ["a", "2;1;2;3"]]);
  });
});

/* A TUI that answers keys with screens laid out as OpenCode 1.x draws its dialog. */

interface FakeModel { name: string; provider: string; variants?: boolean }

const BASE = "\u001b[0m\u001b[38;2;200;200;200m\u001b[48;2;0;0;0m";
const PANEL = "\u001b[0m\u001b[38;2;200;200;200m\u001b[48;2;30;30;30m";
const CURSOR = "\u001b[0m\u001b[38;2;10;10;10m\u001b[48;2;90;140;200m";
const WIDTH = 50;
const WINDOW = 6;

class FakeTui {
  dialog: null | "model" | "variant" | "other" = null;
  query = "";
  cursor = 0;
  scroll = 0;
  sent: string[] = [];
  /** the prompt's draft: its placeholder is drawn while it is empty */
  typedIntoPrompt = "";
  opens = true;
  confirms = true;
  /** where an `m` goes when ctrl+x m opens no dialog: nowhere, or into the draft at its end or its start */
  strayM: "none" | "end" | "start" = "none";
  /** whether Escape closes a dialog */
  closes = true;
  /** a key whose sending fails, as a pane that cannot be written to does */
  failKey: string | null = null;
  /** a write that herdr reports failed although its keys land, `reads` reads of the screen later */
  late: { key: string; reads: number } | null = null;
  private pending: { keys: string[]; reads: number } | null = null;
  /** a narrow pane: a model's name drawn cut to this many characters and an ellipsis */
  cut: number | null = null;
  /** a pick of a model with variants opens their list only this many reads after Enter */
  variantAfterReads: number | null = null;
  private variantIn: number | null = null;
  /** the timeouts each read and write was given */
  timeouts: number[] = [];
  constructor(public models: FakeModel[], public current: FakeModel) {}

  filtered(): FakeModel[] {
    const words = this.query.toLowerCase().split(/\s+/u).filter(Boolean);
    return this.models.filter((model) => words.every((word) => `${model.name} ${model.provider}`.toLowerCase().includes(word)));
  }

  keys(keys: string[]): void {
    for (const key of keys) {
      this.sent.push(key);
      const rows = this.filtered();
      if (key === "m" && this.sent.at(-2) === "ctrl+x") {
        if (this.opens && this.dialog === null) { this.dialog = "model"; this.query = ""; this.cursor = 0; this.scroll = 0; }
        else if (!this.opens && this.strayM === "end") this.typedIntoPrompt += "m";
        else if (!this.opens && this.strayM === "start") this.typedIntoPrompt = `m${this.typedIntoPrompt}`;
      }
      else if (key === "esc") { if (this.closes) this.dialog = null; }
      else if (key === "backspace" && this.dialog === null) this.typedIntoPrompt = this.typedIntoPrompt.slice(0, -1);
      else if (key === "down" && this.dialog === "model" && rows.length > 0) {
        this.cursor = (this.cursor + 1) % rows.length;
        if (this.cursor === 0) this.scroll = 0;
        else if (this.cursor >= this.scroll + WINDOW) this.scroll = this.cursor - WINDOW + 1;
      } else if (key === "enter" && this.dialog === "model") {
        const picked = rows[this.cursor];
        if (picked && this.confirms) this.current = picked;
        this.dialog = picked?.variants && this.variantAfterReads === null ? "variant" : null;
        if (picked?.variants && this.variantAfterReads !== null) this.variantIn = this.variantAfterReads;
      } else if (key === "enter" && this.dialog === "variant") this.dialog = null;
    }
  }

  type(text: string): void {
    if (this.dialog === "model") { this.query += text; this.cursor = 0; this.scroll = 0; }
    else this.typedIntoPrompt += text;
  }

  private panelLine(content: string, background = PANEL): string {
    return `${BASE}${" ".repeat(10)}${PANEL} ${background}${content.padEnd(WIDTH - 2).slice(0, WIDTH - 2)}${PANEL} ${BASE}${" ".repeat(10)}`;
  }

  screen(): string {
    const lines: string[] = [`${BASE}${" ".repeat(70)}`];
    if (this.dialog !== null) {
      const title = this.dialog === "model" ? "Select model" : this.dialog === "variant" ? "Select variant" : "Themes";
      lines.push(`${BASE}${" ".repeat(10)}${PANEL}    ${title}${" ".repeat(WIDTH - 11 - title.length)}esc    ${BASE}${" ".repeat(10)}`);
      lines.push(this.panelLine(""));
      lines.push(this.panelLine(`   ${this.query || "Search"}`));
      lines.push(this.panelLine(""));
      if (this.dialog === "model") {
        const rows = this.filtered();
        rows.slice(this.scroll, this.scroll + WINDOW).forEach((model, index) => {
          const mark = model === this.current ? " ● " : "   ";
          const left = `${mark}${this.cut === null || model.name.length <= this.cut ? model.name : `${model.name.slice(0, this.cut)}…`}`;
          lines.push(this.panelLine(`${left}${" ".repeat(Math.max(1, WIDTH - 2 - left.length - model.provider.length - 2))}${model.provider}`, this.scroll + index === this.cursor ? CURSOR : PANEL));
        });
      } else {
        ["Default", "low", "high"].forEach((variant, index) => lines.push(this.panelLine(`   ${variant}`, index === 0 ? CURSOR : PANEL)));
      }
      lines.push(this.panelLine(""), this.panelLine("   Connect provider ctrl+a"), this.panelLine(""));
    }
    // the prompt box: a padding row, the draft (or its placeholder), a padding row, the footer, and the row that ends it
    const draft = this.typedIntoPrompt === "" ? ["Ask anything"] : this.typedIntoPrompt.split("\n");
    lines.push(`${BASE}  ┃`, ...draft.map((row) => `${BASE}  ┃  ${row}`), `${BASE}  ┃`);
    lines.push(`${BASE}  ┃  Build · ${this.current.name} ${this.current.provider}`, `${BASE}  ╹${"▀".repeat(60)}`);
    return lines.join("\r\n");
  }

  deps(): DriveDeps & { time: number } {
    const deps = {
      time: 0,
      read: async (timeoutMs: number) => {
        this.timeouts.push(timeoutMs);
        if (this.pending !== null) {
          if (this.pending.reads === 0) { this.keys(this.pending.keys); this.pending = null; }
          else this.pending.reads -= 1;
        }
        if (this.variantIn !== null) {
          if (this.variantIn === 0) { this.dialog = "variant"; this.variantIn = null; }
          else this.variantIn -= 1;
        }
        return this.screen();
      },
      keys: async (keys: string[], timeoutMs: number) => {
        this.timeouts.push(timeoutMs);
        if (this.late !== null && keys.includes(this.late.key)) {
          this.pending = { keys, reads: this.late.reads };
          this.late = null;
          throw new Error("pane.send_keys timed out");
        }
        if (this.failKey !== null && keys.includes(this.failKey)) throw new Error("pane.send_keys timed out");
        this.keys(keys);
      },
      type: async (text: string, timeoutMs: number) => { this.timeouts.push(timeoutMs); this.type(text); },
      sleep: async (ms: number) => { deps.time += ms; },
      now: () => deps.time,
    };
    return deps;
  }
}

const MODELS: FakeModel[] = [
  { name: "Claude Haiku 5.5", provider: "OpenCode Go" },
  { name: "Agentic Chat (Claude Sonnet 5.5)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Opus 5.5)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Opus 5)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Fable 5)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Opus 4.8)", provider: "GitLab Duo" },
  { name: "Agentic Chat (Claude Opus 4.7)", provider: "GitLab Duo" },
  { name: "Claude Opus 4.7", provider: "OpenCode Go" },
  { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo", variants: true },
];

describe("driving OpenCode's model dialog", () => {
  it("opens the dialog, filters, walks down to the row, picks it and reads the footer back", async () => {
    const tui = new FakeTui(MODELS, MODELS[2]!);
    expect(await driveModelDialog(tui.deps(), { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(tui.current).toBe(MODELS[4]!);
    expect(tui.dialog).toBeNull();
    expect(tui.sent.slice(0, 2)).toEqual(["ctrl+x", "m"]);
    expect(tui.sent.at(-1)).toBe("enter");
  });

  it("scrolls past the rows in view, and tells two providers' rows of the same name apart", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    expect(await driveModelDialog(tui.deps(), { name: "Claude Opus 4.7", provider: "OpenCode Go" })).toEqual({ ok: true });
    expect(tui.current).toBe(MODELS[8]!);
  });

  it("closes the variant list a pick opens with Escape, keeping the model", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    expect(await driveModelDialog(tui.deps(), { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(tui.current).toBe(MODELS[9]!);
    expect(tui.sent.at(-1)).toBe("esc");
  });

  it("refuses before any key when any dialog is open, the prompt is not on the screen or names no model, or the request was given up", async () => {
    for (const dialog of ["model", "other"] as const) {
      const open = new FakeTui(MODELS, MODELS[0]!);
      open.dialog = dialog;
      expect(await driveModelDialog(open.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" })).toMatchObject({ ok: false, code: "dialog_open" });
      expect(open.sent).toEqual([]);
    }
    const other = new FakeTui(MODELS, MODELS[0]!);
    const deps = { ...other.deps(), read: async () => `${BASE}Sessions\r\n${BASE}  nothing here` };
    expect(await driveModelDialog(deps, { name: "Claude Haiku 5.5", provider: "OpenCode Go" })).toMatchObject({ ok: false, code: "not_ready" });
    const shell = new FakeTui(MODELS, MODELS[0]!);
    const shellDeps = { ...shell.deps(), read: async () => shell.screen().replace(/Build · .*/u, "Shell") };
    expect(await driveModelDialog(shellDeps, { name: "Claude Haiku 5.5", provider: "OpenCode Go" })).toMatchObject({ ok: false, code: "not_ready" });
    const given = new FakeTui(MODELS, MODELS[0]!);
    expect(await driveModelDialog(given.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" }, undefined, AbortSignal.abort())).toMatchObject({ ok: false, code: "aborted" });
    expect([other.sent, shell.sent, given.sent]).toEqual([[], [], []]);
  });

  it("types no name that holds a key or an invisible mark", async () => {
    for (const name of ["Opus\u001b[2J", "Opus\r", "Opus\n", "Op\u202eus", "x".repeat(201)]) {
      const tui = new FakeTui(MODELS, MODELS[0]!);
      expect(await driveModelDialog(tui.deps(), { name, provider: "GitLab Duo" }), JSON.stringify(name)).toMatchObject({ ok: false, code: "unknown_model" });
      expect(await driveModelDialog(tui.deps(), { name: "Claude Haiku 5.5", provider: `${name}` })).toMatchObject({ ok: false, code: "unknown_model" });
      expect(tui.sent).toEqual([]);
    }
  });

  it("gives up when the dialog does not open, sending no Escape to the prompt", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.opens = false;
    const result = await driveModelDialog(tui.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" });
    expect(result).toMatchObject({ ok: false, code: "dialog_not_opened" });
    expect(result.ok ? "" : result.message).toContain("as it was");
    expect(tui.sent).toEqual(["ctrl+x", "m"]);
  });

  it("takes back an m that ctrl+x m left at the end of the draft, with one Backspace, and nothing else", async () => {
    for (const draft of ["first line\nsecond line", ""]) {
      const tui = new FakeTui(MODELS, MODELS[0]!);
      tui.opens = false;
      tui.strayM = "end";
      tui.typedIntoPrompt = draft;
      const result = await driveModelDialog(tui.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" });
      expect(result).toMatchObject({ ok: false, code: "dialog_not_opened" });
      expect(result.ok ? "" : result.message).toContain("taken back");
      expect(tui.typedIntoPrompt).toBe(draft);
      expect(tui.sent).toEqual(["ctrl+x", "m", "backspace"]);
    }
    // an m that went anywhere but the end is not the draft's last character: it is said, and left
    const start = new FakeTui(MODELS, MODELS[0]!);
    start.opens = false;
    start.strayM = "start";
    start.typedIntoPrompt = "keep this";
    const result = await driveModelDialog(start.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" });
    expect(result.ok ? "" : result.message).toContain("left as it is");
    expect(start.typedIntoPrompt).toBe("mkeep this");
    expect(start.sent).toEqual(["ctrl+x", "m"]);
  });

  it("closes the dialog with one Escape when the row is not there", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    expect(await driveModelDialog(tui.deps(), { name: "Agentic Chat (Claude Opus 4.8)", provider: "OpenCode Go" })).toMatchObject({ ok: false, code: "model_not_found" });
    expect(tui.dialog).toBeNull();
    expect(tui.sent.filter((key) => key === "esc")).toEqual(["esc"]);
    expect(tui.current).toBe(MODELS[0]!);
  });

  it("closes the dialog and says why when the pane cannot be written to or read after the first key", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.failKey = "down";
    const written = await driveModelDialog(tui.deps(), { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" });
    expect(written).toMatchObject({ ok: false, code: "pane_error" });
    expect(written.ok ? "" : written.message).toContain("timed out");
    expect(tui.dialog).toBeNull();
    expect(tui.sent.at(-1)).toBe("esc");
    // a pane that stops answering reads: one Escape all the same, and the dialog may still be open
    const silent = new FakeTui(MODELS, MODELS[0]!);
    const deps = silent.deps();
    let reads = 0;
    const read = deps.read;
    deps.read = async (timeoutMs) => { reads += 1; if (reads > 2) throw new Error("pane.read timed out"); return read(timeoutMs); };
    expect(await driveModelDialog(deps, { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" })).toMatchObject({ ok: false, code: "pane_error", dialog_left_open: true });
    expect(silent.sent.filter((key) => key === "esc")).toEqual(["esc"]);
  });

  it("watches for a dialog that keys herdr could not confirm open late, and closes it", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.late = { key: "m", reads: 4 };
    const result = await driveModelDialog(tui.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" });
    expect(result).toMatchObject({ ok: false, code: "pane_error" });
    expect(result.ok ? "" : result.message).toContain("timed out");
    expect("dialog_left_open" in result).toBe(false);
    expect(tui.dialog).toBeNull();
    expect(tui.sent).toEqual(["ctrl+x", "m", "esc"]);
    // near the end of the budget the watch still lasts, though each read of the drive would be 100ms
    const tight = new FakeTui(MODELS, MODELS[0]!);
    tight.late = { key: "m", reads: 4 };
    const deps = tight.deps();
    expect(await driveModelDialog(deps, { name: "Claude Haiku 5.5", provider: "OpenCode Go" }, 50)).toMatchObject({ ok: false, code: "pane_error" });
    expect(tight.dialog).toBeNull();
    expect(tight.sent.at(-1)).toBe("esc");
  });

  it("takes an Enter herdr could not confirm as the switch once the footer shows the model, and closes a dialog it left", async () => {
    const tui = new FakeTui(MODELS, MODELS[2]!);
    tui.late = { key: "enter", reads: 3 };
    expect(await driveModelDialog(tui.deps(), { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(tui.current).toBe(MODELS[4]!);
    expect(tui.dialog).toBeNull();
    expect(tui.sent.includes("esc")).toBe(false);
    // with variants: the list it opens late is closed, and the pick kept
    const variant = new FakeTui(MODELS, MODELS[0]!);
    variant.late = { key: "enter", reads: 2 };
    expect(await driveModelDialog(variant.deps(), { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(variant.current).toBe(MODELS[9]!);
    expect(variant.dialog).toBeNull();
    // an Enter that never lands: the model dialog is closed and nothing was switched
    const lost = new FakeTui(MODELS, MODELS[2]!);
    lost.late = { key: "enter", reads: 1_000_000 };
    const result = await driveModelDialog(lost.deps(), { name: "Agentic Chat (Claude Sonnet 5)", provider: "GitLab Duo" });
    expect(result).toMatchObject({ ok: false, code: "pane_error" });
    expect("dialog_left_open" in result).toBe(false);
    expect(lost.dialog).toBeNull();
    expect(lost.current).toBe(MODELS[2]!);
    expect(lost.sent.at(-1)).toBe("esc");
  });

  it("closes a variant list that opens a moment after the footer shows the model", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.variantAfterReads = 1;
    expect(await driveModelDialog(tui.deps(), { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(tui.current).toBe(MODELS[9]!);
    expect(tui.dialog).toBeNull();
    expect(tui.sent.at(-1)).toBe("esc");
    const stuck = new FakeTui(MODELS, MODELS[0]!);
    stuck.variantAfterReads = 1;
    stuck.closes = false;
    expect(await driveModelDialog(stuck.deps(), { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo" })).toEqual({ ok: true, dialog_left_open: true });
  });

  it("chooses no row when more than one reads as the model, as names a narrow pane cuts short alike", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.cut = 20;
    const result = await driveModelDialog(tui.deps(), { name: "Agentic Chat (Claude Opus 5)", provider: "GitLab Duo" });
    expect(result).toMatchObject({ ok: false, code: "model_not_found" });
    expect(result.ok ? "" : result.message).toContain("more than one row");
    expect(tui.current).toBe(MODELS[0]!);
    expect(tui.dialog).toBeNull();
    // one row cut short, alone in the filter: it is the model
    const one = new FakeTui(MODELS, MODELS[0]!);
    one.cut = 20;
    expect(await driveModelDialog(one.deps(), { name: "Agentic Chat (GPT-6 Sol)", provider: "GitLab Duo" })).toEqual({ ok: true });
    expect(one.current).toBe(MODELS[9]!);
    // two rows drawn alike in full
    const twice = new FakeTui([...MODELS, { name: "Claude Haiku 5.5", provider: "OpenCode Go" }], MODELS[2]!);
    expect(await driveModelDialog(twice.deps(), { name: "Claude Haiku 5.5", provider: "OpenCode Go" })).toMatchObject({ ok: false, code: "model_not_found" });
    expect(twice.current).toBe(MODELS[2]!);
  });

  it("waits for the closing Escape to close the dialog, and says when it does not", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.closes = false;
    const deps = tui.deps();
    const result = await driveModelDialog(deps, { name: "Agentic Chat (Claude Opus 4.8)", provider: "OpenCode Go" });
    expect(result).toMatchObject({ ok: false, code: "model_not_found", dialog_left_open: true });
    expect(result.ok ? "" : result.message).toContain("still open");
    expect(tui.sent.filter((key) => key === "esc")).toEqual(["esc"]);
  });

  it("says when the footer never shows the model, within its time, and what it shows", async () => {
    const tui = new FakeTui(MODELS, MODELS[0]!);
    tui.confirms = false;
    const deps = tui.deps();
    const result = await driveModelDialog(deps, { name: "Agentic Chat (Claude Opus 5)", provider: "GitLab Duo" }, 3_000);
    expect(result).toMatchObject({ ok: false, code: "not_confirmed" });
    expect(result.ok ? "" : result.message).toContain("\"Claude Haiku 5.5 OpenCode Go\"");
    expect(deps.time).toBeLessThanOrEqual(3_000 + 100);
    expect(tui.sent.includes("esc")).toBe(false);
    // each read and write is bounded by what is left of the budget
    expect(Math.max(...tui.timeouts)).toBeLessThanOrEqual(2_000);
    expect(Math.min(...tui.timeouts)).toBe(100);
  });
});

/* The routes, over a herdr socket that answers for one pane with the fake TUI. */

async function withHerdr(tui: FakeTui, pane: { agent: string | null; agent_status: string }, run: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opencode-model-"));
  const path = join(root, "herdr.sock");
  const sockets = new Set<Socket>();
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string; format?: string } };
      let result: unknown = { type: "ok" };
      if (req.method === "pane.get") result = { pane: { pane_id: "w1:p1", cwd: root, ...pane } };
      else if (req.method === "pane.read") result = { read: { text: req.params.format === "ansi" ? tui.screen() : tui.screen().replace(/\u001b\[[0-9;]*m/gu, "") } };
      else if (req.method === "pane.send_keys") tui.keys(req.params.keys ?? []);
      else if (req.method === "pane.send_text") tui.type(req.params.text ?? "");
      socket.end(`${JSON.stringify({ id: req.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { rpc.once("error", reject); rpc.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const CATALOG = {
  providers: [
    { id: "gitlab", name: "GitLab Duo", models: { "opus-5-5": { name: "Agentic Chat (Claude Opus 5.5)" }, "sonnet-5": { name: "Agentic Chat (Claude Sonnet 5)" } } },
    { id: "go", name: "OpenCode Go", models: { haiku: { name: "Claude Haiku 5.5" } } },
  ],
};

const call = async (path: string, body?: unknown): Promise<Response> => {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return (await handleOpencodeModelRequest(request, url, url.pathname))!;
};

describe("the model routes", () => {
  const configure = (): void => {
    opencodeModelOptions.endpoint = async () => ({ baseUrl: "http://127.0.0.1:1", authorization: null });
    opencodeModelOptions.read = async () => CATALOG;
  };

  it("lists a pane's models with the one its footer shows", async () => {
    configure();
    const tui = new FakeTui(MODELS, MODELS[2]!);
    await withHerdr(tui, { agent: "opencode", agent_status: "idle" }, async () => {
      const answer = await (await call("/api/pane/opencode-models?pane_id=w1:p1")).json() as OpencodeModelCatalog;
      expect(answer.available).toBe(true);
      expect(answer.providers.map((provider) => provider.id)).toEqual(["gitlab", "go"]);
      expect(answer.current).toEqual({ provider_id: "gitlab", model_id: "opus-5-5" });
    });
    await withHerdr(tui, { agent: "claude", agent_status: "idle" }, async () => {
      expect(await (await call("/api/pane/opencode-models?pane_id=w1:p1")).json()).toEqual({ available: false, providers: [], current: null });
    });
  });

  it("lists the models for a new session's --model, and none for another agent", async () => {
    configure();
    expect((await (await call("/api/agent/models?agent=opencode")).json() as OpencodeModelCatalog).providers.length).toBe(2);
    expect(await (await call("/api/agent/models?agent=codex")).json()).toEqual({ available: false, providers: [], current: null });
    expect((await call("/api/agent/models")).status).toBe(400);
  });

  it("switches the model through the pane's TUI", async () => {
    configure();
    const tui = new FakeTui(MODELS, MODELS[2]!);
    await withHerdr(tui, { agent: "opencode", agent_status: "idle" }, async () => {
      const response = await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "sonnet-5" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, model: { provider_id: "gitlab", model_id: "sonnet-5" } });
      expect(tui.current).toBe(MODELS[4]!);
    });
  });

  it("refuses a busy pane, another agent, an unknown model and a missing source before any key", async () => {
    configure();
    const tui = new FakeTui(MODELS, MODELS[2]!);
    await withHerdr(tui, { agent: "opencode", agent_status: "working" }, async () => {
      const busy = await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "sonnet-5" });
      expect([busy.status, ((await busy.json()) as { error: { code: string } }).error.code]).toEqual([409, "busy"]);
    });
    await withHerdr(tui, { agent: "codex", agent_status: "idle" }, async () => {
      expect((await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "sonnet-5" })).status).toBe(409);
    });
    expect((await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "nope" })).status).toBe(422);
    expect((await call("/api/pane/opencode-model", { pane_id: "w1:p1" })).status).toBe(400);
    expect(tui.sent).toEqual([]);
    forgetOpencodeModels();
    opencodeModelOptions.endpoint = async () => null;
    expect((await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "sonnet-5" })).status).toBe(503);
  });

  it("refuses a model whose name and provider another has too, and names none of them in use", async () => {
    opencodeModelOptions.endpoint = async () => ({ baseUrl: "http://127.0.0.1:1", authorization: null });
    opencodeModelOptions.read = async () => ({
      providers: [{ id: "gitlab", name: "GitLab Duo", models: { "opus-5-5": { name: "Agentic Chat (Claude Opus 5.5)" }, "opus-5-5-again": { name: "Agentic Chat (Claude Opus 5.5)" }, "sonnet-5": { name: "Agentic Chat (Claude Sonnet 5)" } } }],
    });
    const tui = new FakeTui(MODELS, MODELS[2]!);
    await withHerdr(tui, { agent: "opencode", agent_status: "idle" }, async () => {
      const response = await call("/api/pane/opencode-model", { pane_id: "w1:p1", provider_id: "gitlab", model_id: "opus-5-5-again" });
      expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([422, "ambiguous_model"]);
      expect(tui.sent).toEqual([]);
      expect(((await (await call("/api/pane/opencode-models?pane_id=w1:p1")).json()) as OpencodeModelCatalog).current).toBeNull();
    });
  });

  it("sends nothing for a request given up while it waited its turn", async () => {
    configure();
    const tui = new FakeTui(MODELS, MODELS[2]!);
    await withHerdr(tui, { agent: "opencode", agent_status: "idle" }, async () => {
      const controller = new AbortController();
      const url = new URL("http://localhost/api/pane/opencode-model");
      const request = new Request(url, { method: "POST", signal: controller.signal, body: JSON.stringify({ pane_id: "w1:p1", provider_id: "gitlab", model_id: "sonnet-5" }), headers: { "content-type": "application/json" } });
      const response = (await handleOpencodeModelRequest(request, url, url.pathname, { serialize: async (_pane, task) => { controller.abort(); return task(); } }))!;
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("aborted");
      expect(tui.sent).toEqual([]);
    });
  });
});
