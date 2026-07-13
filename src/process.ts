import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function spawnDetached(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {}
): ChildProcess {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  return child;
}

export function waitForExit(
  child: ChildProcess | null,
  timeoutMs: number
): Promise<void> {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function readLogTail(path: string, max = 4000): string {
  if (!existsSync(path)) {
    return "(no log file)";
  }
  try {
    return readFileSync(path, "utf8").slice(-max);
  } catch {
    return "(could not read log)";
  }
}
