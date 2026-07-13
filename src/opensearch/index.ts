import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { DbHereHandle, OpensearchOptions } from "../types.js";

export const DEFAULT_OPENSEARCH_PORT = 59200;
/** OpenSearch version used on Linux (official artifacts). */
export const DEFAULT_OPENSEARCH_VERSION = "2.19.1";
/**
 * OpenSearch does not publish macOS bundles. On Darwin we use Elasticsearch
 * 8.17 (bundled JRE, same single-node local-dev shape) and label it clearly.
 */
export const DEFAULT_ELASTICSEARCH_MAC_VERSION = "8.17.0";
export const DEFAULT_OPENSEARCH_DATABASE = "_all";

export interface OpensearchHereHandle extends DbHereHandle {
  engine: "opensearch";
  instance: OpensearchInstance;
}

class OpensearchInstance {
  readonly dataDir: string;
  readonly configDir: string;
  readonly installationDir: string;
  readonly port: number;
  private process: ChildProcess | null = null;
  private homeDir = "";
  private logPath = "";
  private resolvedVersion = "";
  private readonly onProgress?: (m: string) => void;
  private distribution: "opensearch" | "elasticsearch" = "opensearch";

  constructor(opts: {
    projectDir: string;
    dataDir?: string;
    configDir?: string;
    installationDir?: string;
    port: number;
    onProgress?: (m: string) => void;
  }) {
    const paths = getEnginePaths(opts.projectDir, "opensearch");
    this.dataDir = resolve(opts.dataDir ?? paths.data);
    this.configDir = resolve(opts.configDir ?? paths.config);
    this.installationDir = resolve(opts.installationDir ?? paths.bin);
    this.port = opts.port;
    this.onProgress = opts.onProgress;
    this.logPath = join(this.configDir, "opensearch.log");
  }

  getDistribution(): "opensearch" | "elasticsearch" {
    return this.distribution;
  }

  getVersion(): string {
    return this.resolvedVersion;
  }

