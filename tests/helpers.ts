import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export const supported =
  process.platform === "darwin" || process.platform === "linux";

/** Project-local binary cache (shared across test runs for speed). */
export function binCache(engine: string): string {
  return join(process.cwd(), "db-here-data", engine, "bin");
}

export function tempProject(prefix = "db-here-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function tcpOk(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    s.setTimeout(timeoutMs);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });
}

/** Stable-ish free port base + pid offset. */
export function testPort(base: number): number {
  return base + (process.pid % 200);
}
