import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft, SendHorizontal, TextCursorInput } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft, terminalDraftVersion } from "../lib/terminalDraft.ts";

import { AttachmentTooLargeError, assertAttachable } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { composedChordLetter, fieldKeyChord, fieldLineKey, hasModifiers, heldChord, NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
import { plainError } from "../lib/paneTerminalShared.ts";
import { useSettings } from "../lib/settings.ts";
import { isAppShortcut, isMacPlatform } from "../lib/shortcuts.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  owner: string;
  active?: boolean;
  /** an IME composition in the line: only the switch to direct typing waits for it */
  onComposing?: (active: boolean) => void;
  connected: boolean;
  /** true: sent, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onSend: (text: string) => false | Promise<true | string>;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue;
   * true: sent, false: not sent (offline), a string: not sent, and why */
  onEnter: () => boolean | string;
  /** the line typed into the pane without Enter; true: typed, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onInsert: (text: string) => false | Promise<true | string>;
  /** what a paste is for, read at the tap and again once the clipboard answers: the PC, pane and
   * connection; null while the pane cannot take one. A different answer cancels the paste. */
  pasteTarget?: () => string | null;
  /** a paste waits on the clipboard: the key bar's Paste is off meanwhile */
  onPasting?: (active: boolean) => void;
  /** stores a pasted file beside this line's pane (POST /api/pane/image) and resolves to its path */
  uploadFile?: (file: Blob) => Promise<string>;
  /** the line took the focus */
  onFocus?: () => void;
  /** Settings → Terminal → Compact input line: one short row, and the key bar's fold button */
  compact?: boolean;
  /** the button at the line's end that folds the key bar away and brings it back (compact only) */
  keyBar?: { shown: boolean; onToggle: () => void };
  /** the key bar's held modifiers: the next character typed is a chord, not text for the line */
  modifiers?: StickyModifiers;
  /** sends one key with these modifiers to the pane, the way a key-bar key goes */
  onKey?: (key: string, modifiers: StickyModifiers) => void;
  ref?: Ref<TerminalInputHandle>;
}

/** What the key bar's Paste and the mode switch ask of the line (PaneTerminal.tsx). */
export interface TerminalInputHandle {
  /** reads the clipboard for the line, from the user's own tap and for this line alone */
  paste(): void;
  /** takes the focus without dismissing or re-raising the keyboard, caret kept: true when the field was there */
  focus(): boolean;
}

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;
/** How long a Send tapped mid-composition waits for the keyboard to commit the word. */
const COMMIT_WAIT_MS = 300;

/** A Send tapped mid-composition, waiting for the word to commit. */
interface SendAttempt {
  /** withdraws the tap at the deadline while a composition is open */
  timer: ReturnType<typeof setTimeout> | null;
  /** fixed at the tap: a chain of compositions cannot stretch the wait */
  deadline: number;
  /** the line held text at the tap: an empty commit then sends nothing, not a bare Enter */
  textSend: boolean;
}

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable), and a terminal cannot take back
 * keys it already sent: every revision arrived as more text. Here the line is written with the
 * keyboard's own editing and goes to the pane whole, then Enter. Autocorrect and spell-check stay
 * off, as in the composer: they would swap a flag, path or branch name for a dictionary word.
 */
