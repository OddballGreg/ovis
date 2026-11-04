import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, type Mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cycleAgent, forgetOpencodeAgents, handleOpencodeAgentRequest, opencodeAgentOptions, primaryAgentCount } from "./opencode-agent.ts";
import { promptBox, type DriveDeps } from "./opencode-model.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", `opencode-agent-1.x-${name}.ansi`), "utf8");

// a failed switch logs one line (as a model switch does): kept out of the test output
let warn: Mock<typeof console.warn>;
beforeAll(() => { warn = spyOn(console, "warn").mockImplementation(() => undefined); });
afterAll(() => warn.mockRestore());

afterEach(() => {
  delete opencodeAgentOptions.count;
  forgetOpencodeAgents();
});

describe("the agent the prompt's footer names", () => {
  it("reads Build and Plan from the recorded footers, and the model after them", () => {
    expect(promptBox(fixture("build-home"))).toMatchObject({ agent: "Build", footer: "Agentic Chat (Claude Opus 5.5) GitLab Duo", popup: false });
    expect(promptBox(fixture("plan-home"))).toMatchObject({ agent: "Plan", footer: "Agentic Chat (Claude Opus 5.5) GitLab Duo", popup: false });
  });

  it("sees the autocomplete open over the prompt, on its border", () => {
    expect(promptBox(fixture("plan-slash"))).toMatchObject({ agent: "Plan", popup: true });
  });

  it("reads an agent of two words, and none from a footer that names no model", () => {
    expect(promptBox(fixture("plan-home").replace("Plan", "Plan auto"))?.agent).toBe("Plan auto");
    const shell = fixture("plan-home").split("\n").map((row) => row.includes("Agentic Chat") ? `${BASE}  ┃  Shell` : row).join("\n");
    expect(promptBox(shell)?.agent ?? null).toBeNull();
  });
});

describe("OpenCode's agent list", () => {
  it("counts the primary agents, not subagents or hidden ones", () => {
    expect(primaryAgentCount([
      { name: "build", mode: "primary" }, { name: "plan", mode: "primary" }, { name: "general", mode: "subagent" },
      { name: "title", mode: "primary", hidden: true }, { name: "mine", mode: "all" }, "junk",
    ])).toBe(3);
    expect(primaryAgentCount({ agents: [] })).toBeNull();
    expect(primaryAgentCount([])).toBeNull();
  });
});

/* A TUI that answers Tab by moving to its next primary agent, as OpenCode 1.x's agent_cycle does. */

const BASE = "\u001b[0m\u001b[38;2;200;200;200m\u001b[48;2;0;0;0m";

class FakeTui {
  index = 0;
  sent: string[] = [];
  dialog = false;
  popup = false;
  /** Tab moves nothing (a keybind changed), as a TUI that does not cycle */
  stuck = false;
  /** the first Tab opens the autocomplete instead of moving */
  popupOnTab = false;
  draft = "half a message";
  time = 0;
  constructor(public agents: string[]) {}

  get agent(): string { return this.agents[this.index]!; }

  screen(): string {
    const lines = [`${BASE}${" ".repeat(70)}`];
    if (this.dialog) lines.push(`${BASE}${" ".repeat(10)}\u001b[48;2;30;30;30m    Select agent${" ".repeat(30)}esc    ${BASE}${" ".repeat(10)}`);
    if (this.popup) lines.push(`${BASE}  ┃ /agents   Switch agent            ┃`, `${BASE}  ┃ /help     Help                    ┃`);
    lines.push(`${BASE}  ┃`, `${BASE}  ┃  ${this.draft}`, `${BASE}  ┃`, `${BASE}  ┃  ${this.agent} · Claude Haiku 5.5 OpenCode Go`, `${BASE}  ╹${"▀".repeat(60)}`);
    return lines.join("\r\n");
  }

