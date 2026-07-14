import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { getEnginePaths } from "../paths.js";
import {
  DEFAULT_REDIS_VERSION,
  ensureRedisBinary,
  type RedisBinaryInfo,
} from "./binary.js";

const DEFAULT_PORT = 56379;
const DEFAULT_PASSWORD = "";
const DEFAULT_DATABASE = "0";

export interface RedisInstanceOptions {
  projectDir?: string;
  dataRoot?: string;
  dataDir?: string;
  installationDir?: string;
  confDir?: string;
  version?: string;
  port?: number;
  password?: string;
  /** Logical Redis DB index (0–15 by default). */
  database?: string | number;
  onBinaryProgress?: (message: string) => void;
}

export interface RedisConnectionInfo {
  host: string;
  port: number;
  password: string;
  database: string;
  connectionString: string;
}

export class RedisInstance {
  readonly dataDir: string;
  readonly installationDir: string;
  readonly confDir: string;
  readonly version: string;
  readonly port: number;
  readonly password: string;
  readonly database: string;

  private binary: RedisBinaryInfo | null = null;
  private process: ChildProcess | null = null;
  private started = false;
  private readonly projectDir: string;
  private readonly onBinaryProgress?: (message: string) => void;
  private confPath = "";

  constructor(options: RedisInstanceOptions = {}) {
    this.projectDir = resolve(options.projectDir ?? process.cwd());
    const paths = getEnginePaths(this.projectDir, "redis", options.dataRoot);
    this.dataDir = resolve(options.dataDir ?? paths.data);
    this.installationDir = resolve(options.installationDir ?? paths.bin);
    this.confDir = resolve(options.confDir ?? paths.config);
    this.version = options.version ?? DEFAULT_REDIS_VERSION;
    this.port = options.port ?? DEFAULT_PORT;
    this.password = options.password ?? DEFAULT_PASSWORD;
    this.database = String(options.database ?? DEFAULT_DATABASE);
    this.onBinaryProgress = options.onBinaryProgress;

    if (!/^\d+$/.test(this.database)) {
      throw new Error(
        `Invalid Redis database "${this.database}". Use a numeric logical DB index (e.g. 0).`
      );
    }
  }

  get connectionInfo(): RedisConnectionInfo {
    return {
      host: "127.0.0.1",
      port: this.port,
      password: this.password,
      database: this.database,
      connectionString: buildRedisUrl({
        host: "127.0.0.1",
        port: this.port,
        password: this.password,
        database: this.database,
      }),
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.binary = await ensureRedisBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onBinaryProgress,
    });

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.confDir, { recursive: true });

    this.confPath = join(this.confDir, "redis.conf");
    writeFileSync(this.confPath, this.buildConfig(), "utf8");

    await this.spawnServer();
    await this.waitUntilReady();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.process && !this.started) {
      return;
    }

    try {
      if (this.binary) {
        // Default SHUTDOWN flushes AOF/RDB so data under <dataRoot>/redis/data survives.
        await this.runCli(["SHUTDOWN"]).catch(() => {
          this.process?.kill("SIGTERM");
        });
      } else {
        this.process?.kill("SIGTERM");
      }
      await waitForExit(this.process, 10_000);
    } finally {
      this.process = null;
      this.started = false;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
    // Keep config/ and bin/ — only wipe database files.
  }

  getRedisVersion(): string {
    return this.binary?.version ?? this.version;
  }

  private buildConfig(): string {
    const pidFile = join(this.confDir, "redis.pid");
    const logFile = join(this.confDir, "redis.log");
    const lines = [
      `bind 127.0.0.1 -::1`,
      `port ${this.port}`,
      `protected-mode yes`,
      `daemonize no`,
      `dir ${this.dataDir}`,
      `pidfile ${pidFile}`,
      `logfile ${logFile}`,
      `dbfilename dump.rdb`,
      `appendonly yes`,
      `appendfilename "appendonly.aof"`,
      `appenddirname "appendonlydir"`,
      // Keep process in the foreground; db-here owns the lifecycle.
      `supervised no`,
      `tcp-backlog 511`,
      `timeout 0`,
      `tcp-keepalive 300`,
    ];

    if (this.password) {
      lines.push(`requirepass ${escapeRedisConf(this.password)}`);
    }

    lines.push("");
    return lines.join("\n");
  }

  private async spawnServer(): Promise<void> {
    if (!this.binary) {
      throw new Error("Redis binary not loaded");
    }

    this.process = spawn(
      this.binary.redisServerPath,
      [this.confPath],
      {
        env: redisProcessEnv(this.binary),
        stdio: ["ignore", "ignore", "ignore"],
        detached: false,
      }
    );

    this.process.on("exit", () => {
      this.started = false;
      this.process = null;
    });
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const startedAt = Date.now();
    let lastError = "";

    while (Date.now() - startedAt < timeoutMs) {
      if (this.process && this.process.exitCode !== null) {
        throw new Error(
          `redis-server exited early with code ${this.process.exitCode}\n${readLog(this.confDir)}`
        );
      }

      try {
        const pong = await this.runCli(["PING"]);
        if (pong.trim() === "PONG") {
          return;
        }
        lastError = pong;
      } catch (error) {
        lastError = String(error);
      }

      // Also try a raw TCP connect as a fallback signal.
      const open = await isPortOpen(this.port);
      if (!open) {
        await sleep(100);
        continue;
      }

      await sleep(100);
    }

    throw new Error(
      `Redis did not become ready within ${timeoutMs}ms.\n${lastError}\n${readLog(this.confDir)}`
    );
  }

  private runCli(args: string[]): Promise<string> {
    if (!this.binary) {
      return Promise.reject(new Error("Redis binary not loaded"));
    }

    const fullArgs = ["-h", "127.0.0.1", "-p", String(this.port)];
    if (this.password) {
      fullArgs.push("-a", this.password, "--no-auth-warning");
    }
    fullArgs.push(...args);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary!.redisCliPath, fullArgs, {
        env: redisProcessEnv(this.binary!),
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
          resolvePromise(stdout);
          return;
        }
        reject(
          new Error(
            `redis-cli failed (${code}): ${args.join(" ")}\n${stderr || stdout}`
          )
        );
      });
    });
  }
}

function redisProcessEnv(binary: RedisBinaryInfo): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (binary.platform.os === "linux") {
    const current = env.LD_LIBRARY_PATH ?? "";
    env.LD_LIBRARY_PATH = current
      ? `${binary.libDir}:${current}`
      : binary.libDir;
  }
  // macOS uses @rpath/@loader_path from the conda build — libs sit in basedir/lib.
  return env;
}

export function buildRedisUrl(parts: {
  host: string;
  port: number;
  password: string;
  database: string;
}): string {
  if (parts.password) {
    return `redis://:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${parts.database}`;
  }
  return `redis://${parts.host}:${parts.port}/${parts.database}`;
}

function escapeRedisConf(value: string): string {
  // Quote if it contains spaces or special conf characters.
  if (/[\s#"]/.test(value)) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return value;
}

function readLog(configDir: string): string {
  const path = join(configDir, "redis.log");
  if (!existsSync(path)) {
    return "(no redis log)";
  }
  try {
    return readFileSync(path, "utf8").slice(-4000);
  } catch {
    return "(could not read redis log)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(
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

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

export {
  DEFAULT_PORT as DEFAULT_REDIS_PORT,
  DEFAULT_PASSWORD as DEFAULT_REDIS_PASSWORD,
  DEFAULT_DATABASE as DEFAULT_REDIS_DATABASE,
};
