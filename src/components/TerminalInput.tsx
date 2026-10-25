import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft } from "../lib/terminalDraft.ts";

import { useT } from "../lib/i18n.ts";
import { composedChordLetter, fieldKeyChord, fieldLineKey, hasModifiers, heldChord, NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
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
export function TerminalInput({ owner, active = true, connected, onSend, onEnter, onComposing, onFocus, compact = false, keyBar, modifiers = NO_STICKY_MODIFIERS, onKey }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    // Read the owner record even after unmount: a late acknowledgement must not erase
    // edits made in a newly mounted input for the same pane.
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
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
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
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
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}${compact ? " is-compact" : ""}${compact && keyBar ? " has-keys" : ""}`}
      // a compact field is shorter than a finger: a press on the bar around it is a press on it
      onClick={compact ? (event) => { if (event.target === event.currentTarget) box.current?.focus(); } : undefined}>
      <textarea
        ref={box}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={(event) => {
          composing.current = true;
          onComposing?.(true);
          const element = event.currentTarget;
          compositionBase.current = element.selectionStart === element.selectionEnd ? { value: element.value, caret: element.selectionStart } : null;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
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
        onFocus={onFocus}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <button
        type="button"
        className="terminal-input-send"
        aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        disabled={!connected || sending}
        // the soft keyboard stays up for the next line
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => send()}
      >
        {text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
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
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
