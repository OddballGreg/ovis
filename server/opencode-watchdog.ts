/**
 * What opencode-v1.ts starts `opencode serve` through, so that the server it started never
 * outlives it: this runs the command it is given, prints `pid <n>` for it, and stops it once its
 * own stdin ends. The server that started it holds the other end of that pipe, and the pipe ends
 * however that server goes, a SIGKILL or the OOM killer included, which run no exit handler.
 * SIGTERM, SIGINT and SIGHUP stop it too. A stop asks with SIGTERM, then SIGKILL after the grace
 * period; this exits with the command's exit code.
 *
 *   bun server/opencode-watchdog.ts <grace ms> <command> [args…]
 */

export interface WatchedCommand {
  pid: number;
  exited: Promise<number | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface WatchdogDeps {
  spawn(argv: string[]): WatchedCommand;
  /** settles when stdin ends, or fails to be read */
  stdinEnded: Promise<unknown>;
  onSignal(stop: () => void): void;
  print(line: string): void;
}

/** Run `argv` until it exits, stopping it when stdin ends or a signal asks; its exit code. */
export async function watchdog(argv: string[], graceMs: number, deps: WatchdogDeps): Promise<number | null> {
  const command = deps.spawn(argv);
  deps.print(`pid ${command.pid}`);
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (killer !== undefined) return;
    command.kill("SIGTERM");
    killer = setTimeout(() => command.kill("SIGKILL"), graceMs);
  };
  void deps.stdinEnded.then(stop, stop);
  deps.onSignal(stop);
  const code = await command.exited;
  clearTimeout(killer);
  return code;
}

if (import.meta.main) {
  const [grace, ...argv] = process.argv.slice(2);
  const graceMs = Number(grace);
  if (!Number.isFinite(graceMs) || graceMs < 0 || argv.length === 0) process.exit(2);
  const stdinEnded = (async () => {
    const reader = Bun.stdin.stream().getReader();
    while (!(await reader.read()).done) { /* nothing is ever written: only the end matters */ }
  })();
  const code = await watchdog(argv, graceMs, {
    spawn(command) {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
      return { pid: child.pid, exited: child.exited.then((exit) => child.signalCode === null ? exit : null), kill: (signal) => { try { child.kill(signal); } catch { /* gone already */ } } };
    },
    stdinEnded,
    onSignal(stop) {
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        try { process.on(signal, stop); } catch { /* not on this platform */ }
      }
    },
    print: (line) => { process.stdout.write(`${line}\n`); },
  });
  process.exit(code ?? 1);
}
