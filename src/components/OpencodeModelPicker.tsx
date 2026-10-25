import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Cpu, LoaderCircle } from "lucide-react";

import "./OpencodeModelPicker.css";

import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { opencodeModelMatches, opencodeModelName } from "../lib/opencodeModels.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { OpencodeModelCatalog } from "../../shared/protocol.ts";

export type Switch = { kind: "idle" } | { kind: "switching"; name: string } | { kind: "failed"; code: string | null; detail: string; leftOpen?: boolean };

/** The failures that only a hand in the terminal can get past: the chip offers the terminal for them. */
const TERMINAL_FAILURES = new Set(["not_ready", "pane_error", "dialog_not_opened", "model_not_found", "not_confirmed", "timeout", "dialog_open"]);

/**
 * The model of an OpenCode 1.x pane, as a chip in the composer's row: it names the model the TUI's
 * footer shows and opens a list of the models OpenCode offers, grouped by provider, to search and
 * pick from, as the Codex and Claude apps put their model menu in the composer. A pick is made in
 * the TUI itself (POST /api/pane/opencode-model drives its own "Select model" dialog); what could
 * not be done there is said, with the terminal one tap away. Drawn only while the bridge lists the
 * pane's models (OpenCode's 1.x HTTP source is configured, server/opencode-model.ts).
 */
