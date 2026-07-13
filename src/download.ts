import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (message: string) => void,
  headers: Record<string, string> = {}
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    headers,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (HTTP ${response.status})`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let downloaded = 0;
  let lastPct = -1;

  const nodeStream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream
  );

  nodeStream.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.floor((downloaded / total) * 100);
      if (pct >= lastPct + 20) {
        lastPct = pct;
        onProgress?.(
          `Downloading… ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
        );
      }
    }
  });

  mkdirSync(join(destPath, ".."), { recursive: true });
  await pipeline(nodeStream, createWriteStream(destPath));

  const size = statSync(destPath).size;
  if (size < 1000) {
    throw new Error(`Downloaded file looks too small (${size} bytes): ${url}`);
  }
}

export async function extractTar(
  archivePath: string,
  destDir: string,
  extraArgs: string[] = []
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  // tar auto-detects gzip/bzip/xz on modern macOS/Linux for -xf
  await runCommand("tar", ["-xf", archivePath, "-C", destDir, ...extraArgs]);
}

export function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`
        )
      );
    });
  });
}

export function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Move a file or directory to `to`.
 * Falls back to copy+delete when rename fails with EXDEV (cross-device),
 * which is common on Linux when /tmp and $HOME are different filesystems.
 */
export function safeRename(from: string, to: string): void {
  mkdirSync(join(to, ".."), { recursive: true });
  if (existsSync(to)) {
    rmSync(to, { recursive: true, force: true });
  }
  try {
    renameSync(from, to);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
    if (code !== "EXDEV") {
      throw error;
    }
    cpSync(from, to, { recursive: true, force: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export function findFirst(
  root: string,
  predicate: (name: string, fullPath: string) => boolean
): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (predicate(entry.name, full)) {
        return full;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return null;
}

export function chmodX(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // ignore
  }
}

export function writeText(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function detectOsCpu(): {
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
} {
  const { platform, arch } = process;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported OS: ${platform}`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported CPU: ${arch}`);
  }
  return { os: platform, cpu: arch };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTcp(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 60_000
): Promise<void> {
  const { createConnection } = await import("node:net");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(150);
  }
  throw new Error(`Port ${host}:${port} did not open within ${timeoutMs}ms`);
}
