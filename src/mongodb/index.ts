import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  chmodX,
  detectOsCpu,
  downloadFile,
  extractTar,
  findFirst,
  makeTempDir,
  safeRename,
  waitForTcp,
} from "../download.js";
import { wrapEngineHandle } from "../engine-handle.js";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import { readLogTail, spawnDetached, waitForExit } from "../process.js";
import type { DbHereHandle, MongodbOptions } from "../types.js";

export const DEFAULT_MONGODB_PORT = 57017;
export const DEFAULT_MONGODB_VERSION = "8.0.9";
export const DEFAULT_MONGODB_DATABASE = "test";

export interface MongodbHereHandle extends DbHereHandle {
  engine: "mongodb";
  instance: MongodbInstance;
}

class MongodbInstance {
  readonly dataDir: string;
  readonly configDir: string;
  readonly installationDir: string;
  readonly version: string;
  readonly port: number;
  readonly database: string;
  private process: ChildProcess | null = null;
  private mongodPath = "";
  private logPath = "";
  private readonly onProgress?: (m: string) => void;

  constructor(
    opts: {
      projectDir: string;
      dataRoot?: string;
      dataDir?: string;
      configDir?: string;
      installationDir?: string;
      version: string;
      port: number;
      database: string;
      onProgress?: (m: string) => void;
    }
  ) {
    const paths = getEnginePaths(opts.projectDir, "mongodb", opts.dataRoot);
    this.dataDir = resolve(opts.dataDir ?? paths.data);
    this.configDir = resolve(opts.configDir ?? paths.config);
    this.installationDir = resolve(opts.installationDir ?? paths.bin);
    this.version = opts.version;
    this.port = opts.port;
    this.database = opts.database;
    this.onProgress = opts.onProgress;
    this.logPath = join(this.configDir, "mongod.log");
  }

  async start(): Promise<void> {
    this.mongodPath = await ensureMongodbBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onProgress,
    });
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    this.process = spawnDetached(this.mongodPath, [
      "--dbpath",
      this.dataDir,
      "--port",
      String(this.port),
      "--bind_ip",
      "127.0.0.1",
      "--logpath",
      this.logPath,
      "--logappend",
    ]);

    this.process.on("exit", () => {
      this.process = null;
    });

    try {
      await waitForTcp(this.port, "127.0.0.1", 90_000);
    } catch (error) {
      throw new Error(
        `MongoDB failed to start.\n${readLogTail(this.logPath)}\n${error}`
      );
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 15_000);
      this.process = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

function mongodbArchive(version: string): { url: string; label: string } {
  const { os, cpu } = detectOsCpu();
  if (os === "darwin" && cpu === "arm64") {
    return {
      label: "macos-arm64",
      url: `https://fastdl.mongodb.org/osx/mongodb-macos-arm64-${version}.tgz`,
    };
  }
  if (os === "darwin" && cpu === "x64") {
    return {
      label: "macos-x86_64",
      url: `https://fastdl.mongodb.org/osx/mongodb-macos-x86_64-${version}.tgz`,
    };
  }
  if (os === "linux" && cpu === "x64") {
    return {
      label: "linux-x86_64",
      url: `https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2204-${version}.tgz`,
    };
  }
  if (os === "linux" && cpu === "arm64") {
    return {
      label: "linux-aarch64",
      url: `https://fastdl.mongodb.org/linux/mongodb-linux-aarch64-ubuntu2204-${version}.tgz`,
    };
  }
  throw new Error("Unsupported platform for MongoDB");
}

async function ensureMongodbBinary(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<string> {
  const basedir = join(options.installationDir, options.version);
  const mongod = join(basedir, "bin", "mongod");
  if (existsSync(mongod)) return mongod;

  const { url, label } = mongodbArchive(options.version);
  options.onProgress?.(`Downloading MongoDB ${options.version} (${label})…`);
  const tmp = makeTempDir("db-here-mongo");
  try {
    const archive = join(tmp, "mongo.tgz");
    await downloadFile(url, archive, options.onProgress);
    options.onProgress?.(`Extracting MongoDB ${options.version}…`);
    await extractTar(archive, tmp);
    const found = findFirst(tmp, (name, full) => name === "mongod" && full.includes("/bin/"));
    if (!found) throw new Error("mongod not found in archive");
    const root = resolve(found, "..", "..");
    safeRename(root, basedir);
    chmodX(mongod);
    options.onProgress?.(`MongoDB ${options.version} ready`);
    return mongod;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function startMongodbHere(
  options: MongodbOptions = {}
): Promise<MongodbHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_MONGODB_PORT,
    autoPort: options.autoPort,
  });
  const version =
    options.mongodbVersion ?? options.version ?? DEFAULT_MONGODB_VERSION;
  const database = options.database ?? DEFAULT_MONGODB_DATABASE;
  const projectDir = resolve(options.projectDir ?? process.cwd());

  const instance = new MongodbInstance({
    projectDir,
    dataRoot: options.dataRoot,
    dataDir: options.dataDir,
    configDir: options.configDir,
    installationDir: options.installationDir,
    version,
    port,
    database,
    onProgress: (m) => console.error(m),
  });

  await instance.start();

  const connectionString = `mongodb://127.0.0.1:${port}`;
  const databaseConnectionString = `mongodb://127.0.0.1:${port}/${database}`;

  return wrapEngineHandle({
    engine: "mongodb",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username: options.username ?? "",
    serverVersion: version,
    common: options,
    stopInstance: (i) => i.stop(),
    cleanupInstance: (i) => i.cleanup(),
  });
}

export function getPreStartMongodbState(
  projectDir?: string,
  dataRoot?: string
) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "mongodb",
    dataRoot
  );
  return {
    dataDir: paths.data,
    hasData: existsSync(paths.data) && existsSync(join(paths.data, "WiredTiger")),
    localDir: paths.displayRoot,
    installedVersion: existsSync(join(paths.bin, DEFAULT_MONGODB_VERSION))
      ? DEFAULT_MONGODB_VERSION
      : "",
  };
}
