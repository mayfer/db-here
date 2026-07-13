import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  detectMysqlPlatform,
  mysqlArchiveFileName,
  mysqlDownloadUrl,
  type MysqlPlatformInfo,
} from "./platform.js";

/** Default MySQL Community Server version (generic binary tarballs). */
export const DEFAULT_MYSQL_VERSION = "9.7.1";

export interface EnsureMysqlBinaryOptions {
  installationDir: string;
  version?: string;
  onProgress?: (message: string) => void;
}

export interface MysqlBinaryInfo {
  version: string;
  basedir: string;
  mysqldPath: string;
  mysqlPath: string;
  mysqladminPath: string;
  platform: MysqlPlatformInfo;
}

export async function ensureMysqlBinary(
  options: EnsureMysqlBinaryOptions
): Promise<MysqlBinaryInfo> {
  const version = options.version ?? DEFAULT_MYSQL_VERSION;
  const platformInfo = detectMysqlPlatform();
  const installationDir = resolve(options.installationDir);
  const basedir = join(installationDir, version);
  const mysqldPath = join(basedir, "bin", "mysqld");

  if (existsSync(mysqldPath)) {
    return buildBinaryInfo(version, basedir, platformInfo);
  }

  mkdirSync(installationDir, { recursive: true });
  options.onProgress?.(
    `Downloading MySQL ${version} (${platformInfo.id})…`
  );

  const archiveName = mysqlArchiveFileName(version, platformInfo);
  const url = mysqlDownloadUrl(version, platformInfo);
  const downloadDir = join(tmpdir(), `db-here-mysql-${process.pid}`);
  mkdirSync(downloadDir, { recursive: true });
  const archivePath = join(downloadDir, archiveName);

  try {
    await downloadFile(url, archivePath, options.onProgress);
    options.onProgress?.(`Extracting MySQL ${version}…`);
    await extractArchive(archivePath, downloadDir, platformInfo.archiveExt);

    const extractedRoot = findExtractedRoot(downloadDir, version);
    if (!extractedRoot) {
      throw new Error(
        `Could not locate extracted MySQL directory after unpacking ${archiveName}`
      );
    }

    if (existsSync(basedir)) {
      rmSync(basedir, { recursive: true, force: true });
    }
    renameSync(extractedRoot, basedir);

    if (!existsSync(mysqldPath)) {
      throw new Error(
        `MySQL binary missing after install: ${mysqldPath}`
      );
    }

    options.onProgress?.(`MySQL ${version} ready at ${basedir}`);
    return buildBinaryInfo(version, basedir, platformInfo);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function buildBinaryInfo(
  version: string,
  basedir: string,
  platform: MysqlPlatformInfo
): MysqlBinaryInfo {
  return {
    version,
    basedir,
    mysqldPath: join(basedir, "bin", "mysqld"),
    mysqlPath: join(basedir, "bin", "mysql"),
    mysqladminPath: join(basedir, "bin", "mysqladmin"),
    platform,
  };
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download MySQL binary from ${url} (HTTP ${response.status})`
    );
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
      if (pct >= lastPct + 10) {
        lastPct = pct;
        onProgress?.(
          `Downloading… ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
        );
      }
    }
  });

  await pipeline(nodeStream, createWriteStream(destPath));

  const size = statSync(destPath).size;
  if (size < 1_000_000) {
    throw new Error(
      `Downloaded MySQL archive looks too small (${size} bytes). URL may be wrong: ${url}`
    );
  }
}

async function extractArchive(
  archivePath: string,
  destDir: string,
  ext: ".tar.gz" | ".tar.xz"
): Promise<void> {
  const args =
    ext === ".tar.xz"
      ? ["-xJf", archivePath, "-C", destDir]
      : ["-xzf", archivePath, "-C", destDir];

  await runCommand("tar", args);
}

function findExtractedRoot(
  downloadDir: string,
  version: string
): string | null {
  const entries = readdirSync(downloadDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(downloadDir, entry.name));

  const preferred = dirs.find(
    (dir) =>
      dir.includes(`mysql-${version}`) &&
      existsSync(join(dir, "bin", "mysqld"))
  );
  if (preferred) {
    return preferred;
  }

  return (
    dirs.find((dir) => existsSync(join(dir, "bin", "mysqld"))) ?? null
  );
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr}`
        )
      );
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getInstalledMysqlVersions(installationDir: string): string[] {
  if (!existsSync(installationDir)) {
    return [];
  }

  try {
    return readdirSync(installationDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d+\.\d+\.\d+$/.test(entry.name) &&
          existsSync(join(installationDir, entry.name, "bin", "mysqld"))
      )
      .map((entry) => entry.name)
      .sort(compareSemVerDesc);
  } catch {
    return [];
  }
}

function compareSemVerDesc(left: string, right: string): number {
  const leftParts = left.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const rightParts = right.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i++) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l !== r) return r - l;
  }
  return 0;
}
