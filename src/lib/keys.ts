/**
 * Key-bar key mappings, kept free of DOM and xterm so they can be unit-tested.
 * PaneTerminal feeds the result to term.input(), which takes the same
 * onData -> socket path as typed keys. The keyboard's own keys xterm.js encodes
 * differently from a terminal are below them.
 */

/** Keys a soft keyboard has no room for; ctrl-* are chords, pipe/tilde/slash the characters, the rest DOM key names. */
export type KeyBarKey =
  | "Escape" | "Tab" | "Enter" | "BackTab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "PageUp" | "PageDown" | "Backspace" | "Delete" | "Insert"
  | "ctrl-c" | "ctrl-d" | "ctrl-z" | "pipe" | "tilde" | "slash";

/** The key bar's optional keys, as Settings lists them; a pair is one choice. Esc, Tab, Ctrl, the arrows and ^C are always there. */
export type KeyBarExtra = "alt" | "shift-tab" | "home-end" | "page-up-down" | "ctrl-d" | "ctrl-z" | "pipe" | "tilde" | "slash";
export const KEY_BAR_EXTRAS: readonly KeyBarExtra[] = ["alt", "shift-tab", "home-end", "page-up-down", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"];

/** The chosen optional keys: known ones only, each once, in KEY_BAR_EXTRAS order; anything but a list keeps the default. */
export function sanitizeKeyBarExtras(value: unknown, fallback: readonly KeyBarExtra[]): KeyBarExtra[] {
  if (!Array.isArray(value)) return [...fallback];
  return KEY_BAR_EXTRAS.filter((extra) => value.includes(extra));
}

export interface StickyModifiers { ctrl: boolean; alt: boolean; shift: boolean }
export const NO_STICKY_MODIFIERS: StickyModifiers = { ctrl: false, alt: false, shift: false };

export function hasModifiers(modifiers: StickyModifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

/** Ctrl+C/V remain native clipboard shortcuts on non-Latin layouts; Latin layouts keep their typed letter. */
export function clipboardKey(key: string, code: string): string {
  const typed = key.toLowerCase();
  return /^[a-z]$/.test(typed) ? typed : /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? typed;
}

/** The key a physical chord names. A non-Latin layout's letter goes by its position, as the plain
 * Ctrl path reads it: Korean ㅊ or Russian с on KeyC with a held Ctrl is Ctrl+C, which herdr's
 * encoder knows, not ctrl+ㅊ, which it types. A Latin layout keeps its own letter (Dvorak's C is
 * not KeyC), and anything that is not a letter position stays as typed.
 */
export function physicalKey(key: string, code: string): string {
  if ([...key].length !== 1 || /^[a-zA-Z]$/.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  return letter === undefined ? key : letter.toLowerCase();
}

/** Send logical chords to Herdr, which owns the target pane's keyboard protocol.
 * A plus or space needs a name because Herdr's chord parser splits on '+' and trims.
 * Keep the typed symbol: the phone's layout already chose it; don't assume US Shift.
 */
export function terminalChord(key: string, modifiers: StickyModifiers): string | null {
  if (["Home", "End", "PageUp", "PageDown", "Delete", "Insert"].includes(key)) return null;
  if (/^ctrl-[cdz]$/.test(key)) { key = key.slice(-1); modifiers = { ...modifiers, ctrl: true }; }
  if (key === "BackTab") { key = "Tab"; modifiers = { ...modifiers, shift: true }; }
  const names: Record<string, string> = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Enter: "enter", Tab: "tab", Escape: "esc", Backspace: "backspace",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    pipe: "|", tilde: "~", slash: "/",
    " ": "space", "+": "plus",
  };
  const name = (Object.hasOwn(names, key) ? names[key] : undefined) ?? (/^F(?:[1-9]|1[0-2])$/.test(key) ? key.toLowerCase()
    : [...key].length === 1 && key.codePointAt(0)! >= 0x20 && key !== "\x7f" ? key : null);
  if (name === null) return null;
  return [modifiers.ctrl && "ctrl", modifiers.alt && "alt", modifiers.shift && "shift", name].filter(Boolean).join("+");
}

/** Herdr's send_keys parser lacks these names; its attach input parser accepts CSI navigation. */
export function navigationSequence(key: string, modifiers: StickyModifiers): string | null {
  const parameter = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  switch (key) {
    case "Home": return `\x1b[1;${parameter}H`;
    case "End": return `\x1b[1;${parameter}F`;
    case "PageUp": return `\x1b[5;${parameter}~`;
    case "PageDown": return `\x1b[6;${parameter}~`;
    case "Delete": return `\x1b[3;${parameter}~`;
    case "Insert": return `\x1b[2;${parameter}~`;
    default: return null;
  }
}

/** Soft keyboards often emit input events without a DOM keydown. Only individual
 * committed characters are keys; a multi-character composition is text.
 */
export function keyFromData(data: string): string | null {
  const fixed: Record<string, string> = { "\r": "Enter", "\t": "Tab", "\x7f": "Backspace", "\x1b": "Escape" };
  if (Object.hasOwn(fixed, data)) return fixed[data]!;
  const arrow = /^\x1b(?:\[|O)([ABCD])$/.exec(data);
  if (arrow) return ({ A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft" } as Record<string, string>)[arrow[1]!]!;
  return [...data].length === 1 && data.codePointAt(0)! >= 0x20 ? data : null;
}

/**
 * The chord one typed or committed character is under the key bar's held modifiers, or null for
 * text. A paste, a multi-character commit and anything typed while a composition is still open are
 * text. A finished composition (`committed`) is a chord only for one printable ASCII character:
 * that is how Gboard types a Latin letter, one composed word at a time, while a CJK syllable such
 * as 한 is an IME's text and stays text whatever is held.
 */
export function heldChord(text: string, modifiers: StickyModifiers, state: "typed" | "composing" | "committed"): string | null {
  if (state === "composing" || !hasModifiers(modifiers) || [...text].length !== 1) return null;
  if (state === "committed" && !/^[\x21-\x7e]$/.test(text)) return null;
  return terminalChord(text, modifiers);
}

/** What a key on a text field's keydown says about itself, as KeyboardEvent has it. */
export interface FieldKeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** Ctrl+letter chords a text field keeps: select all, the clipboard, undo and redo. */
const FIELD_CONTROL_LETTERS = /^[acvxyz]$/;

/**
 * A keydown in a text field that writes for the terminal (the input line) that the terminal takes
 * as a chord instead of the field: a character typed under the key bar's held modifiers, combined
 * with the hardware ones, or a hardware Ctrl+letter (Ctrl+P, Ctrl+R) that would otherwise print
 * the page or reload it. Null leaves the key to the field: named keys (Enter, Backspace, arrows,
 * Ctrl+Backspace), an IME's keys, Cmd chords, Ctrl+Alt (AltGr), Ctrl+Shift (app shortcuts) and
 * select all, the clipboard, undo and redo. On a Mac, where Ctrl+letter is the field's own Emacs
 * editing (Ctrl+A, Ctrl+E, Ctrl+K) and Cmd prints, a hardware Ctrl+letter stays the field's.
 */
export function fieldKeyChord(event: FieldKeyLike, held: StickyModifiers, mac: boolean): { key: string; modifiers: StickyModifiers } | null {
  if (event.isComposing || event.keyCode === 229 || event.metaKey) return null;
  const letter = clipboardKey(event.key, event.code);
  if (hasModifiers(held)) {
    const key = physicalKey(event.key, event.code);
    if ([...key].length !== 1 || (event.ctrlKey && FIELD_CONTROL_LETTERS.test(letter))) return null;
    const modifiers = { ctrl: held.ctrl || event.ctrlKey, alt: held.alt || event.altKey, shift: held.shift || event.shiftKey };
    return terminalChord(key, modifiers) === null ? null : { key, modifiers };
  }
  if (mac || !event.ctrlKey || event.altKey || event.shiftKey || !/^[a-z]$/.test(letter) || FIELD_CONTROL_LETTERS.test(letter)) return null;
  return { key: letter, modifiers: { ctrl: true, alt: false, shift: false } };
}

/** Ctrl+P outside a Mac: the browser's print dialog, which a box writing for an agent never wants. */
export function isPrintKey(event: Omit<FieldKeyLike, "isComposing" | "keyCode">, mac: boolean): boolean {
  return !mac && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && clipboardKey(event.key, event.code) === "p";
}

/** A single printable UTF-16 character. */
export function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/** The control code for A-Z and @ [ \ ] ^ _ (Ctrl+C = 0x03, Ctrl+[ = ESC, ...), null otherwise. */
export function controlCode(ch: string): string | null {
  if (!/^[A-Za-z@[\\\]^_]$/.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
}

/**
 * What a key-bar tap feeds xterm. Arrows follow DECCKM like a real keyboard: SS3
 * while a full-screen program has application cursor keys on, CSI otherwise.
 */
export function keySequence(key: KeyBarKey, applicationCursorKeys: boolean): string {
  const cursor = (final: "A" | "B" | "C" | "D" | "H" | "F"): string => (applicationCursorKeys ? "\u001bO" : "\u001b[") + final;
  switch (key) {
    case "Escape":
      return "\u001b";
    case "Tab":
      return "\t";
    case "Enter":
      return "\r";
    case "BackTab":
      return "\u001b[Z";
    case "Backspace":
      return "\u007f";
    case "Delete":
      return "\u001b[3~";
    case "Insert":
      return "\u001b[2~";
    case "ctrl-c":
      return "\u0003";
    case "ctrl-d":
      return "\u0004";
    case "ctrl-z":
      return "\u001a";
    case "pipe":
      return "|";
    case "tilde":
      return "~";
    case "slash":
      return "/";
    case "Home":
      return cursor("H");
    case "End":
      return cursor("F");
    case "PageUp":
      return "\u001b[5~";
    case "PageDown":
      return "\u001b[6~";
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
  }
}

/**
 * One keystroke under the key bar's one-shot Alt, as xterm sends it with metaSendsEscape: ESC
 * before a single character (Alt+b, Alt+Backspace, Alt+Enter), and the Alt modifier in a cursor
 * or editing key's sequence (Alt+Left is CSI 1;3D, Alt+PageUp CSI 5;3~). Null for anything else,
 * such as a paste or a report the terminal answers with, which the armed Alt lets through as it is.
 */
export function altSequence(data: string): string | null {
  if ([...data].length === 1) return "\u001b" + data;
  const cursor = /^\u001b[[O]([A-DHF])$/.exec(data);
  if (cursor) return `\u001b[1;3${cursor[1]}`;
  const editing = /^\u001b\[(\d+)~$/.exec(data);
  if (editing) return `\u001b[${editing[1]};3~`;
  return null;
}

/**
 * xterm's modifyOtherKeys level after CSI > 4 ; Pv m, or CSI > 4 n, which turns it off. Other
 * resources leave it as it was. xterm.js 5.5 ignores the request and types Ctrl+Enter as a plain
 * CR, the same as Enter, so PaneTerminal keeps the level here and sends that key itself.
 * herdr passes the pane program's request on to the attached client, and again on every
 * attach; Claude Code asks for level 2.
 */
export function modifyOtherKeysLevel(level: number, final: "m" | "n", params: ReadonlyArray<number | number[]>): number {
  // a bare CSI > m or CSI > n resets every key-modifier resource (xterm). xterm.js hands it over
  // as [0], the same as an explicit resource 0 (modifyKeyboard, which this does not track): off
  // is the safe reading, since a level left on would type CSI 27;5;13~ into a shell
  if (params.length === 0 || (params.length === 1 && params[0] === 0)) return 0;
  if (params[0] !== 4) return level;
  const value = params[1];
  return final === "m" && typeof value === "number" ? value : 0;
}

/** Ctrl+Enter under modifyOtherKeys, as xterm encodes it; null keeps xterm.js's own CR. */
export function ctrlEnterSequence(modifyOtherKeys: number): string | null {
  return modifyOtherKeys > 0 ? "\u001b[27;5;13~" : null;
}

/**
 * Ctrl+Enter on a mirrored pane, as a herdr key (#924). A mirror's repaint carries no terminal
 * modes (server/mirror.ts), so the browser never learns that the program asked for
 * modifyOtherKeys; herdr holds the pty and encodes `ctrl+enter` in the program's own mode:
 * CSI 27;5;13~ after `CSI > 4;2 m` (Claude Code's "send now"), CR otherwise (herdr 0.9.3).
 * null: the attached pane's own sequence, from ctrlEnterSequence.
 */
export function mirroredCtrlEnterKey(mirrored: boolean, modifyOtherKeys: number): string | null {
  return mirrored && modifyOtherKeys === 0 ? "ctrl+enter" : null;
}