  async start(): Promise<void> {
    const ensured = await ensureSearchBinary({
      installationDir: this.installationDir,
      onProgress: this.onProgress,
    });
    this.homeDir = ensured.homeDir;
    this.distribution = ensured.distribution;
    this.resolvedVersion = ensured.version;

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    const binName =
      this.distribution === "opensearch" ? "opensearch" : "elasticsearch";
    const binPath = join(this.homeDir, "bin", binName);
    chmodX(binPath);

    // Disable security plugins for zero-config local use.
    if (this.distribution === "opensearch") {
      writeFileSync(
        join(this.homeDir, "config", "opensearch.yml"),
        [
          `cluster.name: db-here-opensearch`,
          `node.name: db-here-node`,
          `path.data: ${this.dataDir}`,
          `path.logs: ${this.configDir}`,
          `network.host: 127.0.0.1`,
          `http.port: ${this.port}`,
          `discovery.type: single-node`,
          `plugins.security.disabled: true`,
          `bootstrap.memory_lock: false`,
          "",
        ].join("\n"),
        "utf8"
      );
    } else {
      writeFileSync(
        join(this.homeDir, "config", "elasticsearch.yml"),
        [
          `cluster.name: db-here-opensearch`,
          `node.name: db-here-node`,
          `path.data: ${this.dataDir}`,
          `path.logs: ${this.configDir}`,
          `network.host: 127.0.0.1`,
          `http.port: ${this.port}`,
          `discovery.type: single-node`,
          `xpack.security.enabled: false`,
          `xpack.security.http.ssl.enabled: false`,
          `xpack.security.transport.ssl.enabled: false`,
          "",
        ].join("\n"),
        "utf8"
      );
    }

    this.process = spawnDetached(binPath, [], {
      env: {
        ...process.env,
        OPENSEARCH_JAVA_OPTS: process.env.OPENSEARCH_JAVA_OPTS ?? "-Xms512m -Xmx512m",
        ES_JAVA_OPTS: process.env.ES_JAVA_OPTS ?? "-Xms512m -Xmx512m",
        OPENSEARCH_HOME: this.homeDir,
        ES_HOME: this.homeDir,
      },
      cwd: this.homeDir,
    });

    this.process.on("exit", () => {
      this.process = null;
    });

    try {
      await waitForTcp(this.port, "127.0.0.1", 180_000);
    } catch (error) {
      throw new Error(
        `OpenSearch failed to start.\n${readLogTail(this.logPath)}\n${error}`
      );
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 30_000);
      this.process = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

async function ensureSearchBinary(options: {
  installationDir: string;
  onProgress?: (m: string) => void;
}): Promise<{
  homeDir: string;
  version: string;
  distribution: "opensearch" | "elasticsearch";
}> {
  const { os, cpu } = detectOsCpu();

  if (os === "linux") {
    const version = DEFAULT_OPENSEARCH_VERSION;
    const arch = cpu === "arm64" ? "linux-arm64" : "linux-x64";
    const homeDir = join(options.installationDir, `opensearch-${version}`);
    const binPath = join(homeDir, "bin", "opensearch");
    if (existsSync(binPath)) {
      return { homeDir, version, distribution: "opensearch" };
    }

    const url = `https://artifacts.opensearch.org/releases/bundle/opensearch/${version}/opensearch-${version}-${arch}.tar.gz`;
    options.onProgress?.(
      `Downloading OpenSearch ${version} (${arch})…`
    );
    const tmp = makeTempDir("db-here-os");
    try {
      const archive = join(tmp, "os.tgz");
      await downloadFile(url, archive, options.onProgress);
      options.onProgress?.(`Extracting OpenSearch ${version}…`);
      await extractTar(archive, tmp);
      const found = findFirst(
        tmp,
        (name, full) => name === "opensearch" && full.includes("/bin/")
      );
      if (!found) throw new Error("opensearch binary not found");
      const root = resolve(found, "..", "..");
      safeRename(root, homeDir);
      options.onProgress?.(`OpenSearch ${version} ready`);
      return { homeDir, version, distribution: "opensearch" };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // macOS: OpenSearch has no official macOS bundles → Elasticsearch with security off.
  const version = DEFAULT_ELASTICSEARCH_MAC_VERSION;
  const arch = cpu === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  const homeDir = join(options.installationDir, `elasticsearch-${version}`);
  const binPath = join(homeDir, "bin", "elasticsearch");
  if (existsSync(binPath)) {
    options.onProgress?.(
      `Using Elasticsearch ${version} on macOS (OpenSearch has no macOS builds)`
    );
    return { homeDir, version, distribution: "elasticsearch" };
  }

  const url = `https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-${version}-${arch}.tar.gz`;
  options.onProgress?.(
    `Downloading Elasticsearch ${version} for macOS (${arch}) — OpenSearch has no official macOS binaries…`
  );
  const tmp = makeTempDir("db-here-es");
  try {
    const archive = join(tmp, "es.tgz");
    await downloadFile(url, archive, options.onProgress);
    options.onProgress?.(`Extracting Elasticsearch ${version}…`);
    await extractTar(archive, tmp);
    const found = findFirst(
      tmp,
      (name, full) => name === "elasticsearch" && full.includes("/bin/")
    );
    if (!found) throw new Error("elasticsearch binary not found");
    const root = resolve(found, "..", "..");
    safeRename(root, homeDir);
    options.onProgress?.(
      `Elasticsearch ${version} ready (local OpenSearch-compatible API on macOS)`
    );
    return { homeDir, version, distribution: "elasticsearch" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function startOpensearchHere(
  options: OpensearchOptions = {}
): Promise<OpensearchHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_OPENSEARCH_PORT,
    autoPort: options.autoPort,
  });
  const database = options.database ?? DEFAULT_OPENSEARCH_DATABASE;
  const projectDir = resolve(options.projectDir ?? process.cwd());

  const instance = new OpensearchInstance({
    projectDir,
    dataDir: options.dataDir,
    configDir: options.configDir,
    installationDir: options.installationDir,
    port,
    onProgress: (m) => console.error(m),
  });

  await instance.start();

  const connectionString = `http://127.0.0.1:${port}`;
  const databaseConnectionString =
    database === "_all"
      ? connectionString
      : `http://127.0.0.1:${port}/${database}`;

  const dist = instance.getDistribution();
  const serverVersion =
    dist === "opensearch"
      ? instance.getVersion()
      : `${instance.getVersion()} (elasticsearch-on-macos)`;

  return wrapEngineHandle({
    engine: "opensearch",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username: options.username ?? "",
    serverVersion,
    common: options,
    stopInstance: (i) => i.stop(),
    cleanupInstance: (i) => i.cleanup(),
  });
}

export function getPreStartOpensearchState(projectDir?: string) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "opensearch"
  );
  return {
    dataDir: paths.data,
    hasData: existsSync(paths.data),
    localDir: paths.displayRoot,
    installedVersion: "",
  };
}
