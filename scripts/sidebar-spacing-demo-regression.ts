/**
 * Purpose: verify sidebar spacing when PC groups fold, and which box scrolls for each
 * Settings → Agents list placement, in a real browser.
 * Tags: sidebar, spacing, responsive, browser, regression.
 * Usage: bun scripts/sidebar-spacing-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-spacing-demo-"));
const spacing = 16;

/**
 * Closes every demo workspace that runs an agent, through the demo's own API, so the Agents list
 * says "No agents running" while the shell workspace keeps the PC's own list in place.
 */
const closeAgentWorkspaces = (page: Page) => page.evaluate(async () => {
  for (let closed = 0; closed < 32; closed++) {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: Array<{ pane_id: string; workspace_id: string; agent: string | null }>; agents: Array<{ pane_id: string }> } };
    const agentPanes = new Set(snapshot.agents.map((agent) => agent.pane_id));
    const pane = snapshot.panes.find((candidate) => agentPanes.has(candidate.pane_id) || (candidate.agent ?? "").trim() !== "");
    if (!pane) return closed;
    const response = await fetch("/api/workspace/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: pane.workspace_id, close_group: true }) });
    if (!response.ok) throw new Error(`closing workspace ${pane.workspace_id} answered ${response.status}`);
  }
  throw new Error("the demo still lists an agent workspace after 32 closes");
});

/** Opens `count` shell workspaces through the demo's own API, so the PC's list is longer than the sidebar. */
const addShellWorkspaces = (page: Page, count: number) => page.evaluate(async (count) => {
  for (let made = 0; made < count; made++) {
    const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: `/home/demo/extra-${made + 1}`, label: `extra-${made + 1}` }) });
    if (!response.ok) throw new Error(`opening workspace extra-${made + 1} answered ${response.status}`);
  }
}, count);