  deps(): DriveDeps {
    return {
      read: async () => this.screen(),
      keys: async (keys) => {
        for (const key of keys) {
          this.sent.push(key);
          if (key !== "tab" || this.stuck) continue;
          if (this.popupOnTab) { this.popup = true; this.popupOnTab = false; continue; }
          this.index = (this.index + 1) % this.agents.length;
        }
      },
      type: async () => undefined,
      sleep: async (ms) => { this.time += ms; },
      now: () => this.time,
    };
  }
}

describe("switching the agent with Tab", () => {
  it("presses Tab until the footer names the agent asked for, keeping the draft", async () => {
    const tui = new FakeTui(["Build", "Plan", "Review"]);
    expect(await cycleAgent(tui.deps(), "review", 3)).toEqual({ ok: true, agent: "Review" });
    expect(tui.sent).toEqual(["tab", "tab"]);
    expect(tui.draft).toBe("half a message");
  });

  it("sends nothing for the agent already shown, and one Tab with none asked for", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    expect(await cycleAgent(tui.deps(), "Build", 2)).toEqual({ ok: true, agent: "Build" });
    expect(tui.sent).toEqual([]);
    expect(await cycleAgent(tui.deps(), undefined, 1)).toEqual({ ok: true, agent: "Plan" });
    expect(tui.sent).toEqual(["tab"]);
  });

  it("stops at the cap and says the agent the footer shows", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    const result = await cycleAgent(tui.deps(), "deploy", 2);
    expect(result).toMatchObject({ ok: false, code: "agent_not_found", agent: "Build" });
    expect(tui.sent).toEqual(["tab", "tab"]);
  });

  it("says a Tab the footer did not answer, and sends no second", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    tui.stuck = true;
    expect(await cycleAgent(tui.deps(), "plan", 2)).toMatchObject({ ok: false, code: "not_confirmed", agent: "Build" });
    expect(tui.sent).toEqual(["tab"]);
  });

  it("refuses before any key with a dialog or the autocomplete open, or no prompt", async () => {
    const covered = new FakeTui(["Build", "Plan"]);
    covered.dialog = true;
    expect(await cycleAgent(covered.deps(), "plan", 2)).toMatchObject({ ok: false, code: "dialog_open" });
    const popup = new FakeTui(["Build", "Plan"]);
    popup.popup = true;
    expect(await cycleAgent(popup.deps(), "plan", 2)).toMatchObject({ ok: false, code: "popup_open" });
    const none: DriveDeps = { ...new FakeTui(["Build"]).deps(), read: async () => `${BASE}Sessions` };
    expect(await cycleAgent(none, "plan", 2)).toMatchObject({ ok: false, code: "not_ready" });
    expect([...covered.sent, ...popup.sent]).toEqual([]);
    const aborted = new FakeTui(["Build", "Plan"]);
    const controller = new AbortController();
    controller.abort();
    expect(await cycleAgent(aborted.deps(), "plan", 2, undefined, controller.signal)).toMatchObject({ ok: false, code: "aborted" });
    expect(aborted.sent).toEqual([]);
  });

  it("presses no more once the autocomplete opens after a Tab", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    tui.popupOnTab = true;
    expect(await cycleAgent(tui.deps(), "plan", 2)).toMatchObject({ ok: false, code: "popup_open", agent: "Build" });
    expect(tui.sent).toEqual(["tab"]);
  });

  it("says a pane that cannot be written", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    const deps = { ...tui.deps(), keys: async () => { throw new Error("pane gone"); } };
    expect(await cycleAgent(deps, "plan", 2)).toMatchObject({ ok: false, code: "pane_error", agent: "Build" });
  });
});

/* The route, over a herdr socket that answers pane.get for one pane; the TUI is the fake one. */

async function withHerdr(pane: { agent: string | null; agent_status: string }, run: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opencode-agent-"));
  const path = join(root, "herdr.sock");
  const sockets = new Set<Socket>();
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input.split("\n")[0]!) as { id: string; method: string };
      const result = req.method === "pane.get" ? { pane: { pane_id: "w1:p1", cwd: root, ...pane } } : { type: "ok" };
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

