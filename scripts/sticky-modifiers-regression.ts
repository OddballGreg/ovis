/** Touch controls → browser WS → Herdr's pane encoder → real raw-mode PTY. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneRead } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-sticky-qa-"));
const owned: string[] = [];
const server = createServer({ port: 0, stateDir: join(root, "state"), token: "" });
// launched inside the try: a missing Chrome must still stop the server and remove the temp directory
let launched: Browser | undefined;
const errors: string[] = [];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(20);
  }
}
/** The phone's input line: a held key-bar modifier or a hardware Ctrl+letter sends a chord, never line text. */
async function checkInputLine(browser: Browser, mode: "legacy" | "kitty", pane: string, read: () => string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ pane }) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal");
  }, { pane });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const frames: any[] = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const remote = socket.connectToServer();
    remote.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => { frames.push(JSON.parse(String(raw))); remote.send(raw); });
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const ctrl = page.locator('[data-key="Control"]');
  await until(async () => !(await ctrl.isDisabled()), "input line ready");
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.tap();
  const sentSince = (start: number) => frames.slice(start).filter((frame) => frame.type === "keys" || frame.type === "input" || frame.type === "submit");
  const ctrlP = mode === "kitty" ? "\x1b[112;5u" : "\x10";
  const expectChord = async (label: string, act: () => Promise<void>, { key = "ctrl+p", bytes = ctrlP, text = "ab" } = {}) => {
    const before = read();
    const start = frames.length;
    await act();
    await until(() => sentSince(start).length > 0, `${label}: chord frame`);
    assert.deepEqual(sentSince(start).map((frame) => frame.keys ?? frame.text), [[key]], label);
    await until(() => read().length > before.length, `${label}: chord received by PTY`);
    assert.equal(Buffer.from(read().slice(before.length), "hex").toString(), bytes, label);
    // after a deferred WebKit input too
    await until(async () => (await line.inputValue()) === text, `${label}: the line keeps its text`);
    assert.equal(sentSince(start).length, 1, `${label}: one chord only`);
    console.log(`${mode} input line ${label}: ${Buffer.from(bytes).toString("hex")}`);
  };
  // the line as Gboard writes it: the composition replaces [from, caret) of the line with `composed`,
  // the field's value set past React's tracker, as a keyboard's own edit is
  // "webkit" commits as WebKit does, writing the committed word again with an input event in the same task
  const compose = (phase: "open" | "commit" | "webkit", from: number, caret: number, composed: string) => line.evaluate((element, { phase, from, caret, composed }) => {
    const box = element as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const base = (window as any).__base as string | undefined;
    if (phase === "open") {
      (window as any).__base = box.value;
      box.setSelectionRange(caret, caret);
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: composed }));
      setValue.call(box, box.value.slice(0, from) + composed + box.value.slice(caret));
      box.setSelectionRange(from + composed.length, from + composed.length);
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: composed, isComposing: true }));
    } else {
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: composed }));
      if (phase === "commit") return;
      setValue.call(box, base!.slice(0, from) + composed + base!.slice(caret));
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: composed }));
    }
  }, { phase, from, caret, composed });
  // a blur and a focus in the line is the forced commit of a composed letter
  await line.evaluate((element) => {
    (window as any).__blurs = 0;
    element.addEventListener("blur", () => { (window as any).__blurs++; });
    element.addEventListener("input", (event) => { (window as any).__lastInput = (event as InputEvent).inputType; });
  });
  const blurs = () => page.evaluate(() => (window as any).__blurs as number);
  await page.keyboard.insertText("ab");
  assert.equal(await line.inputValue(), "ab");
  await ctrl.tap();
  assert.equal(await ctrl.getAttribute("aria-pressed"), "true");
  assert.equal(await line.evaluate((element) => document.activeElement === element), true, "Ctrl keeps the line's focus");
  await expectChord("key-bar Ctrl + insertText p", () => page.keyboard.insertText("p"));
  await expectChord("key-bar Ctrl + keydown p", () => line.press("p"));
  // Gboard's usual case: the caret right after a word, which it composes again with the letter ("abp")
  await expectChord("key-bar Ctrl + Gboard composing abp", async () => {
    await compose("open", 0, 2, "abp");
    // held Ctrl commits the open word with a focus change, once the keyboard's input is done
    await until(async () => (await blurs()) === 1, "a held modifier forces the composed letter's commit");
    assert.equal(await line.evaluate((element) => document.activeElement === element), true, "the forced commit keeps the line's focus");
    await compose("webkit", 0, 2, "abp");
    // the field's own delete took the letter out, so the browser's undo history has it
    await until(async () => (await page.evaluate(() => (window as any).__lastInput)) === "deleteContentBackward", "the letter leaves with the field's own delete");
  });
  // a letter composed alone, as Gboard does at the line's start or after a space
  await expectChord("key-bar Ctrl + Gboard composing p at the start", async () => {
    await compose("open", 0, 0, "p");
    await compose("commit", 0, 0, "p");
  });
  await expectChord("key-bar Ctrl + Gboard composing /", async () => {
    await compose("open", 0, 2, "ab/");
    await compose("commit", 0, 2, "ab/");
  }, { key: "ctrl+/", bytes: mode === "kitty" ? "\x1b[47;5u" : "\x1f" });
  // two letters, a syllable, a revised word: an IME's text, Ctrl held or not, and nothing forced
  const blursBefore = await blurs();
  const textStart = frames.length;
  for (const [composed, expected] of [["abpq", "abpq"], ["ab한", "ab한"], ["Abp", "Abp"]] as const) {
    await compose("open", 0, 2, composed);
    await compose("commit", 0, 2, composed);
    await until(async () => (await line.inputValue()) === expected, `IME text ${composed} stays in the line`);
    // fixed wait: proving the deferred check after the commit takes nothing out
    await Bun.sleep(50);
    assert.equal(await line.inputValue(), expected, `IME text ${composed} stays in the line`);
    await line.fill("ab");
  }
  assert.equal(sentSince(textStart).length, 0, "an IME's text sends nothing");
  assert.equal(await blurs(), blursBefore, "an IME's text is never forced to commit");
  // Ctrl stays held, as everywhere on the key bar
  assert.equal(await ctrl.getAttribute("aria-pressed"), "true");
  // key-bar Ctrl armed these: the line's own letters go to the pane too
  await expectChord("key-bar Ctrl + keydown h", () => line.press("h"), { key: "ctrl+h", bytes: mode === "kitty" ? "\x1b[104;5u" : "\x08" });
  await ctrl.tap();
  assert.equal(await ctrl.getAttribute("aria-pressed"), "false");
  // with no modifier held a composed letter is plain typing, and the field is left alone
  const plainStart = frames.length;
  await compose("open", 0, 2, "abp");
  // fixed wait: proving no forced commit follows the keyboard's input
  await Bun.sleep(50);
  await compose("commit", 0, 2, "abp");
  await until(async () => (await line.inputValue()) === "abp", "a composed letter with nothing held stays in the line");
  assert.equal(await blurs(), blursBefore, "plain typing is never forced to commit");
  assert.equal(sentSince(plainStart).length, 0, "plain composed typing sends nothing");
  await line.fill("ab");
  // a hardware Ctrl+P is the pane's, not the print dialog; select all stays the field's
  await expectChord("hardware Ctrl+p", () => line.press("Control+p"));
  const selectStart = frames.length;
  // the line's Backspace, Tab, newline and Enter letters, and Ctrl+D and Ctrl+S on a line with text, stay the field's
  for (const letter of ["h", "i", "j", "m", "d", "s"]) {
    await line.press(`Control+${letter}`);
    await line.fill("ab");
  }
  await line.press("Control+a");
  assert.deepEqual(await line.evaluate((element) => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd]), [0, 2], "Ctrl+A selects the line");
  assert.equal(sentSince(selectStart).length, 0, "Ctrl+A and the field's own Ctrl letters send nothing");
  await line.press("End");
  // plain typing is the line's again
  await page.keyboard.insertText("c");
  await line.press("d");
  assert.equal(await line.inputValue(), "abcd");
  assert.equal(sentSince(selectStart).length, 0, "plain typing stays in the line");
  await line.fill("");
  // an empty line hands Ctrl+D to the pane: the end of input a shell or a REPL waits for
  await expectChord("hardware Ctrl+d on an empty line", () => line.press("Control+d"), { key: "ctrl+d", bytes: mode === "kitty" ? "\x1b[100;5u" : "\x04", text: "" });
  await context.close();
}

