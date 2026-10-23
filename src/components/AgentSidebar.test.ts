import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, HerdrPane, SessionSnapshot, TabInfo } from "../../shared/protocol.ts";
import { setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider, type Settings } from "../lib/settings.ts";
import { SidebarActivityProvider } from "../lib/sidebarActivity.tsx";
import { shownStatus, stateSeqs } from "../lib/sidebarOrder.ts";
import { SETTINGS_STORAGE_KEY } from "../lib/themeBoot.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const pane = (pane_id: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `term-${pane_id}`, focused: false, revision: 1,
  agent: "claude", agent_status: "idle", ...extra,
});
/** herdr's state_change_seq for a pane, kept on its agent entry; the pane itself does not carry it */
const seqOf = new Map<string, number>();
const agentOf = (row: HerdrPane): AgentInfo => ({
  pane_id: row.pane_id, workspace_id: row.workspace_id, tab_id: row.tab_id, terminal_id: row.terminal_id, focused: false, revision: 1,
  agent: row.agent, agent_status: row.agent_status, ...(row.display_agent ? { display_agent: row.display_agent } : {}), ...(row.tokens ? { tokens: row.tokens } : {}),
  ...(seqOf.has(row.pane_id) ? { state_change_seq: seqOf.get(row.pane_id)! } : {}),
});
const tab = (number: number, label = String(number)): TabInfo => ({ tab_id: `w1:t${number}`, workspace_id: "w1", label, number, focused: false, pane_count: 1, agent_status: "idle" });
const snapshot = (panes: HerdrPane[], tabs: TabInfo[] = [tab(1)]): SessionSnapshot => ({
  protocol: 22, version: "0.9.5", layouts: [], panes, agents: panes.map(agentOf),
  workspaces: [{ workspace_id: "w1", label: "checkout-api", number: 1, focused: false, pane_count: panes.length, tab_count: tabs.length, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs,
});
const machine = (panes: HerdrPane[], state: Machine["state"] = "connected", tabs?: TabInfo[]): Machine => ({ id: "local", name: "workstation", kind: "local", enabled: true, state, error: null, snapshot: snapshot(panes, tabs) });

/** the settings record this device keeps, as SettingsProvider reads it at its first render */
let stored: Partial<Settings> | null = null;
function render(machines: Machine[], withSeqs = false): string {
  const sidebar = createElement(AgentSidebar, { machines, selectedMachineId: "local", selectedPaneId: null, stateWord: () => "disconnected", onSelect: () => {} });
  // the counters and drawn statuses lib/sidebarActivity.tsx gives the rows, with no finish opened yet
  const activity = { seqs: (id: string) => stateSeqs(machines.find((candidate) => candidate.id === id)?.snapshot), status: (_id: string, row: HerdrPane) => shownStatus(row, null) };
  return renderToStaticMarkup(createElement(SettingsProvider, {
    children: withSeqs ? createElement(SidebarActivityProvider, { value: activity }, sidebar) : sidebar,
  }));
}
const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** the text of each element with this class, entities as the browser reads them */
const texts = (html: string, className: string): string[] =>
  [...html.matchAll(new RegExp(`<span class="${className}">(.*?)</span>`, "g"))].map((match) => decode(match[1]!));
/** each agent row's tooltip, line by line */
const tooltips = (html: string): string[][] =>
  [...html.matchAll(/class="agent-select agent-row"[^>]* title="([^"]*)"/g)].map((match) => decode(match[1]!).split("\n"));

describe("AgentSidebar rows", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    // the drawer query AgentSidebar asks at its first render, on a desktop, in English
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: false }),
      localStorage: { getItem: (key: string) => (key === SETTINGS_STORAGE_KEY && stored !== null ? JSON.stringify(stored) : null) },
    } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    stored = null;
    seqOf.clear();
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
    setAgentRowTokens(null);
  });

  test("a row draws every token its pane has, by name, as text; a pane without any draws no line", () => {
    const html = render([machine([
      pane("w1:p1", { tokens: { summary: "<b>reviewing</b> auth", quota: "5h 95% · Wk 67%", blank: "  " } }),
      pane("w1:p2"),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["5h 95% · Wk 67% · <b>reviewing</b> auth"]);
    // escaped, never markup
    expect(html).not.toContain("<b>reviewing</b>");
    expect(html.match(/class="agent-tokens"/g)?.length).toBe(1);
  });

  test("herdr's `[ui.sidebar.agents]` rows choose which tokens a row draws, in their order, hide rules included", () => {
    setAgentRowTokens({
      rows: [{ name: "progress" }, { name: "quota", rules: [{ equals: "unknown", hide: true }] }],
      by_agent: { codex: [{ name: "summary" }] },
    });
    const html = render([machine([
      pane("w1:p1", { tokens: { quota: "5h 95%", progress: "40% 12m", summary: "not in the rows" } }),
      pane("w1:p2", { tokens: { quota: "unknown", progress: "90% 1m" } }),
      pane("w1:p3", { agent: "codex", tokens: { quota: "5h 95%", summary: "codex's own rows" } }),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["40% 12m · 5h 95%", "90% 1m", "codex's own rows"]);
  });

  test("the row's tooltip says each token whole; a PC that is away draws none", () => {
    const long = `summary ${"x".repeat(200)}`;
    const online = render([machine([pane("w1:p1", { tokens: { summary: long, quota: "5h 95%" } })])]);
    expect(tooltips(online)[0]).toEqual(["w1:p1", "checkout-api", "5h 95%", long, "claude"]);
    const away = render([machine([pane("w1:p1", { tokens: { summary: long } })], "disconnected")]);
    expect(away).not.toContain("agent-tokens");
    expect(away).not.toContain(long);
  });

  test("display_agent, a plugin's line for the agent, is said where it says more than the agent's kind", () => {
    const html = render([machine([
      pane("w1:p1", { display_agent: "needs a login · 8m ago", title: "PRJ-1 Add a greeting" }),
      pane("w1:p2", { display_agent: "Claude", title: "Refactor" }),
    ])]);
    const lines = [...html.matchAll(/<span class="agent-context">(.*?)<\/span>/g)].map((match) => match[1]);
    expect(lines[0]).toStartWith("needs a login · 8m ago · checkout-api");
    // the mark already draws Claude: the line does not say it again
    expect(lines[1]).toBe("checkout-api");
  });

  test("Agent row title → Tab name names a row by its renamed tab, with the agent's title opening the second line", () => {
    const panes = [
      pane("w1:p1", { title: "Fix the login form" }),
      pane("w1:p2", { tab_id: "w1:t2", title: "Refactor the cart" }),
    ];
    // tab 1 is renamed; tab 2 is still named by its place
    const tabs = [tab(1, "Review"), tab(2)];
    const titles = (html: string) => texts(html, "agent-title");
    const contexts = (html: string) => [...html.matchAll(/<span class="agent-context">(.*?)<\/span>/g)].map((match) => decode(match[1]!));

    // the default, Agent: the agent's title, and the renamed tab said on the second line
    const agent = render([machine(panes, "connected", tabs)]);
    expect(titles(agent)).toEqual(["Fix the login form", "Refactor the cart"]);
    expect(contexts(agent)[0]).toContain("Review");

    stored = { agentRowTitle: "tab" };
    const named = render([machine(panes, "connected", tabs)]);
    expect(titles(named)).toEqual(["Review", "Refactor the cart"]);
    const line = contexts(named)[0]!;
    expect(line).toStartWith("Fix the login form · ");
    // the tab's name is the title: the second line does not say it again
    expect(line).not.toContain("Review");
    // a tab herdr still names by its place keeps the agent's title
    expect(contexts(named)[1]).not.toStartWith("Refactor the cart");
  });

  test("Agents order → Longest wait lists blocked, then done, ready and working rows, the oldest state change first", () => {
    const panes = [
      pane("w1:p1", { agent_status: "working", title: "working 1" }),
      pane("w1:p2", { agent_status: "idle", title: "idle 5" }),
      pane("w1:p3", { agent_status: "done", title: "done 7" }),
      pane("w1:p4", { agent_status: "blocked", title: "blocked 9" }),
      pane("w1:p5", { agent_status: "idle", title: "idle 2" }),
      pane("w1:p6", { agent_status: "blocked", title: "blocked 3" }),
    ];
    for (const [id, seq] of [["w1:p1", 1], ["w1:p2", 5], ["w1:p3", 7], ["w1:p4", 9], ["w1:p5", 2], ["w1:p6", 3]] as const) seqOf.set(id, seq);

    // the default, Workspaces: herdr's order
    expect(texts(render([machine(panes)], true), "agent-title")).toEqual(["working 1", "idle 5", "done 7", "blocked 9", "idle 2", "blocked 3"]);

    stored = { agentOrder: "waiting" };
    expect(texts(render([machine(panes)], true), "agent-title")).toEqual(["blocked 3", "blocked 9", "done 7", "idle 2", "idle 5", "working 1"]);
  });
});
