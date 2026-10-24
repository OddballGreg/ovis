/**
 * What opencode-v1.ts starts `opencode serve` through, and the only process that stops it: this
 * runs the command it is given in a process group of its own, prints `pid <n>` for it, and stops
 * that group once its own stdin ends. The server that started it holds the other end of that pipe,
 * and the pipe ends however that server goes, a SIGKILL or the OOM killer included, which run no
 * exit handler. SIGTERM, SIGINT and SIGHUP stop it too; their handlers are in place before the
 * command starts, so a stop asked at any time is heard. A stop sends the group SIGTERM, then
 * SIGKILL after the grace period, and once the command has exited whatever is left of its group
 * (a child it started) gets SIGKILL. This exits with the command's exit code.
 *
 *   bun server/opencode-watchdog.ts <grace ms> <command> [args…]
 */

export interface WatchedCommand {
  pid: number;
  exited: Promise<number | null>;
  /** signals the command's process group */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** SIGKILL to what is left of the group once the command exited */
  sweep(): void;
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
  let command: WatchedCommand | null = null;
  let asked = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    asked = true;
    if (command === null || killer !== undefined) return;
    const running = command;
    running.kill("SIGTERM");
    killer = setTimeout(() => running.kill("SIGKILL"), graceMs);
  };
  deps.onSignal(stop);
  void deps.stdinEnded.then(stop, stop);
  command = deps.spawn(argv);
  deps.print(`pid ${command.pid}`);
  if (asked) stop();
  const code = await command.exited;
  clearTimeout(killer);
  command.sweep();
  return code;
}

/** Signal a process group; Windows has none, so there the process alone. */
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL", child: { kill(signal: "SIGTERM" | "SIGKILL"): void }): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch { /* gone already */ }
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
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, detached: true });
      return {
        pid: child.pid,
        exited: child.exited.then((exit) => child.signalCode === null ? exit : null),
        kill: (signal) => signalGroup(child.pid, signal, child),
        sweep: () => { if (process.platform !== "win32") signalGroup(child.pid, "SIGKILL", child); },
      };
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