try {
  const browser = launched = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const mode of ["legacy", "kitty"] as const) {
    const made = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-sticky-${mode}`, focus: false });
    owned.push(made.workspace.workspace_id);
    const pane = made.root_pane.pane_id;
    const log = join(root, `${mode}.hex`);
    const probe = resolve("scripts/fixtures/modifier-probe.py");
    await paneSendText(pane, `python3 -u '${probe}' '${log}' ${mode}`);
    await paneSendKeys(pane, ["Enter"]);
    await until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes(`PROBE READY ${mode}`), "raw probe ready");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ pane }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "direct", keyBarExtras: ["alt", "shift-tab", "home-end", "page-up-down", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"] }));
      localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal");
    }, { pane });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const frames: any[] = [];
    let ws: import("playwright-core").WebSocketRoute | undefined;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      ws = socket;
      const remote = socket.connectToServer();
      remote.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "error") console.log("terminal error", message);
        socket.send(raw);
      });
      socket.onMessage((raw) => { frames.push(JSON.parse(String(raw))); remote.send(raw); });
    });
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    const settingsShortcut = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent))
      ? "Meta+Shift+Comma" : "Control+Shift+Comma";
    const ctrl = page.locator('[data-key="Control"]');
    await until(async () => !(await ctrl.isDisabled()), "terminal input ready");
    // Herdr's screen stream enables bracketed paste; exercise xterm with it disabled too.
    ws!.send(JSON.stringify({ type: "pty-data", pane_id: pane, data: "\x1b[?2004l" }));
    const input = page.locator(".xterm-helper-textarea");
    await input.focus();
    let previousMask = 0;
    const held = async (mask: number) => {
      for (const [bit, key] of [[4, "Control"], [2, "Alt"], [1, "Shift"]] as const) {
        if ((mask & bit) !== (previousMask & bit)) await page.locator(`[data-key="${key}"]`).tap();
        assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), String(!!(mask & bit)));
      }
      previousMask = mask;
      assert.equal(await input.evaluate((element) => document.activeElement === element), true, "touch toggle keeps typing focus");
    };
    const read = () => existsSync(log) ? readFileSync(log, "utf8") : "";
    for (let mask = 1; mask < 8; mask++) {
      await held(mask);
      const prefix = [mask & 4 ? "ctrl" : "", mask & 2 ? "alt" : "", mask & 1 ? "shift" : ""].filter(Boolean).join("+");
      for (const [key, name] of [["ArrowLeft", "left"], ["ArrowUp", "up"], ["ArrowRight", "right"], ["ArrowDown", "down"], ["a", "a"], ["b", "b"], ["!", "!"], ["+", "plus"], [" ", "space"], ["я", "я"], ["😀", "😀"], ["Enter", "enter"], ["Tab", "tab"], ["Backspace", "backspace"]]) {
        const before = read();
        const frameCount = frames.length;
        if (key!.startsWith("Arrow") || key === "Tab" || key === "Enter") await page.locator(`[data-key="${key}"]`).tap();
        else if (key === "Backspace") await input.press("Backspace");
        else await page.keyboard.insertText(key!); // soft-keyboard input without keydown
        await until(() => frames.length > frameCount, "modified key frame");
        assert.equal(frames.at(-1).type, "keys");
        assert.deepEqual(frames.at(-1).keys, [`${prefix}+${name}`]);
        await until(() => read().length > before.length, "modified key received by PTY");
        const received = Buffer.from(read().slice(before.length), "hex").toString();
        const parameter = 1 + mask;
        if (key!.startsWith("Arrow")) {
          const final = ({ ArrowLeft: "D", ArrowUp: "A", ArrowRight: "C", ArrowDown: "B" } as Record<string, string>)[key!];
          assert.equal(received, `\x1b[1;${parameter}${final}`, `${mode} ${prefix}+${name}`);
        } else if (mode === "kitty") {
          const code = ({ Enter: 13, Tab: 9, Backspace: 127 } as Record<string, number>)[key!] ?? key!.codePointAt(0);
          assert.equal(received, `\x1b[${code};${parameter}u`, `${mode} ${prefix}+${name}`);
        }
        console.log(`${mode} ${prefix}+${name}: ${Buffer.from(received).toString("hex")}`);
      }
      // Every modifier stays held across all keys, including Control.
      assert.equal(await ctrl.getAttribute("aria-pressed"), String(!!(mask & 4)));
    }
    await held(7);
    for (const [key, name] of [["Home", "home"], ["End", "end"], ["PageUp", "pageup"], ["PageDown", "pagedown"], ["BackTab", "tab"], ["pipe", "|"], ["tilde", "~"], ["slash", "/"]]) {
      const before = read();
      const frameCount = frames.length;
      await page.locator(`[data-key="${key}"]`).tap();
      await until(() => frames.length > frameCount, "optional modified key frame");
      if (["Home", "End", "PageUp", "PageDown"].includes(key!)) {
        assert.equal(frames.at(-1).type, "input");
        assert.equal(frames.at(-1).text, ({ Home: "\x1b[1;8H", End: "\x1b[1;8F", PageUp: "\x1b[5;8~", PageDown: "\x1b[6;8~" } as Record<string, string>)[key!]);
      } else assert.deepEqual(frames.at(-1).keys, [`ctrl+alt+shift+${name}`]);
      await until(() => read().length > before.length, `optional modified ${key} received by PTY`);
    }
    if (evidence) await page.screenshot({ path: join(evidence, `sticky-${mode}-phone.png`) });
    // Dropped text is also paste, even one character with every modifier held.
    const dropBefore = read();
    const dropFrames = frames.length;
    await page.locator(".xterm").evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", "z");
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await until(() => frames.length > dropFrames && read().length > dropBefore.length, "single-character drop received");
    assert.equal(frames[dropFrames].type, "input", "drop bypasses held modifiers");
    assert.equal(frames[dropFrames].text, "z");
    assert.equal(Buffer.from(read().slice(dropBefore.length).trim().split(/\s+/).join(""), "hex").toString(), "z");
    // Paste is text, including a single character; it must not become a shortcut.
    const pasteBefore = read();
    const pasteFrames = frames.length;
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "x");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await until(() => read().length > pasteBefore.length, "paste received");
    assert.equal(frames.slice(pasteFrames).some((frame) => frame.type === "keys"), false);
    assert.equal(Buffer.from(read().slice(pasteBefore.length), "hex").toString(), "x");
    // Deferred IME commits are text, including one character with every modifier held.
    for (const text of ["한", "한글"]) {
      const imeBefore = read();
      const imeFrames = frames.length;
      await input.evaluate((element, text) => {
        const box = element as HTMLTextAreaElement;
        box.value = "";
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        box.value = text;
        box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
      }, text);
      // a commit can reach the program in more than one read: wait for all of its bytes, two hex digits each
      await until(() => read().length - imeBefore.length >= Buffer.byteLength(text) * 2, "IME commit received");
      assert.equal(frames.slice(imeFrames).some((frame) => frame.type === "keys"), false, "IME commit bypasses held modifiers");
      assert.equal(Buffer.from(read().slice(imeBefore.length), "hex").toString(), text);
    }
    // A second composition starts before the first deferred commit runs.
    const burstBefore = read();
    const burstFrames = frames.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      for (const text of ["한", "글"]) {
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        box.value += text;
        box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
      }
    });
    await until(() => Buffer.from(read().slice(burstBefore.length), "hex").toString() === "한글", "IME burst received");
    assert.equal(frames.slice(burstFrames).some((frame) => frame.type === "keys"), false, "consecutive IME commits bypass held modifiers");
    assert.equal(Buffer.from(read().slice(burstBefore.length), "hex").toString(), "한글");
    // ...but one ASCII letter is how Gboard types a Latin key, a composition a letter long: under held
    // modifiers the committed letter is the chord (key-bar Ctrl and a typed p is Ctrl+P)
    const letterBefore = read();
    const letterFrames = frames.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "p";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "p" }));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "p" }));
    });
    await until(() => frames.length > letterFrames, "IME letter chord frame");
    assert.deepEqual(frames.slice(letterFrames).filter((frame) => frame.type === "keys" || frame.type === "input").map((frame) => frame.keys ?? frame.text), [["ctrl+alt+shift+p"]], "a committed letter under held modifiers is a chord");
    await until(() => read().length > letterBefore.length, "IME letter chord received by PTY");
    // legacy has no byte for Ctrl+Alt+Shift+letter either, so Herdr sends the CSI u form in both modes, as for a and b above
    assert.equal(Buffer.from(read().slice(letterBefore.length), "hex").toString(), "\x1b[112;8u", `${mode} committed letter chord bytes`);
    // Hardware modifiers combine with held touch modifiers as well.
    await held(2);
    await input.evaluate((element) => { (element as HTMLTextAreaElement).value = ""; });
    await input.focus();
    const hardwareBefore = read();
    await input.press("Control+Shift+d");
    await until(() => read().length > hardwareBefore.length, "hardware/touch combination received");
    assert.deepEqual(frames.at(-1).keys, ["ctrl+alt+shift+d"]);
    if (mode === "kitty") assert.equal(Buffer.from(read().slice(hardwareBefore.length), "hex").toString(), "\x1b[100;8u");
    // A physical key on a non-Latin layout names the chord by its position: Korean ㅊ on KeyC
    // with a held Ctrl is Ctrl+C (an interrupt herdr encodes), not ctrl+ㅊ (a letter it types).
    const layoutBefore = read();
    const layoutFrames = frames.length;
    // keydown and keyup both: xterm waits for the keypress of a key still down and ignores typed text
    await input.evaluate((element) => {
      for (const type of ["keydown", "keyup"]) element.dispatchEvent(new KeyboardEvent(type, { key: "ㅊ", code: "KeyC", keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await until(() => frames.length > layoutFrames, "non-Latin layout chord frame");
    assert.deepEqual(frames.at(-1).keys, ["ctrl+alt+c"], "a Korean-layout Ctrl+C with a held Alt");
    await until(() => read().length > layoutBefore.length, "non-Latin layout chord received by PTY");
    if (mode === "kitty") assert.equal(Buffer.from(read().slice(layoutBefore.length), "hex").toString(), "\x1b[99;7u");
    // A chord the terminal cannot take now is told, not dropped in silence: the page loses
    // input readiness, the key bar greys out, and a held-modifier key typed meanwhile is
    // answered with the not-sent banner. Nothing is queued for later.
    ws!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: false }));
    await until(() => ctrl.isDisabled(), "key bar disabled while input is not ready");
    const notReadyFrames = frames.length;
    await page.keyboard.insertText("q");
    const notSent = page.locator(".terminal-banner", { hasText: "Not sent: the terminal is not ready for keys." });
    await notSent.waitFor({ state: "visible" });
    assert.equal(frames.slice(notReadyFrames).some((frame) => frame.type === "keys" || frame.type === "input"), false, "nothing sent while input is not ready");
    await notSent.locator(".terminal-banner-action").tap();
    await until(async () => (await notSent.count()) === 0, "not-sent banner dismissed");
    ws!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: true }));
    await until(async () => !(await ctrl.isDisabled()), "key bar enabled again");
    console.log(`${mode} chord while not ready: told, not sent`);
    // Removing the optional Alt button must not leave an invisible held modifier.
    await page.keyboard.press(settingsShortcut);
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await openSettingsPage(page, "Terminal");
    await settings.getByRole("button", { name: "Edit key bar", exact: true }).tap();
    const keyBarSettings = page.getByRole("dialog", { name: "Key bar", exact: true });
    const heldModifierSettings = keyBarSettings.getByRole("group", { name: "Held modifiers", exact: true });
    await heldModifierSettings.getByRole("button", { name: "Alt", exact: true }).tap();
    await keyBarSettings.getByRole("button", { name: "Close settings", exact: true }).tap();
    assert.equal(await page.locator('[data-key="Alt"]').count(), 0);
    const plainBefore = frames.length;
    await until(async () => !(await ctrl.isDisabled()), "typing ready after settings");
    await input.evaluate((element) => { (element as HTMLTextAreaElement).value = ""; });
    await keyBarSettings.waitFor({ state: "hidden" });
    await input.focus();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await input.focus();
    await input.press("z");
    await until(() => frames.length > plainBefore, "typing after hiding Alt");
    assert.equal(frames.at(-1).type, "input");
    assert.equal(frames.at(-1).text, "z");
    await page.keyboard.press(settingsShortcut);
    await openSettingsPage(page, "Terminal");
    await settings.getByRole("button", { name: "Edit key bar", exact: true }).tap();
    await heldModifierSettings.getByRole("button", { name: "Alt", exact: true }).tap();
    await keyBarSettings.getByRole("button", { name: "Close settings", exact: true }).tap();
    previousMask = 0;
    assert.equal(await page.locator('[data-key="Alt"]').getAttribute("aria-pressed"), "false");
    // Leaving the terminal lens clears held state on the same pane.
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).tap();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).tap();
    await until(async () => !(await ctrl.isDisabled()), "terminal lens ready again");
    for (const key of ["Control", "Alt", "Shift"]) assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), "false");
    previousMask = 0;
    // A cancelled chord or text says so in a banner. The banner column lets taps through to the
    // terminal under it, so its Dismiss has to take them back.
    ws!.send(JSON.stringify({ type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: pane }));
    const refused = page.locator(".terminal-banner", { hasText: "Terminal input could not be confirmed" });
    await refused.waitFor();
    await refused.getByRole("button", { name: "Dismiss", exact: true }).tap({ timeout: 5_000 });
    await refused.waitFor({ state: "hidden" });
    assert.equal(await ctrl.isDisabled(), false, "a refused key leaves the pane ready for the next one");
    await input.focus();
    await held(7);
    // Disconnect clears all modifiers and sends no retained shortcuts on reconnect.
    await ws!.close();
    await until(async () => (await ctrl.getAttribute("aria-pressed")) === "false", "disconnect clears held Ctrl");
    for (const key of ["Alt", "Shift"]) assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), "false");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone has no horizontal page overflow");
    await context.close();
    await checkInputLine(browser, mode, pane, read);
    console.log(`PASS ${mode}: seven modifier combinations, repeated keys, actual PTY bytes, touch focus, paste, IME, reset`);
  }
  assert.deepEqual(errors, []);
} finally {
  await launched?.close(); server.stop();
  for (const id of owned) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
