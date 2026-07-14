import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  chmodX,
  detectOsCpu,
  downloadFile,
  makeTempDir,
  safeRename,
  waitForTcp,
} from "../download.js";
import { wrapEngineHandle } from "../engine-handle.js";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import { spawnDetached, waitForExit } from "../process.js";
import type { DbHereHandle, MinioOptions } from "../types.js";

export const DEFAULT_MINIO_PORT = 59000;
export const DEFAULT_MINIO_USERNAME = "minioadmin";
export const DEFAULT_MINIO_PASSWORD = "minioadmin";
/** Pinned path segment; MinIO publishes rolling “latest” binaries per arch. */
export const DEFAULT_MINIO_VERSION = "latest";

export interface MinioHereHandle extends DbHereHandle {
  engine: "minio";
  instance: MinioInstance;
  consolePort: number;
}

class MinioInstance {
  readonly dataDir: string;
  readonly configDir: string;
  readonly installationDir: string;
  readonly version: string;
  readonly port: number;
  readonly consolePort: number;
  readonly username: string;
  readonly password: string;
  private process: ChildProcess | null = null;
  private minioPath = "";
  private readonly onProgress?: (m: string) => void;

  constructor(opts: {
    projectDir: string;
    dataRoot?: string;
    dataDir?: string;
    configDir?: string;
    installationDir?: string;
    version: string;
    port: number;
    consolePort: number;
    username: string;
    password: string;
    onProgress?: (m: string) => void;
  }) {
    const paths = getEnginePaths(opts.projectDir, "minio", opts.dataRoot);
    this.dataDir = resolve(opts.dataDir ?? paths.data);
    this.configDir = resolve(opts.configDir ?? paths.config);
    this.installationDir = resolve(opts.installationDir ?? paths.bin);
    this.version = opts.version;
    this.port = opts.port;
    this.consolePort = opts.consolePort;
    this.username = opts.username;
    this.password = opts.password;
    this.onProgress = opts.onProgress;
  }

  async start(): Promise<void> {
    this.minioPath = await ensureMinioBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onProgress,
    });
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    this.process = spawnDetached(
      this.minioPath,
      [
        "server",
        this.dataDir,
        "--address",
        `127.0.0.1:${this.port}`,
        "--console-address",
        `127.0.0.1:${this.consolePort}`,
      ],
      {
        env: {
          ...process.env,
          MINIO_ROOT_USER: this.username,
          MINIO_ROOT_PASSWORD: this.password,
          MINIO_BROWSER: "on",
          HOME: this.configDir,
        },
      }
    );

    this.process.on("exit", () => {
      this.process = null;
    });

    await waitForTcp(this.port, "127.0.0.1", 60_000);
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 10_000);
      this.process = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

function minioDownloadUrl(version: string): { url: string; label: string } {
  const { os, cpu } = detectOsCpu();
  const arch =
    os === "darwin"
      ? cpu === "arm64"
        ? "darwin-arm64"
        : "darwin-amd64"
      : cpu === "arm64"
        ? "linux-arm64"
        : "linux-amd64";
  // MinIO release channel is "latest"; versioned builds use RELEASE.YYYY-… tags
  // under the same arch path when not "latest".
  const channel = version === "latest" ? "latest" : version;
  const base =
    channel === "latest"
      ? `https://dl.min.io/server/minio/release/${arch}/minio`
      : `https://dl.min.io/server/minio/release/${arch}/archive/minio.${channel}`;
  return {
    label: `${arch}/${channel}`,
    url: base,
  };
}

async function ensureMinioBinary(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<string> {
  const basedir = join(options.installationDir, options.version);
  const binary = join(basedir, "minio");
  if (existsSync(binary)) return binary;

  const { url, label } = minioDownloadUrl(options.version);
  options.onProgress?.(
    `Downloading MinIO ${options.version} (${label})…`
  );
  const tmp = makeTempDir("db-here-minio");
  try {
    const dest = join(tmp, "minio");
    await downloadFile(url, dest, options.onProgress);
    chmodX(dest);
    mkdirSync(basedir, { recursive: true });
    safeRename(dest, binary);
    chmodX(binary);
    options.onProgress?.(`MinIO ${options.version} ready at ${basedir}`);
    return binary;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function startMinioHere(
  options: MinioOptions = {}
): Promise<MinioHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_MINIO_PORT,
    autoPort: options.autoPort,
  });
  const consolePort =
    options.consolePort ??
    (await resolvePort({
      port: undefined,
      defaultPort: port + 1,
      autoPort: true,
    }));

  const version =
    options.minioVersion ?? options.version ?? DEFAULT_MINIO_VERSION;
  const username = options.username ?? DEFAULT_MINIO_USERNAME;
  const password = options.password ?? DEFAULT_MINIO_PASSWORD;
  const database = options.database ?? "default";
  const projectDir = resolve(options.projectDir ?? process.cwd());

  const instance = new MinioInstance({
    projectDir,
    dataRoot: options.dataRoot,
    dataDir: options.dataDir,
    configDir: options.configDir,
    installationDir: options.installationDir,
    version,
    port,
    consolePort,
    username,
    password,
    onProgress: (m) => console.error(m),
  });

  await instance.start();

  const connectionString = `http://${username}:${password}@127.0.0.1:${port}`;
  const databaseConnectionString = `s3://${username}:${password}@127.0.0.1:${port}/${database}`;

  const handle = await wrapEngineHandle({
    engine: "minio",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username,
    serverVersion: version,
    common: options,
    stopInstance: (i) => i.stop(),
    cleanupInstance: (i) => i.cleanup(),
  });

  return { ...handle, consolePort };
}

export function getPreStartMinioState(
  projectDir?: string,
  dataRoot?: string
) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "minio",
    dataRoot
  );
  return {
    dataDir: paths.data,
    hasData: existsSync(paths.data),
    localDir: paths.displayRoot,
    installedVersion: existsSync(
      join(paths.bin, DEFAULT_MINIO_VERSION, "minio")
    )
      ? DEFAULT_MINIO_VERSION
      : "",
  };
}
