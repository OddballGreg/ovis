import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { OpencodeModelCatalog } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { OpencodeModelPicker, type Switch } from "./OpencodeModelPicker.tsx";

const catalog: OpencodeModelCatalog = {
  available: true,
  providers: [
    { id: "go", name: "OpenCode Go", models: [{ id: "kimi-k3", name: "Kimi K3" }, { id: "haiku", name: "Claude Haiku 5.5" }] },
    { id: "duo", name: "GitLab Duo", models: [{ id: "opus-5", name: "Agentic Chat (Claude Opus 5)" }] },
  ],
  current: { provider_id: "duo", model_id: "opus-5" },
};

const render = (initial: { catalog?: OpencodeModelCatalog; open?: boolean; query?: string; state?: Switch }, options: { busy?: boolean; terminal?: boolean } = {}): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OpencodeModelPicker, {
      paneId: "w1:p1", busy: options.busy ?? false, disabled: false, initial,
      ...(options.terminal ? { onOpenTerminal: () => {} } : {}),
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("the OpenCode model chip", () => {
  it("draws nothing until the bridge lists the pane's models", () => {
    expect(render({})).toBe("");
    expect(render({ catalog: { available: false, providers: [], current: null } })).toBe("");
  });

  it("names the model in use, and opens a list grouped by provider with that model marked", () => {
    const closed = render({ catalog });
    expect(closed).toContain('class="oc-model-label">Agentic Chat (Claude Opus 5)<');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("oc-model-menu");
    const open = render({ catalog, open: true });
    expect(open).toContain('role="dialog"');
    expect(open.indexOf(">OpenCode Go<")).toBeLessThan(open.indexOf(">GitLab Duo<"));
    expect(open.match(/aria-current="true"/g)?.length).toBe(1);
    expect(open).toMatch(/aria-current="true"[^>]*title="duo\/opus-5"/u);
    expect(open).toContain('title="go/kimi-k3"');
  });

  it("filters by the search, and says when nothing matches", () => {
    const kimi = render({ catalog, open: true, query: "kimi" });
    expect(kimi).toContain(">Kimi K3<");
    expect(kimi).not.toContain(">Claude Haiku 5.5<");
    expect(kimi).not.toContain(">GitLab Duo<");
    expect(render({ catalog, open: true, query: "nothing like it" })).toContain("No models match");
  });

  it("holds the rows while OpenCode works, and shows a switch in progress", () => {
    const busy = render({ catalog, open: true }, { busy: true });
    expect(busy).toContain("OpenCode is working. Switch the model once it is idle.");
    expect(busy.match(/<button[^>]*class="menu-item oc-model-row"[^>]*disabled=""/g)?.length).toBe(3);
    const switching = render({ catalog, open: true, state: { kind: "switching", name: "Kimi K3" } });
    expect(switching).toContain("Switching to Kimi K3…");
    expect(switching).toContain("oc-model-progress");
  });

  it("offers the terminal when the TUI could not be driven, and says a refusal plainly", () => {
    const failed = render({ catalog, open: true, state: { kind: "failed", code: "model_not_found", detail: "row not found" } }, { terminal: true });
    expect(failed).toContain("Choose it in the terminal with ctrl+x m.");
    expect(failed).toContain('class="oc-model-terminal"');
    const busy = render({ catalog, open: true, state: { kind: "failed", code: "busy", detail: "busy" } }, { terminal: true });
    expect(busy).not.toContain("oc-model-terminal");
    expect(render({ catalog, open: true, state: { kind: "failed", code: null, detail: "network down" } })).toContain("network down");
  });
});