const post = async (body: unknown, options: Parameters<typeof handleOpencodeAgentRequest>[2] = {}, signal?: AbortSignal): Promise<Response> => {
  const request = new Request("http://localhost/api/pane/opencode-agent", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...(signal ? { signal } : {}) });
  return (await handleOpencodeAgentRequest(request, "/api/pane/opencode-agent", options))!;
};
const code = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

describe("POST /api/pane/opencode-agent", () => {
  it("switches the agent under the pane's turn, capped at OpenCode's primary agents", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    const turns: string[] = [];
    opencodeAgentOptions.count = async () => 2;
    await withHerdr({ agent: "opencode", agent_status: "idle" }, async () => {
      const response = await post({ pane_id: "w1:p1", agent: "plan" }, { deps: () => tui.deps(), serialize: async (pane, task) => { turns.push(pane); return task(); } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, agent: "Plan" });
      expect(turns).toEqual(["w1:p1"]);
      // a target Tab never reaches: two presses, the agent list's length, then said with the agent shown
      const missing = await post({ pane_id: "w1:p1", agent: "deploy" }, { deps: () => tui.deps() });
      expect(missing.status).toBe(502);
      expect(await missing.json()).toMatchObject({ error: { code: "agent_not_found", agent: "Plan" } });
      expect(tui.sent).toEqual(["tab", "tab", "tab"]);
    });
  });

  it("caps at four presses when OpenCode's agent list cannot be read", async () => {
    const tui = new FakeTui(["A", "B", "C", "D", "E", "F"]);
    opencodeAgentOptions.count = async () => null;
    await withHerdr({ agent: "opencode", agent_status: "idle" }, async () => {
      expect(await code(await post({ pane_id: "w1:p1", agent: "f" }, { deps: () => tui.deps() }))).toEqual([502, "agent_not_found"]);
      expect(tui.sent).toEqual(["tab", "tab", "tab", "tab"]);
    });
  });

  it("refuses a watching device, a busy or blocked pane, another agent and a bad name before any key", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    const deps = () => tui.deps();
    expect(await code(await post({ pane_id: "w1:p1", agent: "plan" }, { deps, readOnly: true }))).toEqual([403, "read_only"]);
    for (const status of ["working", "blocked"]) {
      await withHerdr({ agent: "opencode", agent_status: status }, async () => {
        expect(await code(await post({ pane_id: "w1:p1", agent: "plan" }, { deps }))).toEqual([409, "busy"]);
      });
    }
    await withHerdr({ agent: "claude", agent_status: "idle" }, async () => {
      expect(await code(await post({ pane_id: "w1:p1", agent: "plan" }, { deps }))).toEqual([409, "not_opencode"]);
    });
    expect(await code(await post({ pane_id: "w1:p1", agent: "pl\u001b[2Jan" }, { deps }))).toEqual([400, "invalid_agent"]);
    expect(await code(await post({ agent: "plan" }, { deps }))).toEqual([400, "missing_pane_id"]);
    tui.popup = true;
    await withHerdr({ agent: "opencode", agent_status: "idle" }, async () => {
      expect(await code(await post({ pane_id: "w1:p1", agent: "plan" }, { deps }))).toEqual([409, "popup_open"]);
    });
    expect(tui.sent).toEqual([]);
  });

  it("sends nothing for a request given up while it waited its turn", async () => {
    const tui = new FakeTui(["Build", "Plan"]);
    const controller = new AbortController();
    await withHerdr({ agent: "opencode", agent_status: "idle" }, async () => {
      const response = await post({ pane_id: "w1:p1", agent: "plan" }, { deps: () => tui.deps(), serialize: async (_pane, task) => { controller.abort(); return task(); } }, controller.signal);
      expect(await code(response)).toEqual([409, "aborted"]);
      expect(tui.sent).toEqual([]);
    });
  });

  it("answers only its own path, and only POST", async () => {
    expect(await handleOpencodeAgentRequest(new Request("http://localhost/api/pane/other"), "/api/pane/other")).toBeNull();
    expect((await handleOpencodeAgentRequest(new Request("http://localhost/api/pane/opencode-agent"), "/api/pane/opencode-agent"))!.status).toBe(400);
  });
});