let server: ReturnType<typeof Bun.serve> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });

  for (const [mobile, empty] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const label = `${mobile ? "390px" : "desktop"}${empty ? " with no agents" : ""}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        locale: "en-US",
      });
      await context.addInitScript(() => localStorage.removeItem("herdr-web-ui:pc-collapsed:local"));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      // before the drawer opens: the selection leaves with its workspace, and a new one closes the drawer
      if (empty) assert.ok(await closeAgentWorkspaces(page) > 0, `${label} closed the demo's agent workspaces`);
      if (mobile) await page.locator(".drawer-toggle").tap();
      const machineToggle = page.locator(".machine-toggle").first();
      const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
      await machineToggle.waitFor();
      if (empty) await page.locator(".agents-sidebar.is-empty .agent-empty").waitFor({ state: "attached" });
      if (await agentToggle.getAttribute("aria-expanded") !== "true") await agentToggle.click();
      const before = await page.locator(".agents-sidebar .agent-title").allTextContents();
      assert.equal(before.length > 0, !empty, `${label} ${empty ? "has no agent rows" : "has agent rows"} before folding`);
      assert.equal(await machineToggle.getAttribute("aria-expanded"), "true");

      await machineToggle.click();
      await page.waitForFunction(() => !document.querySelector(".machine-workspaces"));
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const shell = box(".sidebar-shell")!;
        const machine = box(".machine-group")!;
        const list = box(".machine-list")!;
        const agents = box(".agents-sidebar")!;
        const contents = document.querySelector<HTMLElement>(".agent-list-contents")!;
        const footer = box(".sidebar-footer")!;
        return {
          shellHeight: shell.height,
          machineBottom: machine.bottom,
          listBottom: list.bottom,
          agentsTop: agents.top,
          agentsHeight: agents.height,
          contentsOverflow: getComputedStyle(contents).overflowY,
          footerBottom: footer.bottom,
          shellBottom: shell.bottom,
        };
      });
      assert.ok(metrics.agentsTop - metrics.machineBottom <= spacing, `${label} folded PC gap is ${metrics.agentsTop - metrics.machineBottom}px`);
      assert.ok(metrics.listBottom - metrics.machineBottom <= spacing, `${label} folded list padding is ${metrics.listBottom - metrics.machineBottom}px`);
      assert.ok(metrics.agentsHeight <= metrics.shellHeight / 2 + 1, `${label} Agents keeps its half-sidebar cap`);
      assert.equal(metrics.contentsOverflow, "auto", `${label} Agents keeps scroll ownership`);
      assert.equal(Math.round(metrics.footerBottom), Math.round(metrics.shellBottom), `${label} footer stays at the bottom`);
      assert.deepEqual(await page.locator(".agents-sidebar .agent-title").allTextContents(), before, `${label} agent order is unchanged`);

      await agentToggle.click();
      assert.equal(await agentToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator(".agent-list-contents").getAttribute("hidden"), "");
      console.log(`PASS ${label} sidebar spacing after folding the PC section`);
      await context.close();
    } finally {
      await browser.close();
    }
  }

  // Settings → Agents list, with more workspaces than the sidebar holds: at the bottom the PCs' list
  // scrolls by itself above the docked Agents; under the workspaces one scroll holds both lists
  for (const [mobile, below] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const label = `${mobile ? "390px" : "desktop"} with Agents ${below ? "under the workspaces" : "at the bottom"}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        locale: "en-US",
      });
      await context.addInitScript((settings) => {
        localStorage.removeItem("herdr-web-ui:pc-collapsed:local");
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify(settings));
      }, below ? { agentsPlacement: "below", agentsDrawerFold: "open" } : { agentsDrawerFold: "open" });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      // before the drawer opens: a new workspace closes it
      await addShellWorkspaces(page, 12);
      if (mobile) await page.locator(".drawer-toggle").tap();
      await page.locator(".agents-sidebar .agent-title").first().waitFor();
      assert.equal(await page.locator(".agents-sidebar .agent-section-toggle").getAttribute("aria-expanded"), "true", `${label} Agents starts unfolded, as Settings asks`);
      assert.equal(await page.locator(".sidebar-shell.is-agents-below").count(), below ? 1 : 0, `${label} shell says where Agents sits`);
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const list = document.querySelector<HTMLElement>(".machine-list")!;
        const scroll = document.querySelector<HTMLElement>(".sidebar-scroll");
        const overflowing = [...document.querySelectorAll<HTMLElement>(".sidebar-shell, .sidebar-shell *")]
          .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
          .map((element) => element.classList[0]);
        const scroller = (scroll ?? list).getBoundingClientRect();
        const past = [...list.querySelectorAll<HTMLElement>(".workspace-group")].findIndex((group) => group.getBoundingClientRect().top >= scroller.bottom);
        return {
          overflowing,
          hasScroll: scroll !== null,
          listOverflow: getComputedStyle(list).overflowY,
          listFade: getComputedStyle(list, "::after").display,
          listBottom: list.getBoundingClientRect().bottom,
          agentsTop: box(".agents-sidebar")!.top,
          footerBottom: box(".sidebar-footer")!.bottom,
          shellBottom: box(".sidebar-shell")!.bottom,
          past,
        };
      });
      assert.equal(Math.round(metrics.footerBottom), Math.round(metrics.shellBottom), `${label} footer stays at the bottom`);
      if (below) {
        assert.deepEqual(metrics.overflowing, ["sidebar-scroll"], `${label} only the shared scroll overflows`);
        assert.equal(metrics.listFade, "none", `${label} the PCs' list draws no fade of its own`);
        assert.ok(Math.abs(metrics.agentsTop - metrics.listBottom) <= 1, `${label} Agents heading follows the last workspace (gap ${metrics.agentsTop - metrics.listBottom}px)`);
      } else {
        assert.equal(metrics.hasScroll, false, `${label} has no shared scroll`);
        assert.equal(metrics.listOverflow, "auto", `${label} the PCs' list keeps its own scroll`);
        assert.ok(metrics.overflowing.includes("machine-list"), `${label} the PCs' list is the scroller (${metrics.overflowing.join(", ")})`);
        assert.ok(!metrics.overflowing.includes("sidebar-scroll"), `${label} nothing else scrolls the workspaces`);
      }
      assert.ok(metrics.past >= 0, `${label} has a workspace past the fold`);

      // a workspace past the fold, brought into view, moves the scroll that holds it and no other
      const target = page.locator(".machine-list .workspace-group").nth(metrics.past).locator(":scope > .workspace-header .workspace-select");
      await target.focus();
      const revealed = await target.evaluate((select, isBelow) => {
        const list = document.querySelector<HTMLElement>(".machine-list")!;
        const scroll = document.querySelector<HTMLElement>(".sidebar-scroll");
        const scroller = isBelow ? scroll! : list;
        const row = select.getBoundingClientRect();
        const panel = scroller.getBoundingClientRect();
        return { scrolled: scroller.scrollTop, other: isBelow ? list.scrollTop : 0, inView: row.top >= panel.top - 1 && row.bottom <= panel.bottom + 1 };
      }, below);
      assert.ok(revealed.scrolled > 0, `${label} ${below ? "the shared scroll" : "the PCs' list"} scrolled to the workspace`);
      assert.equal(revealed.other, 0, `${label} the PCs' list does not scroll inside the shared one`);
      assert.equal(revealed.inView, true, `${label} the workspace is in view`);
      console.log(`PASS ${label}: ${below ? "one scroll holds the workspaces and Agents" : "the PCs' list scrolls by itself above Agents"}`);
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