export function TerminalInput({ owner, active = true, connected, onSend, onEnter, onInsert, pasteTarget, onPasting, uploadFile, onComposing, onFocus, ref, compact = false, keyBar, modifiers = NO_STICKY_MODIFIERS, onKey }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    // Read the owner record even after unmount: a late acknowledgement must not erase
    // edits made in a newly mounted input for the same pane.
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
  /** compositions begun or ended, and selection changes, in the line: a paste waiting on the clipboard compares them (paste below) */
  const compositions = useRef(0);
  const selections = useRef(0);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  // The key bar's held modifiers make the next character a chord for the pane, as they do in the
  // grid: it never lands in the line. They stay held afterwards, as the key bar's modifiers do.
  const heldRef = useRef(modifiers);
  heldRef.current = modifiers;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  /** the line and its caret as the open composition began (null with a selection): the one letter
   * a keyboard adds to it is the chord */
  const compositionBase = useRef<{ value: string; caret: number } | null>(null);
  /** the open composition's text as its last input had it */
  const compositionData = useRef("");
  // Gboard keeps a word open while Ctrl is tapped (the key bar keeps the focus), so a composition
  // can begin before any modifier is held: the line as Ctrl takes hold is the base the next letter
  // adds to, or "ab", Ctrl and a p would compare "abp" with "" and stay text.
  const heldBefore = useRef(modifiers);
  useEffect(() => {
    const before = heldBefore.current;
    heldBefore.current = modifiers;
    const element = box.current;
    if (hasModifiers(before) || !hasModifiers(modifiers) || !composing.current || element === null || element.selectionStart !== element.selectionEnd) return;
    compositionBase.current = { value: element.value, caret: element.selectionStart };
  }, [modifiers]);

  const [note, setNote] = useState<string | null>(null);
  /** a paste waiting on the clipboard, said under the line while it does */
  const [pending, setPending] = useState<string | null>(null);
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const textRef = useRef(text);
  textRef.current = text;

  /** The letter a composition begun on `base` added to the line, if that is a chord under the held modifiers. */
  const composedLetter = useCallback((base: { value: string; caret: number } | null, data: string): string | null => {
    const element = box.current;
    if (base === null || element === null) return null;
    return composedChordLetter(base.value, base.caret, element.value, data, heldRef.current);
  }, []);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // a soft keyboard's letter arrives without a keydown, as insertText: React's onBeforeInput is a
    // keypress polyfill, so the native event is the one to cancel
    const onBeforeInput = (event: InputEvent): void => {
      const send = keyRef.current;
      if (!send || event.inputType !== "insertText" || event.data === null || event.isComposing || composing.current) return;
      if (heldChord(event.data, heldRef.current, "typed") === null) return;
      event.preventDefault();
      send(event.data, heldRef.current);
    };
    // Gboard keeps the word it composes open until a space, and a composition's input cannot be
    // cancelled, so only a commit hands the letter over. Under a held modifier, once the
    // composition is the line plus that one letter, a focus change commits it (Chrome ends a
    // composition on blur and fires compositionend there), as a Send tapped mid-word does. With no
    // modifier held, or any other composition, the field is left alone.
    const onInput = (event: Event): void => {
      const { inputType, data } = event as InputEvent;
      if (!keyRef.current || inputType !== "insertCompositionText" || !composing.current) return;
      compositionData.current = data ?? "";
      if (!hasModifiers(heldRef.current)) return;
      const base = compositionBase.current;
      if (composedLetter(base, compositionData.current) === null) return;
      // after the keyboard's own input is done; still the same letter, still composing, still focused
      setTimeout(() => {
        if (!composing.current || compositionBase.current !== base || document.activeElement !== element || composedLetter(base, compositionData.current) === null) return;
        element.blur();
        element.focus({ preventScroll: true });
      });
    };
    element.addEventListener("beforeinput", onBeforeInput);
    element.addEventListener("input", onInput);
    return () => {
      element.removeEventListener("beforeinput", onBeforeInput);
      element.removeEventListener("input", onInput);
    };
  }, [composedLetter]);

  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    active,
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  // A Send tapped while the keyboard still composes the last word (Gboard composes every word,
  // CJK IMEs an open syllable) finishes that word and sends once it commits. The button keeps
  // focus and the selection, so nothing in the tap commits the word: a blur does (Chrome ends the
  // composition on a focus change and fires compositionend at once), and the refocus inside the
  // same gesture keeps the keyboard up. A keyboard that still does not commit by the tap's deadline
  // gets the tap withdrawn with a note, so a later commit never sends on its own.
  const attempt = useRef<SendAttempt | null>(null);
  const clearPendingSend = useCallback(() => {
    const current = attempt.current;
    if (current?.timer != null) clearTimeout(current.timer);
    attempt.current = null;
  }, []);
  useEffect(() => clearPendingSend, [clearPendingSend]);
  // a drop withdraws the tap: a quick reconnect inside the wait must not send it after all
  useEffect(() => {
    if (connected || attempt.current === null) return;
    clearPendingSend();
    setNote(t("Not sent: the terminal is disconnected."));
  }, [clearPendingSend, connected, t]);
  const sendRef = useRef<(deferred: boolean) => void>(() => {});

  /** Waits for the commit until the tap's deadline, with "Finishing the word…" up meanwhile. */
  const awaitCommit = useCallback((current: SendAttempt) => {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    const left = current.deadline - Date.now();
    if (left <= 0) {
      attempt.current = null;
      setNote(t("Finish the word, then send."));
      return;
    }
    setNote(t("Finishing the word…"));
    current.timer = setTimeout(() => {
      if (attempt.current !== current) return;
      attempt.current = null;
      setNote(t("Finish the word, then send."));
    }, left);
  }, [t]);

  const send = useCallback((deferred = false) => {
    // a deferred send runs only for a tap still waiting: a drop, a timeout or an emptied line withdrew it
    const current = attempt.current;
    if (deferred && current === null) return;
    if (!connected || terminalDraftSending(owner)) {
      // a send waiting for the commit must not leave "Finishing the word…" standing
      if (deferred) { clearPendingSend(); setNote(connected ? null : t("Not sent: the terminal is disconnected.")); }
      return;
    }
    if (composing.current) {
      if (deferred) {
        // a new composition after the commit: wait out what is left of the tap's window, no more
        awaitCommit(current!);
        return;
      }
      clearPendingSend();
      const tapped: SendAttempt = { timer: null, deadline: Date.now() + COMMIT_WAIT_MS, textSend: readTerminalDraft(owner).length > 0 };
      attempt.current = tapped;
      const element = box.current;
      if (element !== null && document.activeElement === element) {
        element.blur();
        element.focus({ preventScroll: true });
      }
      // committed inside the tap (Chrome, Gboard): compositionend already queued the send, no note
      if (composing.current && attempt.current === tapped) awaitCommit(tapped);
      return;
    }
    clearPendingSend();
    setNote(null);
    // the draft store, not the last render: a commit forced or delivered just now may not have rendered yet
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) {
      // a text Send whose word came out empty (the preedit deleted or cancelled) is not an Enter
      if (deferred && current!.textSend) return;
      const entered = onEnter();
      if (typeof entered === "string") setNote(entered);
      else if (!entered) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(draft);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    // a polish that lands before the acknowledgement would read as text typed meanwhile, and
    // leave the sent command in the line
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        acknowledgeTerminalDraft(owner);
      } else setNote(result);
    }).catch(() => setNote(t("Not confirmed. Check the terminal before sending again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [awaitCommit, clearPendingSend, connected, dictation.forget, onEnter, onSend, owner, t]);
  sendRef.current = send;

  /**
   * Types the line into the pane without Enter. The line clears only once the bridge says herdr
   * has the bytes, and then only the text that was sent: what was typed meanwhile stays, as after
   * Send. A refusal, a drop or no answer keeps the line with a note; nothing is tried again.
   */
  const insert = useCallback(() => {
    if (!connected || terminalDraftSending(owner)) return;
    // an open composition is the keyboard's: the committed word goes, not the preedit
    if (composing.current) { setNote(t("Finish the word, then insert.")); return; }
    clearPendingSend();
    setNote(null);
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) return;
    // one line: nothing reports whether the program takes several as one paste, and a shell would
    // run each (shared/terminal-insert.ts), so a block is said here and nothing is sent
    if (/[\r\n]/.test(draft)) { setNote(t("Insert takes one line. Send several lines, or insert them one at a time.")); return; }
    const sent = onInsert(draft);
    if (sent === false) { setNote(t("Not inserted: the terminal is disconnected.")); return; }
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) acknowledgeTerminalDraft(owner);
      else setNote(result);
    }).catch(() => setNote(t("Not confirmed: the terminal did not confirm the text. Check it before inserting again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [clearPendingSend, connected, dictation.forget, onInsert, owner, t]);

  /**
   * A paste into the line waits on something (the clipboard's answer, an upload), so what it is for
   * is captured before it waits: the PC, pane, connection, role and input lease; the draft as
   * written; where the caret is; the compositions so far. An answer that comes after any of them
   * changed, even and back again (a selection moved, a composition begun and ended with nothing
   * written, the pane's input lost and given again), or for a line no longer shown, is dropped with
   * a note. Null, with the note said, when the pane cannot take a paste now. `native`: the keyboard's
   * own Paste, whose selection the browser collapses to its end after the paste event (Chrome on
   * Android, even with the paste prevented): that collapse is the paste's own, not a move.
   */
  const pasting = useRef(false);
  const beginPaste = useCallback((element: HTMLTextAreaElement, waiting: string, native = false) => {
    const target = pasteTarget?.() ?? null;
    if (target === null) { setNote(t("Not pasted: the terminal is not ready.")); return null; }
    const version = terminalDraftVersion(owner);
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const composed = compositions.current;
    const selected = selections.current;
    /** where the paste found the selection, or where the keyboard's own Paste leaves it */
    const atPaste = (from: number, to: number): boolean => (from === start && to === end) || (native && from === end && to === end);
    // a caret moved in the focused line, by touch or by script, while the paste waits; each move
    // reported counts, so a move and back reported on the way still drops the paste. Chrome on
    // Android reports a selectionchange just after the keyboard's own Paste with the caret where it
    // was, or a range collapsed to its end: neither is a move
    let seen = [start, end];
    let first = true;
    const moved = (): void => {
      if (document.activeElement !== element) return;
      const from = element.selectionStart;
      const to = element.selectionEnd;
      if (from === seen[0] && to === seen[1]) return;
      const own = first && atPaste(from, to);
      first = false;
      seen = [from, to];
      if (!own) selections.current += 1;
    };
    document.addEventListener("selectionchange", moved);
    pasting.current = true;
    onPasting?.(true);
    setNote(null);
    setPending(waiting);
    /** the line is still there to answer in */
    const shown = (): boolean => mounted.current && box.current === element;
    /** the line, its caret, a composition or the pane changed since the paste began, even and back again */
    const stale = (): boolean => composing.current || compositions.current !== composed || selections.current !== selected
      || !atPaste(element.selectionStart, element.selectionEnd)
      || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== version;
    const changed = t("Not pasted: the line or the terminal changed meanwhile. Paste again.");
    return {
      shown,
      /** true, with the note said, when the paste no longer has its line as it found it */
      dropped(): boolean {
        if (!shown()) return true;
        if (!stale()) return false;
        setNote(changed);
        return true;
      },
      /** says why the paste did not land, while the line is there to say it */
      fail(note: string): void { if (shown()) setNote(note); },
      /** the text at the selection the paste found, or a note why it was dropped; `whole` (file
       * paths) goes in entire or not at all: a path cut at the line's limit names no file */
      place(clip: string, whole = false): void {
        if (!shown()) return;
        if (stale()) { setNote(changed); return; }
        const text = clip.replace(/\r\n?/g, "\n");
        const current = readTerminalDraft(owner);
        const next = current.slice(0, start) + text + current.slice(end);
        if (whole && next.length > TERMINAL_LINE_LIMIT) { setNote(t("Not pasted: the line has no room for the file's path. Shorten it, then paste again.")); return; }
        writeTerminalDraft(owner, next);
        const written = readTerminalDraft(owner);
        const cut = next.length - written.length;
        setNote(cut > 0 ? t("Pasted up to the line's limit: {n} characters were left out.", { n: cut }) : null);
        const caret = Math.min(start + text.length, written.length);
        const pasted = terminalDraftVersion(owner);
        requestAnimationFrame(() => {
          // another pane picked, or the line written again, before the frame: its focus is not taken back
          if (box.current !== element || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== pasted) return;
          element.focus({ preventScroll: true });
          element.setSelectionRange(caret, caret);
        });
      },
      finish(): void {
        document.removeEventListener("selectionchange", moved);
        pasting.current = false;
        // an unmounted line already gave the bar's Paste back (below): a later line may be pasting now
        if (!mounted.current) return;
        onPasting?.(false);
        setPending(null);
      },
    };
  }, [onPasting, owner, pasteTarget, t]);

  /**
   * Files pasted into the line (a screenshot from the keyboard's own Paste, an image the key bar
   * read): uploaded beside the pane one after another, as a paste into the grid is
   * (useTerminalMount.ts), and their quoted paths put in the line at the caret, to send or edit.
   * One file over the limit and none is uploaded.
   */
  const uploadPaths = useCallback(async (files: Blob[]): Promise<string> => {
    const paths: string[] = [];
    for (const file of files) paths.push(await uploadFile!(file));
    return paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ";
  }, [uploadFile]);
  const uploadFailed = useCallback((error: unknown): string => error instanceof AttachmentTooLargeError ? error.message : plainError(error), []);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    // text, a copied path included, is the browser's own paste
    if (event.clipboardData.getData("text/plain")) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || uploadFile === undefined) return;
    event.preventDefault();
    if (pasting.current) { setNote(t("Wait for the paste on its way, then paste again.")); return; }
    if (composing.current) { setNote(t("Finish the word, then paste.")); return; }
    try {
      for (const file of files) assertAttachable(file);
    } catch (error) {
      setNote(uploadFailed(error));
      return;
    }
    const waiting = beginPaste(event.currentTarget, t("Uploading file…"), true);
    if (waiting === null) return;
    uploadPaths(files).then((paths) => waiting.place(paths, true), (error: unknown) => waiting.fail(uploadFailed(error))).finally(waiting.finish);
  };

  /**
   * The key bar's Paste: the clipboard is read from the user's tap and for this line alone, at the
   * selection the tap found (beginPaste above), since the browser may hold the read for a permission
   * prompt. Text goes in as written; an image on the clipboard, read where the browser has
   * clipboard.read(), is uploaded and its path goes in, as the keyboard's own Paste does. A browser
   * that reads only text says where an image can be pasted instead of calling the clipboard empty.
   * A refused or missing clipboard says to use the keyboard's own paste; nothing is read in the
   * background or retried.
   */
  const paste = useCallback(() => {
    const element = box.current;
    if (pasting.current || element === null) return;
    if (composing.current) { setNote(t("Finish the word, then paste.")); return; }
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const readsFiles = typeof clipboard?.read === "function" && uploadFile !== undefined;
    if (!readsFiles && typeof clipboard?.readText !== "function") { setNote(t("Paste is not available here. Use the keyboard's own paste in the input line.")); return; }
    const waiting = beginPaste(element, t("Reading the clipboard…"));
    if (waiting === null) return;
    const read: Promise<{ text: string } | { image: Blob }> = readsFiles
      ? clipboard!.read().then(async (items) => {
        // text first, as a paste into the grid: an image copied from a page often carries its address
        // too. An empty text beside an image is no text
        const texts = items.filter((item) => item.types.includes("text/plain"));
        const text = (await Promise.all(texts.map(async (item) => (await item.getType("text/plain")).text()))).join("");
        if (text.length > 0) return { text };
        for (const item of items) {
          const type = item.types.find((kind) => kind.startsWith("image/"));
          if (type !== undefined) return { image: await item.getType(type) };
        }
        return { text };
      })
      : clipboard!.readText().then((text) => ({ text }));
    read.then(async (clip) => {
      if (!waiting.shown()) return;
      if ("image" in clip) {
        // nothing uploaded for a line that changed while the clipboard answered
        if (waiting.dropped()) return;
        try {
          assertAttachable(clip.image);
        } catch (error) {
          waiting.fail(uploadFailed(error));
          return;
        }
        setPending(t("Uploading file…"));
        await uploadPaths([clip.image]).then((paths) => waiting.place(paths, true), (error: unknown) => waiting.fail(uploadFailed(error)));
        return;
      }
      if (clip.text.length === 0) {
        waiting.fail(readsFiles ? t("Nothing to paste: the clipboard is empty.") : t("No text on the clipboard. To paste an image, press and hold the input line, then choose Paste."));
        return;
      }
      waiting.place(clip.text);
    }, () => {
      waiting.fail(t("The clipboard could not be read. Use the keyboard's own paste in the input line."));
    }).finally(waiting.finish);
  }, [beginPaste, uploadFailed, uploadFile, uploadPaths, t]);
  // the mode switch's handoff (useTerminalSends): a focus alone, no selection reset, keyboard and caret where they were
  const focus = useCallback((): boolean => {
    const element = box.current;
    if (element === null) return false;
    element.focus({ preventScroll: true });
    return true;
  }, []);
  useImperativeHandle(ref, () => ({ paste, focus }), [paste, focus]);
  // a paste that outlives the line (a pane switch, the masked input taking its place) is dropped above; the bar's Paste comes back
  const pastingCallback = useRef(onPasting);
  pastingCallback.current = onPasting;
  useEffect(() => () => { if (pasting.current) pastingCallback.current?.(false); }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // a held key-bar modifier, or a hardware Ctrl+letter such as Ctrl+P (the agent's, not the
    // browser's print dialog), goes to the pane as a chord; the field keeps its editing keys, and
    // does the line's own Ctrl letters itself
    const native = event.nativeEvent;
    const field = event.currentTarget;
    const appShortcut = !composing.current && isAppShortcut(native, settings.shortcutOverrides);
    if (onKey && !composing.current && !appShortcut) {
      const typed = fieldKeyChord(native, modifiers, isMacPlatform(), field.value.length === 0);
      if (typed !== null) {
        event.preventDefault();
        onKey(typed.key, typed.modifiers);
        return;
      }
    }
    // the line's own Ctrl+H, I, J, M, D and S: never the browser's History, Downloads, bookmark or Save page
    const line = composing.current || appShortcut ? null : fieldLineKey(native, modifiers, isMacPlatform(), field.value.length === 0);
    if (line !== null) {
      event.preventDefault();
      if (line === "send") send();
      else if (line === "newline") document.execCommand("insertText", false, "\n");
      else if (line === "delete" && !document.execCommand("delete") && field.selectionEnd > 0) {
        const end = field.selectionEnd;
        const start = field.selectionStart === end ? end - 1 : field.selectionStart;
        field.setRangeText("", start, end, "end");
        setText(field.value);
      }
      return;
    }
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || native.isComposing || native.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  /** Takes the chord's letter back out of the line with the field's own delete, which keeps it on the undo stack where the browser allows. */
  const removeLetter = (element: HTMLTextAreaElement, at: number): void => {
    element.setSelectionRange(at, at + 1);
    const deleted = document.activeElement === element && document.execCommand("delete");
    if (!deleted) element.setRangeText("", at, at + 1, "end");
    element.setSelectionRange(at, at);
    // the draft store, not the next render: a Send waiting on this commit reads it next
    setText(element.value);
  };

  /** A composition that committed the line plus one letter under a held modifier: the pane gets the chord, the line loses the letter. */
  const takeComposedLetter = (data: string): void => {
    const base = compositionBase.current;
    compositionBase.current = null;
    if (!onKey || base === null) return;
    let composed: string | null = null;
    const take = (): void => {
      const element = box.current;
      // a new composition owns the line now
      if (element === null || composing.current) return;
      if (composed === null) {
        const letter = composedLetter(base, data);
        if (letter === null) return;
        composed = element.value;
        keyRef.current?.(letter, heldRef.current);
      }
      // only the line as it committed loses the letter: text typed since stays as it is
      if (element.value === composed) removeLetter(element, base.caret);
    };
    take();
    // WebKit updates the value with an input event after compositionend: look again after it
    setTimeout(take);
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  const fieldId = useId();
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}${compact ? " is-compact" : ""}${compact && keyBar ? " has-keys" : ""}`}
      // a compact field is shorter than a finger: a press on the bar around it is a press on it
      onClick={compact ? (event) => { if (event.target === event.currentTarget) box.current?.focus(); } : undefined}>
      {/* the field's name in view, not only its placeholder: the same words as the key bar's mode key
          (a compact line keeps it for assistive technology only, TerminalInput.css) */}
      <label className="terminal-input-label" htmlFor={fieldId}>{t("Input line")}</label>
      <textarea
        ref={box}
        id={fieldId}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={(event) => {
          composing.current = true;
          compositions.current += 1;
          onComposing?.(true);
          const element = event.currentTarget;
          compositionBase.current = element.selectionStart === element.selectionEnd ? { value: element.value, caret: element.selectionStart } : null;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          compositions.current += 1;
          onComposing?.(false);
          takeComposedLetter(event.data);
          const current = attempt.current;
          if (current === null) return;
          if (current.timer !== null) clearTimeout(current.timer);
          current.timer = null;
          // WebKit updates the value with an input event after compositionend: send the committed word
          setTimeout(() => sendRef.current(true));
        }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        // the keyboard's word strip too: Chrome on Android hands the keyboard NO_SUGGESTIONS only
        // for autocomplete="off", never for autocorrect or spellcheck
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setNote(null);
          // an emptied line has nothing left for a waiting Send to send
          if (event.target.value.length === 0) clearPendingSend();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <span className="terminal-input-actions">
        {/* Insert, apart from Send by its words, its outline and its name: the text goes to the
            prompt and stays there to edit. Each says what it does above its round target */}
        <button
          type="button"
          className="terminal-input-action terminal-input-insert"
          aria-label={t("Insert text without Enter")}
          title={t("Insert text without Enter")}
          disabled={!connected || sending || text.length === 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={insert}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t("Insert text")}</span>
          <span className="terminal-input-face"><TextCursorInput aria-hidden="true" /></span>
        </button>
        <button
          type="button"
          className="terminal-input-action terminal-input-send"
          aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          disabled={!connected || sending}
          // the soft keyboard stays up for the next line
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send()}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t(text.length === 0 ? "Enter" : "Send")}</span>
          <span className="terminal-input-face">{text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}</span>
        </button>
        {compact && keyBar && (
          <button
            type="button"
            className="terminal-input-keys"
            aria-label={t("Terminal keys")}
            title={t("Terminal keys")}
            aria-pressed={keyBar.shown}
            // the soft keyboard stays up, as for Send
            onPointerDown={(event) => event.preventDefault()}
            onClick={keyBar.onToggle}
          >
            {keyBar.shown ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </button>
        )}
      </span>
      {pending !== null && note === null && <p className="terminal-input-note is-pending" role="status">{pending}</p>}
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
