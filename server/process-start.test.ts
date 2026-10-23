import { describe, expect, it } from "bun:test";
import { createDarwinStartReader, parseElapsed, processStartedAt, processStartLowerBound, processStartUpperBound, processStartUpperBoundAsync } from "./process-start.ts";

describe("bounded macOS process start reads", () => {
  it("returns unknown when the bounded spawn times out even with partial output", () => {
    // Given a probe that reached its timeout after writing valid elapsed time.
    const probes: { argv: string[]; timeout: number; killSignal: string }[] = [];
    const read = createDarwinStartReader((argv, options) => {
      probes.push({ argv, timeout: options.timeout, killSignal: options.killSignal });
      return { exitCode: 0, stdout: "00:05", exitedDueToTimeout: true };
    });
    // When the process start is requested, then timeout output grants no identity.
    expect(read(42)).toBeNull();
    expect(probes).toEqual([{ argv: ["/bin/ps", "-o", "etime=", "-p", "42"], timeout: 1000, killSignal: "SIGKILL" }]);
  });

  it.each([1, 0])("does not cache failed or unreadable output with exit code %i", (exitCode) => {
    // Given a failed read followed by a successful one.
    let calls = 0;
    const read = createDarwinStartReader(() => {
      calls++;
      return { exitCode: calls === 1 ? exitCode : 0, stdout: calls === 1 && exitCode === 0 ? "" : "00:05" };
    }, () => 10_000, () => true);
    expect(read(42)).toBeNull();
    // When retried, then the unknown result has not masked the new reading.
    expect(read(42)?.started).toBe(5000);
    expect(calls).toBe(2);
  });

  it("returns unknown when spawning throws", () => {
    // Given an unavailable subprocess.
    const read = createDarwinStartReader(() => { throw new TypeError("spawn unavailable"); });
    // When read, then the existing failed-read result is preserved.
    expect(read(42)).toBeNull();
  });

  it("avoids a second spawn for a live PID within the cache window", () => {
    // Given a successful read.
    let calls = 0;
    const read = createDarwinStartReader(() => { calls++; return { exitCode: 0, stdout: "00:05" }; }, () => 10_000, () => true);
    read(42);
    // When read again immediately, then the cached start avoids another spawn.
    expect(read(42)?.started).toBe(5000);
    expect(calls).toBe(1);
  });

  it("rereads a reused PID at the fixed expiry even after cache hits", () => {
    // Given a cached old process and a clock controlled without sleeps.
    let now = 10_000;
    let calls = 0;
    const read = createDarwinStartReader(() => {
      calls++;
      return { exitCode: 0, stdout: calls === 1 ? "00:05" : "00:00" };
    }, () => now, () => true);
    read(42);
    now += 99;
    read(42);
    // When the PID is reused at expiry, then a hit has not extended the old identity.
    now++;
    expect(read(42)?.started).toBe(10_100);
    expect(calls).toBe(2);
  });

  it("drops a cached start when the PID has exited", () => {
    // Given a cached process that subsequently exits before expiry.
    let alive = true;
    let calls = 0;
    const read = createDarwinStartReader(() => {
      calls++;
      return { exitCode: alive ? 0 : 1, stdout: "00:05" };
    }, () => 10_000, () => alive);
    read(42);
    alive = false;
    // When read again, then the dead process has no cached identity.
    expect(read(42)).toBeNull();
    expect(calls).toBe(2);
  });

  it("evicts the least recently read PID when the cache reaches its bound", () => {
    // Given 128 live cached PIDs, with PID 0 refreshed most recently.
    let calls = 0;
    const read = createDarwinStartReader(() => { calls++; return { exitCode: 0, stdout: "00:05" }; }, () => 10_000, () => true);
    for (let pid = 0; pid < 128; pid++) read(pid);
    read(0);
    // When another PID fills the cache, then PID 1, not PID 0, needs a new read.
    read(128);
    read(0);
    expect(calls).toBe(129);
    read(1);
    expect(calls).toBe(130);
  });

  it("preserves the before and after clocks for the lower bound and start estimate", () => {
    // Given a probe that takes 20 ms.
    let now = 10_000;
    const read = createDarwinStartReader(() => {
      now += 20;
      return { exitCode: 0, stdout: "00:05" };
    }, () => now, () => true);
    // When read, then its lower bound uses the earlier clock, not the cached estimate.
    expect(read(42)).toEqual({ started: 5020, lower: 4000, readAt: 10_000 });
  });
});

describe("process start time", () => {
  it("reads every form of ps's elapsed time", () => {
    expect(parseElapsed("   00:07\n")).toBe(7);
    expect(parseElapsed("12:34")).toBe(12 * 60 + 34);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseElapsed("")).toBeNull();
  });

  it("tells when a running process started, to the second", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const started = processStartedAt(child.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - Date.now())).toBeLessThan(2500);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a new Linux process closely enough to identify its first thread", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const upper = processStartUpperBound(child.pid);
      expect(upper).not.toBeNull();
      expect(upper!).toBeGreaterThanOrEqual(before);
      expect(upper!).toBeLessThanOrEqual(Date.now() + 25);
      expect(processStartUpperBound(2147483647)).toBeNull();
      // the async form a send's process check awaits is the same bound from above, never the one from below
      const awaited = await processStartUpperBoundAsync(child.pid);
      expect(awaited).not.toBeNull();
      expect(awaited!).toBeGreaterThanOrEqual(before);
      expect(awaited!).toBeLessThanOrEqual(Date.now() + 25);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("bounds a process's start from below, closely enough to take in a thread made as it starts", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const lower = processStartLowerBound(child.pid);
      expect(lower).not.toBeNull();
      // never after the process started (it started by the time spawn returned) ...
      expect(lower!).toBeLessThanOrEqual(spawned);
      // ... and close: on Linux within btime's whole second and a tick, on macOS the second `ps` counts
      // and the one it may round away
      expect(lower!).toBeGreaterThanOrEqual(before - (process.platform === "linux" ? 1030 : 2100));
      expect(processStartLowerBound(2147483647)).toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("keeps a Linux start the same on every read: it is the process's identity", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const reads = new Set(Array.from({ length: 20 }, () => processStartedAt(child.pid)));
      expect(reads.size).toBe(1);
      expect([...reads][0]).not.toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a Linux start below both readings: btime's and the uptime's", async () => {
    // btime is whole seconds: processStartedAt may be up to a second early, the bound below it still
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const started = processStartedAt(child.pid)!;
      const lower = processStartLowerBound(child.pid)!;
      expect(lower).toBeLessThanOrEqual(started - 10);
      expect(lower).toBeLessThanOrEqual(spawned);
      expect(lower).toBeGreaterThanOrEqual(before - 1030);
    } finally { child.kill(); }
  });
});
