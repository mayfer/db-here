/**
 * Download platform-correct PostgreSQL server builds from
 * github.com/theseus-rs/postgresql-binaries (same source pg-embedded uses).
 *
 * We do this ourselves because pg-embedded has been observed to install
 * x86_64 server binaries on linux/arm64 hosts.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  binaryMatchesHost,
  wipeMismatchedPostgresInstalls,
} from "./binary-arch.js";
import {
  chmodX,
  detectOsCpu,
  downloadFile,
  extractTar,
  findFirst,
  makeTempDir,
  safeRename,
} from "./download.js";

/** Matches pg-embedded 0.2.3+pg18.0 default line. */
export const DEFAULT_PG_SERVER_VERSION = "18.0.0";

const RELEASE_BASE =
  "https://github.com/theseus-rs/postgresql-binaries/releases/download";

function rustTargetTriple(): string {
  const { os, cpu } = detectOsCpu();
  if (os === "darwin" && cpu === "arm64") return "aarch64-apple-darwin";
  if (os === "darwin" && cpu === "x64") return "x86_64-apple-darwin";
  if (os === "linux" && cpu === "arm64") return "aarch64-unknown-linux-gnu";
  if (os === "linux" && cpu === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported platform for PostgreSQL binaries: ${os}/${cpu}`);
}

function versionHome(installationDir: string, version: string): string {
  return join(resolve(installationDir), version);
}

function postgresBinaryPath(installationDir: string, version: string): string {
  return join(versionHome(installationDir, version), "bin", "postgres");
}

function isUsableInstall(installationDir: string, version: string): boolean {
  const binary = postgresBinaryPath(installationDir, version);
  if (!existsSync(binary)) return false;
  if (!existsSync(join(versionHome(installationDir, version), "bin", "initdb"))) {
    return false;
  }
  return binaryMatchesHost(binary);
}

/**
 * Ensure `installationDir/<version>/bin/postgres` exists and matches host CPU.
 */
export async function ensurePostgresServerBinary(options: {
  installationDir: string;
  version?: string;
  onProgress?: (message: string) => void;
}): Promise<{ version: string; basedir: string; postgresPath: string }> {
  const installationDir = resolve(options.installationDir);
  const version = options.version ?? DEFAULT_PG_SERVER_VERSION;

  wipeMismatchedPostgresInstalls(installationDir);

  const basedir = versionHome(installationDir, version);
  const postgresPath = postgresBinaryPath(installationDir, version);

  if (isUsableInstall(installationDir, version)) {
    return { version, basedir, postgresPath };
  }

  // Stale / wrong-arch leftover for this version
  if (existsSync(basedir)) {
    rmSync(basedir, { recursive: true, force: true });
  }

  const triple = rustTargetTriple();
  const fileName = `postgresql-${version}-${triple}.tar.gz`;
  const url = `${RELEASE_BASE}/${version}/${fileName}`;

  options.onProgress?.(
    `Downloading PostgreSQL ${version} (${triple})…`
  );

  const tmp = makeTempDir("db-here-pg");
  try {
    const archive = join(tmp, fileName);
    await downloadFile(url, archive, options.onProgress);
    options.onProgress?.(`Extracting PostgreSQL ${version}…`);
    await extractTar(archive, tmp);

    const found = findFirst(
      tmp,
      (name, full) => name === "postgres" && full.includes("/bin/")
    );
    if (!found) {
      throw new Error(
        `postgres binary not found in ${fileName}. URL may be wrong: ${url}`
      );
    }
    // Archive root is postgresql-<ver>-<triple>/  (…/bin/postgres → ../..)
    const root = dirname(dirname(found));
    mkdirSync(installationDir, { recursive: true });
    safeRename(root, basedir);

    chmodX(postgresPath);
    chmodX(join(basedir, "bin", "initdb"));
    // Mark other bins executable when present
    try {
      for (const name of readdirSync(join(basedir, "bin"))) {
        chmodX(join(basedir, "bin", name));
      }
    } catch {
      // ignore
    }

    if (!isUsableInstall(installationDir, version)) {
      throw new Error(
        `PostgreSQL install at ${basedir} is missing or wrong architecture after download (${triple})`
      );
    }

    options.onProgress?.(`PostgreSQL ${version} ready at ${basedir}`);
    return { version, basedir, postgresPath };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
