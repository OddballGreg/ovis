import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchdog, type WatchedCommand } from "./opencode-watchdog.ts";

const WATCHDOG = join(import.meta.dir, "opencode-watchdog.ts");
/** A command that runs until it is stopped. */
const FOREVER = [process.execPath, "-e", "setInterval(() => {}, 1000)"];

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting");
}

const running = (pid: number): boolean => {
  if (process.platform === "linux") {
    // an orphan's zombie still answers signal 0 until its new parent reaps it
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const root = mkdtempSync(join(tmpdir(), "herdr-opencode-watchdog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in server: starts a child of its own that ignores SIGTERM, writes both pids to a file,
 * and on SIGTERM exits at once, after a moment ("slow"), or never ("stubborn").
 */
const SERVER = join(root, "server.ts");
writeFileSync(SERVER, `
  const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(100);
  require("node:fs").writeFileSync(process.argv[2], process.pid + " " + child.pid);
  if (process.argv[3] === "slow") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 500));
  if (process.argv[3] === "stubborn") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`);
let serverFiles = 0;
const serverCommand = (mode: "plain" | "slow" | "stubborn") => {
  const file = join(root, `pids-${++serverFiles}`);
  return { argv: [process.execPath, SERVER, file, mode], pids: () => existsSync(file) ? readFileSync(file, "utf8").split(" ").map(Number) : null };
};

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

function fakeCommand(options: { stubborn?: boolean } = {}) {
  const exited = Promise.withResolvers<number | null>();
  const signals: string[] = [];
  const command: WatchedCommand = {
    pid: 4242,
    exited: exited.promise,
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") exited.resolve(null);
      else if (!options.stubborn) exited.resolve(143);
    },
    sweep: () => { signals.push("sweep"); },
  };
  return { command, signals, exit: (code: number) => exited.resolve(code) };
}

describe("the watchdog an OpenCode server runs under", () => {
  it("prints the command's pid, stops it when stdin ends, and exits with its code", async () => {
    const fake = fakeCommand();
    const stdin = Promise.withResolvers<void>();
    const printed: string[] = [];
    const done = watchdog(["opencode", "serve"], 50, { spawn: (argv) => { expect(argv).toEqual(["opencode", "serve"]); return fake.command; }, stdinEnded: stdin.promise, onSignal: () => {}, print: (line) => { printed.push(line); } });
    expect(printed).toEqual(["pid 4242"]);
    stdin.resolve();
    expect(await done).toBe(143);
    expect(fake.signals).toEqual(["SIGTERM", "sweep"]);
  });

  it("hears a stop asked before the command started, and stops the command as soon as it runs", async () => {
    const fake = fakeCommand();
    let stop = () => {};
    const done = watchdog(["opencode"], 20, {
      onSignal: (handler) => { stop = handler; },
      // the signal arrives while the command is being started
      spawn: () => { stop(); return fake.command; },
      stdinEnded: new Promise(() => {}),
      print: () => {},
    });
    expect(await done).toBe(143);
    expect(fake.signals).toEqual(["SIGTERM", "sweep"]);
  });

  it("stops it on a signal, and kills one that ignores SIGTERM after the grace period", async () => {
    const fake = fakeCommand({ stubborn: true });
    let stop = () => {};
    const done = watchdog(["opencode"], 20, { spawn: () => fake.command, stdinEnded: new Promise(() => {}), onSignal: (handler) => { stop = handler; }, print: () => {} });
    stop();
    stop();
    expect(await done).toBeNull();
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL", "sweep"]);
  });

  it("leaves a command alone while stdin stays open, and returns its own exit", async () => {
    const fake = fakeCommand();
    const done = watchdog(["opencode"], 20, { spawn: () => fake.command, stdinEnded: new Promise(() => {}), onSignal: () => {}, print: () => {} });
    fake.exit(7);
    expect(await done).toBe(7);
    expect(fake.signals).toEqual(["sweep"]);
  });

  it("stops the real command once the pipe to it closes", async () => {
    const proc = Bun.spawn([process.execPath, WATCHDOG, "500", ...FOREVER], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const pid = Number(/^pid (\d+)$/.exec(await firstLine(proc.stdout))![1]);
    expect(running(pid)).toBe(true);
    void proc.stdin.end();
    await until(() => proc.exitCode !== null || proc.signalCode !== null);
    await until(() => !running(pid));
  });

  it.skipIf(process.platform === "win32")("stops the real command when the process that started it is killed outright", async () => {
    const parent = Bun.spawn([process.execPath, "-e", `
      const watched = Bun.spawn([process.execPath, ${JSON.stringify(WATCHDOG)}, "500", ...${JSON.stringify(FOREVER)}], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      const reader = watched.stdout.getReader();
      const { value } = await reader.read();
      process.stdout.write(new TextDecoder().decode(value));
      setInterval(() => {}, 1000);
    `], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const pid = Number(/^pid (\d+)$/.exec(await firstLine(parent.stdout))![1]);
    expect(running(pid)).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    await until(() => !running(pid));
  });

  it.skipIf(process.platform === "win32")("stops the command's whole process group: a child it started goes too", async () => {
    const server = serverCommand("plain");
    const proc = Bun.spawn([process.execPath, WATCHDOG, "500", ...server.argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    await firstLine(proc.stdout);
    await until(() => server.pids() !== null);
    const [pid, child] = server.pids()!;
    expect(running(pid!) && running(child!)).toBe(true);
    void proc.stdin.end();
    await proc.exited;
    await until(() => !running(pid!) && !running(child!));
  });

  it.skipIf(process.platform === "win32")("waits for a server that stops slowly, then sweeps what is left of its group", async () => {
    const server = serverCommand("slow");
    const proc = Bun.spawn([process.execPath, WATCHDOG, "10000", ...server.argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    await firstLine(proc.stdout);
    await until(() => server.pids() !== null);
    const [pid, child] = server.pids()!;
    const asked = Date.now();
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    // it exited on its own, well before the grace was up, and its child that ignores SIGTERM went with it
    expect(Date.now() - asked).toBeLessThan(5_000);
    await until(() => !running(pid!) && !running(child!));
  });

  it.skipIf(process.platform === "win32")("kills a server that ignores SIGTERM after the grace, with its group", async () => {
    const server = serverCommand("stubborn");
    const proc = Bun.spawn([process.execPath, WATCHDOG, "300", ...server.argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    await firstLine(proc.stdout);
    await until(() => server.pids() !== null);
    const [pid, child] = server.pids()!;
    void proc.stdin.end();
    proc.kill("SIGTERM");
    await proc.exited;
    await until(() => !running(pid!) && !running(child!));
  });

  it.skipIf(process.platform === "win32")("leaves no server behind when it is stopped before its pid line was read", async () => {
    const server = serverCommand("plain");
    const proc = Bun.spawn([process.execPath, WATCHDOG, "500", ...server.argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    // asked to stop at once, as the app's stop does: the pipe closes and SIGTERM goes, nothing read
    void proc.stdin.end();
    proc.kill("SIGTERM");
    // the watchdog exits only after the server did, so no pid file can appear later
    await proc.exited;
    const pids = server.pids();
    if (pids !== null) await until(() => pids.every((pid) => !running(pid)));
  });
});
