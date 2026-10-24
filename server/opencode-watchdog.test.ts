import { describe, expect, it } from "bun:test";
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
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    expect(fake.signals).toEqual(["SIGTERM"]);
  });

  it("stops it on a signal, and kills one that ignores SIGTERM after the grace period", async () => {
    const fake = fakeCommand({ stubborn: true });
    let stop = () => {};
    const done = watchdog(["opencode"], 20, { spawn: () => fake.command, stdinEnded: new Promise(() => {}), onSignal: (handler) => { stop = handler; }, print: () => {} });
    stop();
    stop();
    expect(await done).toBeNull();
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("leaves a command alone while stdin stays open, and returns its own exit", async () => {
    const fake = fakeCommand();
    const done = watchdog(["opencode"], 20, { spawn: () => fake.command, stdinEnded: new Promise(() => {}), onSignal: () => {}, print: () => {} });
    fake.exit(7);
    expect(await done).toBe(7);
    expect(fake.signals).toEqual([]);
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
});
