import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
  writeText,
} from "../download.js";
import { wrapEngineHandle } from "../engine-handle.js";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import { readLogTail, spawnDetached, waitForExit } from "../process.js";
import type { ClickhouseOptions, DbHereHandle } from "../types.js";

export const DEFAULT_CLICKHOUSE_PORT = 58123;
export const DEFAULT_CLICKHOUSE_VERSION = "24.12.1.1614";
export const DEFAULT_CLICKHOUSE_DATABASE = "default";
export const DEFAULT_CLICKHOUSE_USERNAME = "default";
export const DEFAULT_CLICKHOUSE_PASSWORD = "";

export interface ClickhouseHereHandle extends DbHereHandle {
  engine: "clickhouse";
  instance: ClickhouseInstance;
  nativePort: number;
}

class ClickhouseInstance {
  readonly dataDir: string;
  readonly configDir: string;
  readonly installationDir: string;
  readonly version: string;
  readonly httpPort: number;
  readonly nativePort: number;
  readonly username: string;
  readonly password: string;
  private process: ChildProcess | null = null;
  private binaryPath = "";
  private logPath = "";
  private readonly onProgress?: (m: string) => void;

  constructor(opts: {
    projectDir: string;
    dataRoot?: string;
    dataDir?: string;
    configDir?: string;
    installationDir?: string;
    version: string;
    httpPort: number;
    nativePort: number;
    username: string;
    password: string;
    onProgress?: (m: string) => void;
  }) {
    const paths = getEnginePaths(opts.projectDir, "clickhouse", opts.dataRoot);
    this.dataDir = resolve(opts.dataDir ?? paths.data);
    this.configDir = resolve(opts.configDir ?? paths.config);
    this.installationDir = resolve(opts.installationDir ?? paths.bin);
    this.version = opts.version;
    this.httpPort = opts.httpPort;
    this.nativePort = opts.nativePort;
    this.username = opts.username;
    this.password = opts.password;
    this.onProgress = opts.onProgress;
    this.logPath = join(this.configDir, "clickhouse-server.log");
  }

  async start(): Promise<void> {
    this.binaryPath = await ensureClickhouseBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onProgress,
    });

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    const configPath = join(this.configDir, "config.xml");
    writeText(configPath, buildClickhouseConfig({
      dataDir: this.dataDir,
      configDir: this.configDir,
      httpPort: this.httpPort,
      nativePort: this.nativePort,
      logPath: this.logPath,
    }));

    // Standalone users.xml (profiles + quotas + user) — required when not
    // shipping ClickHouse's full default config tree.
    writeText(
      join(this.configDir, "users.xml"),
      buildClickhouseUsers({
        username: this.username,
        password: this.password,
      })
    );

    this.process = spawnDetached(this.binaryPath, [
      "server",
      "--config-file",
      configPath,
    ], {
      env: {
        ...process.env,
        CLICKHOUSE_WATCHDOG_ENABLE: "0",
      },
    });

    this.process.on("exit", () => {
      this.process = null;
    });

    try {
      await waitForTcp(this.httpPort, "127.0.0.1", 90_000);
    } catch (error) {
      throw new Error(
        `ClickHouse failed to start.\n${readLogTail(this.logPath)}\n${error}`
      );
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 20_000);
      this.process = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

function buildClickhouseConfig(opts: {
  dataDir: string;
  configDir: string;
  httpPort: number;
  nativePort: number;
  logPath: string;
}): string {
  return `<?xml version="1.0"?>
<clickhouse>
  <logger>
    <level>information</level>
    <log>${opts.logPath}</log>
    <errorlog>${join(opts.configDir, "clickhouse-server.err.log")}</errorlog>
    <size>100M</size>
    <count>3</count>
  </logger>
  <http_port>${opts.httpPort}</http_port>
  <tcp_port>${opts.nativePort}</tcp_port>
  <listen_host>127.0.0.1</listen_host>
  <path>${opts.dataDir}/</path>
  <tmp_path>${opts.dataDir}/tmp/</tmp_path>
  <user_files_path>${opts.dataDir}/user_files/</user_files_path>
  <format_schema_path>${opts.dataDir}/format_schemas/</format_schema_path>
  <user_directories>
    <users_xml>
      <path>${join(opts.configDir, "users.xml")}</path>
    </users_xml>
  </user_directories>
  <mlock_executable>false</mlock_executable>
  <mark_cache_size>536870912</mark_cache_size>
</clickhouse>
`;
}

