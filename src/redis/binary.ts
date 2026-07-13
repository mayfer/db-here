import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { unzipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import { safeRename } from "../download.js";
import {
  condaPackageUrl,
  DEFAULT_REDIS_VERSION,
  detectRedisPlatform,
  REDIS_PACKAGE_BUILDS,
  type RedisPlatformInfo,
} from "./platform.js";

export { DEFAULT_REDIS_VERSION };

export interface EnsureRedisBinaryOptions {
  installationDir: string;
  version?: string;
  onProgress?: (message: string) => void;
}

export interface RedisBinaryInfo {
  version: string;
  basedir: string;
  redisServerPath: string;
  redisCliPath: string;
  libDir: string;
  platform: RedisPlatformInfo;
}

export async function ensureRedisBinary(
  options: EnsureRedisBinaryOptions
): Promise<RedisBinaryInfo> {
  const version = options.version ?? DEFAULT_REDIS_VERSION;
  if (version !== DEFAULT_REDIS_VERSION) {
    throw new Error(
      `Redis version "${version}" is not available as a pinned portable build. Supported: ${DEFAULT_REDIS_VERSION}`
    );
  }

  const platformInfo = detectRedisPlatform();
  const installationDir = resolve(options.installationDir);
  const basedir = join(installationDir, version);
  const redisServerPath = join(basedir, "bin", "redis-server");

  if (existsSync(redisServerPath)) {
    return buildBinaryInfo(version, basedir, platformInfo);
  }

  mkdirSync(installationDir, { recursive: true });
  options.onProgress?.(
    `Downloading Redis ${version} (${platformInfo.subdir})…`
  );

  const builds = REDIS_PACKAGE_BUILDS[platformInfo.subdir];
  const downloadDir = join(tmpdir(), `db-here-redis-${process.pid}`);
  mkdirSync(downloadDir, { recursive: true });

  try {
    const redisPkg = join(downloadDir, builds.redis);
    const opensslPkg = join(downloadDir, builds.openssl);

    await downloadFile(
      condaPackageUrl(platformInfo.subdir, builds.redis),
      redisPkg,
      options.onProgress
    );
    await downloadFile(
      condaPackageUrl(platformInfo.subdir, builds.openssl),
      opensslPkg,
      options.onProgress
    );

    options.onProgress?.(`Extracting Redis ${version}…`);
    const staging = join(downloadDir, "staging");
    mkdirSync(staging, { recursive: true });

    await extractCondaPackage(redisPkg, staging);
    await extractCondaPackage(opensslPkg, staging);

    const redisServer = join(staging, "bin", "redis-server");
    if (!existsSync(redisServer)) {
      throw new Error("redis-server missing after package extract");
    }

    // Keep only what we need: redis bins + openssl shared libs.
    const finalStaging = join(downloadDir, "final");
    mkdirSync(join(finalStaging, "bin"), { recursive: true });
    mkdirSync(join(finalStaging, "lib"), { recursive: true });

    for (const name of [
      "redis-server",
      "redis-cli",
      "redis-benchmark",
      "redis-check-aof",
      "redis-check-rdb",
      "redis-sentinel",
    ]) {
      const src = join(staging, "bin", name);
      if (existsSync(src)) {
        // Same filesystem (both under downloadDir staging) — safeRename is fine.
        safeRename(src, join(finalStaging, "bin", name));
      }
    }

    const libDir = join(staging, "lib");
    if (existsSync(libDir)) {
      for (const entry of readdirSync(libDir)) {
        if (
          /\.(dylib|so)(\.\d+)*$/.test(entry) &&
          (entry.includes("ssl") || entry.includes("crypto"))
        ) {
          safeRename(join(libDir, entry), join(finalStaging, "lib", entry));
        }
      }
    }

    writeFileSync(
      join(finalStaging, ".db-here-redis"),
      `${version}\n${platformInfo.subdir}\n`,
      "utf8"
    );

    mkdirSync(installationDir, { recursive: true });
    safeRename(finalStaging, basedir);

    if (!existsSync(redisServerPath)) {
      throw new Error(`Redis binary missing after install: ${redisServerPath}`);
    }

    options.onProgress?.(`Redis ${version} ready at ${basedir}`);
    return buildBinaryInfo(version, basedir, platformInfo);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function buildBinaryInfo(
  version: string,
  basedir: string,
  platform: RedisPlatformInfo
): RedisBinaryInfo {
  return {
    version,
    basedir,
    redisServerPath: join(basedir, "bin", "redis-server"),
    redisCliPath: join(basedir, "bin", "redis-cli"),
    libDir: join(basedir, "lib"),
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
      `Failed to download ${url} (HTTP ${response.status})`
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
      if (pct >= lastPct + 20) {
        lastPct = pct;
        onProgress?.(
          `Downloading… ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
        );
      }
    }
  });

  await pipeline(nodeStream, createWriteStream(destPath));

  const size = statSync(destPath).size;
  if (size < 10_000) {
    throw new Error(
      `Downloaded file looks too small (${size} bytes): ${url}`
    );
  }
}

/**
 * Extract a conda `.conda` package (zip of zstd tarballs) into destDir.
 * Uses pure-JS unzip + zstd so no system tools beyond `tar` are required.
 */
async function extractCondaPackage(
  condaPath: string,
  destDir: string
): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const zipBytes = new Uint8Array(readFileSync(condaPath));
  const files = unzipSync(zipBytes);

  const pkgEntry = Object.keys(files).find((name) =>
    name.startsWith("pkg-") && name.endsWith(".tar.zst")
  );
  if (!pkgEntry) {
    throw new Error(`No pkg-*.tar.zst found in ${condaPath}`);
  }

  const tarBytes = zstdDecompress(files[pkgEntry]!);
  const tarPath = join(destDir, `${pkgEntry.replace(/\.zst$/, "")}`);
  writeFileSync(tarPath, tarBytes);
  await runCommand("tar", ["-xf", tarPath, "-C", destDir]);
  rmSync(tarPath, { force: true });
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

export function getInstalledRedisVersions(installationDir: string): string[] {
  if (!existsSync(installationDir)) {
    return [];
  }

  try {
    return readdirSync(installationDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d+\.\d+\.\d+$/.test(entry.name) &&
          existsSync(join(installationDir, entry.name, "bin", "redis-server"))
      )
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}
