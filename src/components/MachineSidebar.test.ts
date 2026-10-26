import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { MachineSidebar } from "./MachineSidebar.tsx";

const pane: HerdrPane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false, revision: 1, agent: "claude", agent_status: "idle" };
const snapshot: SessionSnapshot = {
  protocol: 22, version: "0.9.5", layouts: [], panes: [pane],
  agents: [{ pane_id: pane.pane_id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false, revision: 1, agent: "claude", agent_status: "idle" }],
  workspaces: [{ workspace_id: "w1", label: "checkout-api", number: 1, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: 1, agent_status: "idle" }],
};
const machine: Machine = { id: "local", name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot };
const activity: SidebarActivity = { seqs: () => new Map(), status: (_machineId, row) => row.agent_status };

const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

/** The sidebar as a first render draws it, on a phone's drawer or a desktop, with these settings stored. */
function render(stored: object, drawer: boolean): string {
  const records: Record<string, string> = {
    "ovis:settings": JSON.stringify(stored),
    // the PC's workspaces are folded, so the render needs no workspace tree
    "ovis:pc-collapsed:local": "1",
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: (query: string) => ({ matches: drawer && query === "(max-width: 768px)", addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: (key: string) => records[key] ?? null, setItem() {} },
    addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  return renderToStaticMarkup(createElement(SettingsProvider, {
    children: createElement(MachineSidebar, {
      machines: [machine], selectedMachineId: "local", selectedPaneId: null, activity, actions: { openSettings() {} } as unknown as AppActions,
      onSelect() {}, onNew() {}, onSetup() {},
    }),
  }));
}

/** the class list of the first element with this class */
const classesOf = (html: string, name: string): string[] =>
  html.match(new RegExp(`class="((?:[^"]* )?${name}(?: [^"]*)?)"`))?.[1]?.split(" ") ?? [];

describe("MachineSidebar Agents placement", () => {
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  test("by default the Agents list is docked above the footer, beside the workspace list's own scroll", () => {
    const html = render({}, false);
    expect(classesOf(html, "sidebar-shell")).not.toContain("is-agents-below");
    expect(html).not.toContain("sidebar-scroll");
    expect(classesOf(html, "agents-sidebar")).not.toContain("is-below");
    // the shell's children in order: the workspaces, Agents, the footer
    expect(html.indexOf('class="machine-list"')).toBeLessThan(html.indexOf('class="agents-sidebar'));
    expect(html.indexOf('class="agents-sidebar')).toBeLessThan(html.indexOf("<footer "));
  });

  test("under the workspaces, one scroll holds the workspace list and then Agents, with the footer after it", () => {
    const html = render({ agentsPlacement: "below" }, false);
    expect(classesOf(html, "sidebar-shell")).toContain("is-agents-below");
    expect(classesOf(html, "agents-sidebar")).toContain("is-below");
    const scroll = html.indexOf('<div class="sidebar-scroll">');
    const list = html.indexOf('class="machine-list"');
    const agents = html.indexOf('class="agents-sidebar');
    const footer = html.indexOf("<footer ");
    expect(scroll).toBeGreaterThan(-1);
    expect(scroll).toBeLessThan(list);
    expect(list).toBeLessThan(agents);
    // the scroll closes after Agents and before the footer
    expect(html.slice(agents, footer)).toEndWith("</section></div>");
  });

  test("the phone's drawer starts the Agents list folded, with its count, unless Unfolded is chosen", () => {
    for (const agentsPlacement of ["bottom", "below"]) {
      const folded = render({ agentsPlacement }, true);
      expect(classesOf(folded, "agents-sidebar")).toContain("is-collapsed");
      expect(folded).toMatch(/class="agent-section-toggle[^"]*" aria-expanded="false"/);
      expect(folded).toContain('<span class="agent-section-count">1</span>');
      expect(folded).toMatch(/class="agent-list-contents"[^>]* hidden=""/);

      const open = render({ agentsPlacement, agentsDrawerFold: "open" }, true);
      expect(classesOf(open, "agents-sidebar")).not.toContain("is-collapsed");
      expect(open).not.toContain("agent-section-count");
      expect(open).not.toMatch(/class="agent-list-contents"[^>]* hidden=""/);
      expect(open).toContain('data-pane="w1:p1"');
    }
  });

  test("a desktop starts the Agents list open whichever fold the drawer starts with", () => {
    for (const agentsDrawerFold of ["folded", "open"]) {
      const html = render({ agentsDrawerFold }, false);
      expect(classesOf(html, "agents-sidebar")).not.toContain("is-collapsed");
      expect(html).toContain('data-pane="w1:p1"');
    }
  });
});