export function OpencodeModelPicker({ paneId, busy, disabled, onOpenTerminal, initial }: {
  paneId: string;
  busy: boolean;
  disabled: boolean;
  onOpenTerminal?: (() => void) | undefined;
  /** what the first render starts from, before any read (a test renders it without effects) */
  initial?: { catalog?: OpencodeModelCatalog; open?: boolean; query?: string; state?: Switch };
}) {
  const t = useT();
  const { fetchPaneOpencodeModels, selectPaneOpencodeModel } = useMachineApi();
  const [catalog, setCatalog] = useState<OpencodeModelCatalog | null>(initial?.catalog ?? null);
  const [open, setOpen] = useState(initial?.open ?? false);
  const [query, setQuery] = useState(initial?.query ?? "");
  const [state, setState] = useState<Switch>(initial?.state ?? { kind: "idle" });
  const [reload, setReload] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  usePhoneSheetBack(() => setOpen(false), open);

  // read when the pane shows, each time the list opens (the model may have changed in the terminal), and after a pick
  useEffect(() => {
    let alive = true;
    fetchPaneOpencodeModels(paneId).then((found) => { if (alive) setCatalog(found); }, () => undefined);
    return () => { alive = false; };
  }, [paneId, open, reload, fetchPaneOpencodeModels]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  // the list opens upward from the card and keeps to the room above it, as the background tasks' list does
  useLayoutEffect(() => {
    const list = menu.current;
    const anchor = list?.offsetParent;
    const composer = anchor?.closest(".composer") ?? null;
    const frame = (composer ?? anchor)?.parentElement;
    if (!open || !list || !anchor || !frame) return;
    const measure = (): void => list.style.setProperty("--oc-model-room", `${anchor.getBoundingClientRect().top - frame.getBoundingClientRect().top}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) { setQuery(""); return; }
    // a finger's tap would open the soft keyboard over the list: only a pointer that hovers starts in the search
    if (window.matchMedia("(hover: hover)").matches) search.current?.focus({ preventScroll: true });
  }, [open]);

  const groups = useMemo(() => (catalog?.providers ?? []).map((provider) => ({
    provider,
    models: provider.models.filter((model) => opencodeModelMatches(query, provider, model)),
  })).filter((group) => group.models.length > 0), [catalog, query]);

  if (catalog === null || !catalog.available) return null;

  const current = catalog.current;
  const currentName = opencodeModelName(catalog, current);
  const switching = state.kind === "switching";
  const blocked = busy || disabled;

  const pick = async (providerId: string, modelId: string, name: string): Promise<void> => {
    if (switching || blocked) return;
    setState({ kind: "switching", name });
    try {
      await selectPaneOpencodeModel({ pane_id: paneId, provider_id: providerId, model_id: modelId });
      setState({ kind: "idle" });
      setOpen(false);
      toggle.current?.focus({ preventScroll: true });
    } catch (error) {
      setState({ kind: "failed", code: error instanceof ApiError ? error.code : null, detail: error instanceof ApiError ? error.detail : String(error), leftOpen: error instanceof ApiError && error.dialogLeftOpen });
    } finally {
      setReload((count) => count + 1);
    }
  };

  const failure = state.kind !== "failed" ? null
    // the switch stopped with a dialog still open in OpenCode, its model list maybe: ctrl+x m would type into it
    : state.leftOpen ? t("A dialog was left open in OpenCode. Press Enter or Escape in the terminal.")
    : state.code === "busy" ? t("OpenCode is working. Switch the model once it is idle.")
    : state.code === "dialog_open" ? t("A dialog is open in OpenCode. Close it in the terminal first.")
    : state.code !== null && TERMINAL_FAILURES.has(state.code) ? t("Couldn't switch the model in OpenCode. Choose it in the terminal with ctrl+x m.")
    : state.detail;
  const terminalOffered = state.kind === "failed" && onOpenTerminal !== undefined && (state.leftOpen === true || (state.code !== null && TERMINAL_FAILURES.has(state.code)));
  const label = currentName ?? t("Model");

  return <span className="oc-model" ref={root}>
    <button type="button" ref={toggle} className="oc-model-toggle" aria-expanded={open} aria-controls={id}
      aria-label={currentName === null ? t("Choose the OpenCode model") : t("Model: {model}", { model: currentName })}
      title={currentName === null ? t("Choose the OpenCode model") : t("Model: {model}", { model: currentName })}
      onClick={() => { setOpen(!open); if (state.kind === "failed") setState({ kind: "idle" }); }}>
      {switching ? <LoaderCircle className="oc-model-progress" aria-hidden="true" /> : <Cpu aria-hidden="true" />}
      <span className="oc-model-label">{label}</span>
    </button>
    {open && <div id={id} ref={menu} className="menu oc-model-menu" role="dialog" aria-label={t("Choose the OpenCode model")}>
      <input ref={search} type="search" className="input oc-model-search" value={query} placeholder={t("Search models")} aria-label={t("Search models")}
        autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      <div className="oc-model-status" role="status">
        {switching && <p className="oc-model-note">{t("Switching to {model}…", { model: state.name })}</p>}
        {!switching && busy && <p className="oc-model-note">{t("OpenCode is working. Switch the model once it is idle.")}</p>}
        {failure !== null && <p className="oc-model-note is-error">{failure}{terminalOffered && <>
          {" "}<button type="button" className="oc-model-terminal" onClick={() => { setOpen(false); onOpenTerminal?.(); }}>{t("Open Terminal")}</button>
        </>}</p>}
      </div>
      <div className="oc-model-list">
        {groups.length === 0 && <p className="oc-model-note">{t("No models match")}</p>}
        {groups.map(({ provider, models }) => <div key={provider.id} role="group" aria-label={provider.name}>
          <div className="menu-heading">{provider.name}</div>
          {models.map((model) => {
            const inUse = current?.provider_id === provider.id && current.model_id === model.id;
            return <button key={model.id} type="button" className="menu-item oc-model-row" aria-current={inUse || undefined}
              disabled={blocked || switching} title={`${provider.id}/${model.id}`}
              onClick={() => { void pick(provider.id, model.id, model.name); }}>
              <span className="menu-item-main">{model.name}</span>
              {inUse && <><Check className="oc-model-check" aria-hidden="true" /><span className="visually-hidden">{t("In use")}</span></>}
            </button>;
          })}
        </div>)}
      </div>
    </div>}
  </span>;
}
