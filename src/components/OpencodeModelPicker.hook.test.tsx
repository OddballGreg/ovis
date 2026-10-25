import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { OpencodeModelCatalog, OpencodeModelRequest } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { OpencodeModelPicker } from "./OpencodeModelPicker.tsx";

type Shown = { id: string; name: string } | null;

const providers: OpencodeModelCatalog["providers"] = [
  { id: "go", name: "OpenCode Go", models: [{ id: "kimi-k3", name: "Kimi K3" }, { id: "haiku", name: "Claude Haiku 5.5" }] },
  { id: "duo", name: "GitLab Duo", models: [{ id: "opus-5", name: "Agentic Chat (Claude Opus 5)" }] },
];
const OPUS: Shown = { id: "duo/opus-5", name: "Agentic Chat (Claude Opus 5)" };
const KIMI: Shown = { id: "go/kimi-k3", name: "Kimi K3" };
const HAIKU: Shown = { id: "go/haiku", name: "Claude Haiku 5.5" };

// React, the picker, useMachineApi and the API functions stay real: only the network (the bridge's
// GET /api/pane/opencode-models and POST /api/pane/opencode-model) and the DOM globals are stand-ins
describe("the OpenCode model chip reports the TUI's model to the composer", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  /** what the TUI's footer names now: a pick or the terminal changes it */
  let footer: { provider_id: string; model_id: string } | null;
  let reads: number;
  let picks: OpencodeModelRequest[];
  /** while set, the next read waits for it: a read still on its way */
  let holdRead: Promise<void> | null;
  /** while set, a pick's POST waits for it */
  let holdPick: Promise<void> | null;
  let visibility: DocumentVisibilityState;
  let intervals: Map<number, { fn: () => void; ms: number }>;
  let errors: unknown[][];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    renderers = []; footer = { provider_id: "duo", model_id: "opus-5" }; reads = 0; picks = []; holdRead = null; holdPick = null;
    visibility = "visible"; intervals = new Map(); errors = [];
    let nextInterval = 1;
    const records = new Map<string, string>();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      setInterval: (fn: () => void, ms: number) => { const id = nextInterval++; intervals.set(id, { fn, ms }); return id; },
      clearInterval: (id: number) => { intervals.delete(id); },
      addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      activeElement: null,
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (name: string) => (name === "--bg" ? "#12100e" : "") }) });
    const bridge = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/pane/opencode-models?")) {
        reads++;
        // the footer as it was when the read was asked; a held read keeps it, and only the next read waits
        const current = footer, hold = holdRead;
        holdRead = null;
        if (hold) await hold;
        return Response.json({ available: true, providers, current } satisfies OpencodeModelCatalog);
      }
      if (url.includes("/pane/opencode-model") && init?.method === "POST") {
        const request: OpencodeModelRequest = JSON.parse(String(init.body));
        picks.push(request);
        if (holdPick) await holdPick;
        footer = { provider_id: request.provider_id, model_id: request.model_id };
        return Response.json({ ok: true, model: { provider_id: request.provider_id, model_id: request.model_id } });
      }
      return new Response("not found", { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(bridge, { preconnect: globalThis.fetch.preconnect }));
    const error = console.error;
    spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      // the renderer's own notice on each create, not the chip's
      if (typeof args[0] === "string" && args[0].startsWith("react-test-renderer is deprecated")) return;
      errors.push(args); error(...args);
    });
  });

  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    jest.restoreAllMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  /** lets the fake bridge's answers and the effects they cause land */
  const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

  async function mount(busy = false) {
    const reports: Shown[] = [];
    const onCurrent = (model: Shown): void => { reports.push(model); };
    const element = (busy: boolean) => createElement(SettingsProvider, { children: createElement(OpencodeModelPicker, { paneId: "w1:p1", busy, disabled: false, onCurrent }) });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(element(busy)); });
    if (!renderer) throw new Error("the chip did not mount");
    const mounted = renderer;
    renderers.push(mounted);
    await settle();
    const button = (match: (node: ReactTestInstance) => boolean): ReactTestInstance => mounted.root.find((node) => node.type === "button" && match(node));
    return {
      reports,
      get last(): Shown | undefined { return reports.at(-1); },
      async busy(next: boolean): Promise<void> { await act(async () => { mounted.update(element(next)); }); await settle(); },
      async toggle(): Promise<void> { await act(async () => { button((node) => node.props.className === "oc-model-toggle").props.onClick(); }); await settle(); },
      /** taps a row and lets nothing land yet */
      async click(id: string): Promise<void> { await act(async () => { button((node) => node.props.title === id).props.onClick(); }); },
      async pick(id: string): Promise<void> { await this.click(id); await settle(); },
      async unmount(): Promise<void> {
        await act(async () => { mounted.unmount(); });
        renderers.splice(renderers.indexOf(mounted), 1);
      },
    };
  }

  async function tick(): Promise<void> {
    await act(async () => { for (const { fn } of intervals.values()) fn(); });
    await settle();
  }

  it("reports the footer's model after the first read", async () => {
    const chip = await mount();
    expect(reads).toBe(1);
    expect(chip.reports).toEqual([null, OPUS]);
  });

  it("reports the picked model from the read after a pick, with one read for it", async () => {
    const chip = await mount();
    await chip.toggle();
    expect(reads).toBe(2);
    await chip.pick("go/kimi-k3");
    expect(picks).toEqual([{ pane_id: "w1:p1", provider_id: "go", model_id: "kimi-k3" }]);
    // the pick closes the list and asks for a read in one render: one read, not one for each
    expect(reads).toBe(3);
    expect(chip.last).toEqual(KIMI);
    expect(chip.reports.filter((model) => model !== null)).toEqual([OPUS, KIMI]);
  });

  it("reads again when a turn starts or ends, for a model chosen in the terminal", async () => {
    const chip = await mount();
    footer = { provider_id: "go", model_id: "haiku" };
    await chip.busy(true);
    expect(reads).toBe(2);
    expect(chip.last).toEqual(HAIKU);
    await chip.busy(false);
    expect(reads).toBe(3);
    // the same model again is not reported again
    expect(chip.reports).toEqual([null, OPUS, HAIKU]);
  });

  it("does not let a slower earlier read put back the model a later read replaced", async () => {
    const chip = await mount();
    let release!: () => void;
    holdRead = new Promise<void>((resolve) => { release = resolve; });
    await chip.busy(true);
    footer = { provider_id: "go", model_id: "kimi-k3" };
    await chip.busy(false);
    expect(reads).toBe(3);
    expect(chip.last).toEqual(KIMI);
    release();
    await settle();
    expect(chip.last).toEqual(KIMI);
    expect(chip.reports).toEqual([null, OPUS, KIMI]);
  });

  it("reads again every 20 seconds while the page is shown, and not while it is hidden", async () => {
    const chip = await mount();
    expect([...intervals.values()].map(({ ms }) => ms)).toEqual([20_000]);
    footer = { provider_id: "go", model_id: "kimi-k3" };
    visibility = "hidden";
    await tick();
    expect(reads).toBe(1);
    expect(chip.last).toEqual(OPUS);
    visibility = "visible";
    await tick();
    expect(reads).toBe(2);
    expect(chip.last).toEqual(KIMI);
  });

  it("reports null when it unmounts, stops its timer, and a read still on its way reports nothing after", async () => {
    const chip = await mount();
    let release!: () => void;
    holdRead = new Promise<void>((resolve) => { release = resolve; });
    footer = { provider_id: "go", model_id: "haiku" };
    await chip.busy(true);
    expect(reads).toBe(2);
    await chip.unmount();
    expect(chip.reports).toEqual([null, OPUS, null]);
    expect(intervals.size).toBe(0);
    release();
    await settle();
    expect(chip.reports).toEqual([null, OPUS, null]);
  });

  it("warns of nothing when it unmounts with a pick still on its way", async () => {
    const chip = await mount();
    await chip.toggle();
    let release!: () => void;
    holdPick = new Promise<void>((resolve) => { release = resolve; });
    await chip.click("go/haiku");
    expect(picks).toHaveLength(1);
    await chip.unmount();
    release();
    await settle();
    expect(chip.last).toBeNull();
    expect(errors).toEqual([]);
  });

  it("warns of nothing through mount, reads, a pick and unmount", async () => {
    const chip = await mount();
    await chip.toggle();
    await chip.pick("go/haiku");
    await chip.busy(true);
    await tick();
    await chip.unmount();
    expect(chip.last).toBeNull();
    expect(errors).toEqual([]);
  });
});