function buildClickhouseUsers(opts: {
  username: string;
  password: string;
}): string {
  const user = opts.username || "default";
  return `<?xml version="1.0"?>
<clickhouse>
  <profiles>
    <default>
      <max_memory_usage>10000000000</max_memory_usage>
      <load_balancing>random</load_balancing>
    </default>
  </profiles>
  <users>
    <${user}>
      <password>${escapeXml(opts.password)}</password>
      <networks>
        <ip>::1</ip>
        <ip>127.0.0.1</ip>
      </networks>
      <profile>default</profile>
      <quota>default</quota>
      <access_management>1</access_management>
    </${user}>
  </users>
  <quotas>
    <default>
      <interval>
        <duration>3600</duration>
        <queries>0</queries>
        <errors>0</errors>
        <result_rows>0</result_rows>
        <read_rows>0</read_rows>
        <execution_time>0</execution_time>
      </interval>
    </default>
  </quotas>
</clickhouse>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clickhouseDownload(
  version: string
): { url: string; label: string; kind: "binary" | "tgz" } {
  const { os, cpu } = detectOsCpu();
  // Official static tarballs are Linux-oriented; macOS uses standalone builds.
  if (os === "darwin" && cpu === "arm64") {
    return {
      label: "macos-aarch64",
      kind: "binary",
      url: "https://builds.clickhouse.com/master/macos-aarch64/clickhouse",
    };
  }
  if (os === "darwin" && cpu === "x64") {
    return {
      label: "macos",
      kind: "binary",
      url: "https://builds.clickhouse.com/master/macos/clickhouse",
    };
  }
  if (os === "linux" && cpu === "x64") {
    return {
      label: "linux-amd64",
      kind: "tgz",
      url: `https://packages.clickhouse.com/tgz/stable/clickhouse-common-static-${version}-amd64.tgz`,
    };
  }
  if (os === "linux" && cpu === "arm64") {
    return {
      label: "linux-arm64",
      kind: "tgz",
      url: `https://packages.clickhouse.com/tgz/stable/clickhouse-common-static-${version}-arm64.tgz`,
    };
  }
  throw new Error("Unsupported platform for ClickHouse");
}

async function ensureClickhouseBinary(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<string> {
  const basedir = join(options.installationDir, options.version);
  const binary = join(basedir, "clickhouse");
  // Wipe bad installs (e.g. earlier bug copied share/clickhouse directory).
  if (existsSync(binary) && !isExecutableFile(binary)) {
    options.onProgress?.(
      `Removing invalid ClickHouse install at ${binary}…`
    );
    rmSync(basedir, { recursive: true, force: true });
  }
  if (existsSync(binary) && isExecutableFile(binary)) {
    return binary;
  }

  const { url, label, kind } = clickhouseDownload(options.version);
  options.onProgress?.(
    `Downloading ClickHouse ${options.version} (${label})…`
  );
  const tmp = makeTempDir("db-here-ch");
  try {
    if (kind === "binary") {
      const dest = join(tmp, "clickhouse");
      await downloadFile(url, dest, options.onProgress);
      chmodX(dest);
      mkdirSync(basedir, { recursive: true });
      safeRename(dest, binary);
    } else {
      const archive = join(tmp, "ch.tgz");
      await downloadFile(url, archive, options.onProgress);
      options.onProgress?.(`Extracting ClickHouse ${options.version}…`);
      await extractTar(archive, tmp);
      // Prefer usr/bin/clickhouse (file). Avoid matching share/clickhouse (dir).
      const found =
        findFirst(
          tmp,
          (name, full) =>
            name === "clickhouse" &&
            full.includes(`${join("bin", "clickhouse")}`) &&
            isRegularFile(full)
        ) ??
        findFirst(
          tmp,
          (name, full) => name === "clickhouse" && isRegularFile(full)
        );
      if (!found) throw new Error("clickhouse binary not found in archive");
      mkdirSync(basedir, { recursive: true });
      safeRename(found, binary);
    }
    chmodX(binary);
    if (!isExecutableFile(binary)) {
      throw new Error(
        `ClickHouse install is not an executable file: ${binary}`
      );
    }
    options.onProgress?.(`ClickHouse ${options.version} ready`);
    return binary;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function startClickhouseHere(
  options: ClickhouseOptions = {}
): Promise<ClickhouseHereHandle> {
  const httpPort = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_CLICKHOUSE_PORT,
    autoPort: options.autoPort,
  });
  const nativePort =
    options.nativePort ??
    (await resolvePort({
      port: undefined,
      defaultPort: httpPort + 1,
      autoPort: true,
    }));

  const version =
    options.clickhouseVersion ??
    options.version ??
    DEFAULT_CLICKHOUSE_VERSION;
  const username = options.username ?? DEFAULT_CLICKHOUSE_USERNAME;
  const password = options.password ?? DEFAULT_CLICKHOUSE_PASSWORD;
  const database = options.database ?? DEFAULT_CLICKHOUSE_DATABASE;
  const projectDir = resolve(options.projectDir ?? process.cwd());

  const instance = new ClickhouseInstance({
    projectDir,
    dataRoot: options.dataRoot,
    dataDir: options.dataDir,
    configDir: options.configDir,
    installationDir: options.installationDir,
    version,
    httpPort,
    nativePort,
    username,
    password,
    onProgress: (m) => console.error(m),
  });

  await instance.start();

  const auth =
    password.length > 0
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : username
        ? `${encodeURIComponent(username)}@`
        : "";
  const connectionString = `http://${auth}127.0.0.1:${httpPort}`;
  const databaseConnectionString = `clickhouse:// ${auth}127.0.0.1:${nativePort}/${database}`.replace(
    ":// ",
    "://"
  );

  const handle = await wrapEngineHandle({
    engine: "clickhouse",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port: httpPort,
    username,
    serverVersion: version,
    common: options,
    stopInstance: (i) => i.stop(),
    cleanupInstance: (i) => i.cleanup(),
  });

  return { ...handle, nativePort };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    // regular file with any execute bit
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function getPreStartClickhouseState(
  projectDir?: string,
  dataRoot?: string
) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "clickhouse",
    dataRoot
  );
  return {
    dataDir: paths.data,
    hasData: existsSync(paths.data) && existsSync(join(paths.data, "store")),
    localDir: paths.displayRoot,
    installedVersion: existsSync(
      join(paths.bin, DEFAULT_CLICKHOUSE_VERSION, "clickhouse")
    )
      ? DEFAULT_CLICKHOUSE_VERSION
      : "",
  };
}
