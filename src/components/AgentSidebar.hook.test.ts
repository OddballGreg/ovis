import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { SettingsProvider, useSettings, type Settings } from "../lib/settings.ts";
import { SETTINGS_STORAGE_KEY } from "../lib/themeBoot.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const pane: HerdrPane = {
  pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-w1:p1", focused: false, revision: 1, agent: "claude", agent_status: "idle",
};
const machine: Machine = {
  id: "local", name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot: {
    protocol: 22, version: "0.9.5", layouts: [], panes: [pane],
    agents: [{ pane_id: pane.pane_id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: pane.terminal_id, focused: false, revision: 1, agent: "claude", agent_status: "idle" }],
    workspaces: [{ workspace_id: "w1", label: "checkout-api", number: 1, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" }],
  },
};

describe("AgentSidebar fold on a phone", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let renderer: ReactTestRenderer | null;
  let update: (patch: Partial<Settings>) => void;
  let settingsNow: Settings;
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    renderer = null;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    // a phone: the drawer query matches
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      requestAnimationFrame: () => 0, cancelAnimationFrame() {},
      addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  function Probe(): null {
    const value = useSettings();
    update = value.update;
    settingsNow = value.settings;
    return null;
  }
  const mount = (): void => {
    act(() => {
      renderer = create(createElement(SettingsProvider, {
        children: [
          createElement(Probe, { key: "probe" }),
          createElement(AgentSidebar, { key: "agents", machines: [machine], selectedMachineId: "local", selectedPaneId: null, stateWord: () => "disconnected", onSelect: () => {} }),
        ],
      }));
    });
  };
  const folded = (): boolean => renderer!.root.find((node) => node.props.className === "agent-list-contents").props.hidden === true;
  const toggle = (): void => {
    act(() => renderer!.root.find((node) => typeof node.props.className === "string" && node.props.className.startsWith("agent-section-toggle")).props.onClick());
  };
  const set = (patch: Partial<Settings>): void => {
    act(() => update(patch));
  };

  test("a setting that arrives after the first render, as the shared preferences do, folds or unfolds the list", () => {
    mount();
    expect(settingsNow.agentsDrawerFold).toBe("folded");
    expect(folded()).toBe(true);
    // the shared preferences arrive with Unfolded (lib/preferencesSync.ts patches the settings)
    set({ agentsDrawerFold: "open" });
    expect(folded()).toBe(false);
    set({ agentsDrawerFold: "folded" });
    expect(folded()).toBe(true);
  });

  test("the user's own fold stays until the setting's value changes", () => {
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ agentsDrawerFold: "open" }));
    mount();
    expect(settingsNow.agentsDrawerFold).toBe("open");
    expect(folded()).toBe(false);
    toggle();
    expect(folded()).toBe(true);
    // another setting, or the same value again, leaves the user's fold alone
    set({ agentOrder: "activity" });
    set({ agentsDrawerFold: "open" });
    expect(folded()).toBe(true);
    set({ agentsDrawerFold: "folded" });
    expect(folded()).toBe(true);
    toggle();
    expect(folded()).toBe(false);
    set({ agentsDrawerFold: "open" });
    expect(folded()).toBe(false);
    set({ agentsDrawerFold: "folded" });
    expect(folded()).toBe(true);
  });
});
