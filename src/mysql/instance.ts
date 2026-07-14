import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "mysql2/promise";
import { getEnginePaths } from "../paths.js";
import {
  DEFAULT_MYSQL_VERSION,
  ensureMysqlBinary,
  type MysqlBinaryInfo,
} from "./binary.js";

const DEFAULT_USERNAME = "root";
const DEFAULT_PASSWORD = "root";
const DEFAULT_PORT = 33306;
const DEFAULT_DATABASE = "mysql";

export interface MysqlInstanceOptions {
  projectDir?: string;
  dataRoot?: string;
  dataDir?: string;
  installationDir?: string;
  configDir?: string;
  version?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  socketPath?: string;
  onBinaryProgress?: (message: string) => void;
}

export interface MysqlConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  socketPath: string;
  connectionString: string;
}

export class MysqlInstance {
  readonly dataDir: string;
  readonly installationDir: string;
  readonly configDir: string;
  readonly version: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly socketPath: string;

  private binary: MysqlBinaryInfo | null = null;
  private process: ChildProcess | null = null;
  private started = false;
  private readonly projectDir: string;
  private readonly onBinaryProgress?: (message: string) => void;

  constructor(options: MysqlInstanceOptions = {}) {
    this.projectDir = resolve(options.projectDir ?? process.cwd());
    const paths = getEnginePaths(this.projectDir, "mysql", options.dataRoot);
    this.dataDir = resolve(options.dataDir ?? paths.data);
    this.installationDir = resolve(options.installationDir ?? paths.bin);
    this.configDir = resolve(options.configDir ?? paths.config);
    this.version = options.version ?? DEFAULT_MYSQL_VERSION;
    this.port = options.port ?? DEFAULT_PORT;
    this.username = options.username ?? DEFAULT_USERNAME;
    this.password = options.password ?? DEFAULT_PASSWORD;
    this.socketPath =
      options.socketPath ?? join(this.configDir, "mysql.sock");
    this.onBinaryProgress = options.onBinaryProgress;

    assertSafeMysqlName(this.username, "username");
  }

  get connectionInfo(): MysqlConnectionInfo {
    const database = DEFAULT_DATABASE;
    return {
      host: "127.0.0.1",
      port: this.port,
      user: this.username,
      password: this.password,
      database,
      socketPath: this.socketPath,
      connectionString: buildMysqlUrl({
        user: this.username,
        password: this.password,
        host: "127.0.0.1",
        port: this.port,
        database,
      }),
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.binary = await ensureMysqlBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onBinaryProgress,
    });

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    if (!isMysqlDataDirInitialized(this.dataDir)) {
      await this.initializeDataDir();
    }

    await this.spawnServer();
    await this.waitUntilReady();
    await this.ensureAuthAndDefaults();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.process && !this.started) {
      return;
    }

    try {
      if (this.binary && existsSync(this.socketPath)) {
        await runMysqlAdmin(this.binary, this.socketPath, ["shutdown"]).catch(
          () => {
            this.process?.kill("SIGTERM");
          }
        );
      } else {
        this.process?.kill("SIGTERM");
      }

      await waitForExit(this.process, 15_000);
    } finally {
      this.process = null;
      this.started = false;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.configDir, { recursive: true, force: true });
  }

  async databaseExists(databaseName: string): Promise<boolean> {
    const rows = await this.queryAdmin<{ name: string }>(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [databaseName]
    );
    return rows.length > 0;
  }

  async createDatabase(databaseName: string): Promise<void> {
    assertSafeMysqlName(databaseName, "database");
    const safe = quoteIdent(databaseName);
    await this.queryAdmin(`CREATE DATABASE IF NOT EXISTS ${safe}`);
  }

  getMysqlVersion(): string {
    return this.binary?.version ?? this.version;
  }

  private async initializeDataDir(): Promise<void> {
    if (!this.binary) {
      throw new Error("MySQL binary not loaded");
    }

    // --initialize-insecure creates root@localhost with empty password.
    // We set the real password after the first start.
    await runProcess(this.binary.mysqldPath, [
      "--initialize-insecure",
      `--basedir=${this.binary.basedir}`,
      `--datadir=${this.dataDir}`,
      `--lc-messages-dir=${join(this.binary.basedir, "share")}`,
    ], {
      env: mysqlProcessEnv(this.binary),
    });

    writeFileSync(
      join(this.dataDir, ".db-here-initialized"),
      `${this.version}\n`,
      "utf8"
    );
  }

  private async spawnServer(): Promise<void> {
    if (!this.binary) {
      throw new Error("MySQL binary not loaded");
    }

    const errorLog = join(this.configDir, "error.log");
    const pidFile = join(this.configDir, "mysqld.pid");
    const defaultsFile = join(this.configDir, "my.cnf");

    writeFileSync(
      defaultsFile,
      [
        "[mysqld]",
        `basedir=${this.binary.basedir}`,
        `datadir=${this.dataDir}`,
        `socket=${this.socketPath}`,
        `port=${this.port}`,
        "bind-address=127.0.0.1",
        "mysqlx=0",
        `pid-file=${pidFile}`,
        `log-error=${errorLog}`,
        `lc-messages-dir=${join(this.binary.basedir, "share")}`,
        // Keep everything project-local; no system paths.
        "skip-grant-tables=0",
        "",
      ].join("\n"),
      "utf8"
    );

    this.process = spawn(
      this.binary.mysqldPath,
      [`--defaults-file=${defaultsFile}`],
      {
        env: mysqlProcessEnv(this.binary),
        stdio: ["ignore", "ignore", "ignore"],
        detached: false,
      }
    );

    this.process.on("exit", () => {
      this.started = false;
      this.process = null;
    });
  }

  private async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    if (!this.binary) {
      throw new Error("MySQL binary not loaded");
    }

    const startedAt = Date.now();
    let lastError = "";

    while (Date.now() - startedAt < timeoutMs) {
      if (this.process && this.process.exitCode !== null) {
        throw new Error(
          `mysqld exited early with code ${this.process.exitCode}\n${readErrorLog(this.configDir)}`
        );
      }

      try {
        // During first boot root may still have empty password until we set it.
        await runMysqlAdmin(this.binary, this.socketPath, ["ping"], {
          user: "root",
          password: "",
        });
        return;
      } catch (error) {
        lastError = String(error);
      }

      try {
        await runMysqlAdmin(this.binary, this.socketPath, ["ping"], {
          user: this.username,
          password: this.password,
        });
        return;
      } catch (error) {
        lastError = String(error);
      }

      await sleep(200);
    }

    throw new Error(
      `MySQL did not become ready within ${timeoutMs}ms.\n${lastError}\n${readErrorLog(this.configDir)}`
    );
  }

  private async ensureAuthAndDefaults(): Promise<void> {
    // Connect as root with empty password (fresh init) or configured password (reuse).
    let conn;
    try {
      conn = await createConnection({
        socketPath: this.socketPath,
        user: "root",
        password: "",
        multipleStatements: true,
      });
    } catch {
      conn = await createConnection({
        socketPath: this.socketPath,
        user: this.username === "root" ? "root" : this.username,
        password: this.password,
        multipleStatements: true,
      });
    }

    try {
      // Set/update root password for local socket + TCP.
      await conn.query(
        `ALTER USER 'root'@'localhost' IDENTIFIED BY ?`,
        [this.password]
      );

      // Ensure root can also connect via 127.0.0.1 (TCP).
      await conn.query(
        `CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY ?`,
        [this.password]
      );
      await conn.query(
        `ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY ?`,
        [this.password]
      );
      await conn.query(`GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION`);

      if (this.username !== "root") {
        const user = quoteIdent(this.username);
        // Account names can't be bound as query params; password can.
        await conn.query(
          `CREATE USER IF NOT EXISTS ${user}@'localhost' IDENTIFIED BY ?`,
          [this.password]
        );
        await conn.query(
          `CREATE USER IF NOT EXISTS ${user}@'127.0.0.1' IDENTIFIED BY ?`,
          [this.password]
        );
        await conn.query(
          `ALTER USER ${user}@'localhost' IDENTIFIED BY ?`,
          [this.password]
        );
        await conn.query(
          `ALTER USER ${user}@'127.0.0.1' IDENTIFIED BY ?`,
          [this.password]
        );
        await conn.query(
          `GRANT ALL PRIVILEGES ON *.* TO ${user}@'localhost' WITH GRANT OPTION`
        );
        await conn.query(
          `GRANT ALL PRIVILEGES ON *.* TO ${user}@'127.0.0.1' WITH GRANT OPTION`
        );
      }

      await conn.query("FLUSH PRIVILEGES");
    } finally {
      await conn.end().catch(() => {});
    }
  }

  private async queryAdmin<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const conn = await createConnection({
      socketPath: this.socketPath,
      user: this.username,
      password: this.password,
    });
    try {
      const [rows] = await conn.query(sql, params);
      return rows as T[];
    } finally {
      await conn.end().catch(() => {});
    }
  }
}

function isMysqlDataDirInitialized(dataDir: string): boolean {
  return (
    existsSync(join(dataDir, "mysql")) ||
    existsSync(join(dataDir, ".db-here-initialized")) ||
    existsSync(join(dataDir, "ibdata1"))
  );
}

function mysqlProcessEnv(binary: MysqlBinaryInfo): NodeJS.ProcessEnv {
  const libDir = join(binary.basedir, "lib");
  const env = { ...process.env };

  // Prefer bundled libs over anything on the system.
  if (binary.platform.os === "linux") {
    const current = env.LD_LIBRARY_PATH ?? "";
    env.LD_LIBRARY_PATH = current
      ? `${libDir}:${current}`
      : libDir;
  }

  return env;
}

function buildMysqlUrl(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  return `mysql://${user}:${password}@${parts.host}:${parts.port}/${parts.database}`;
}

function quoteIdent(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

/** Keep identifiers boring so we never interpolate shell/SQL metacharacters. */
function assertSafeMysqlName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(
      `Invalid MySQL ${label} "${value}". Use only letters, numbers, and underscores.`
    );
  }
}

function readErrorLog(configDir: string): string {
  const path = join(configDir, "error.log");
  if (!existsSync(path)) {
    return "(no error log)";
  }
  try {
    const content = readFileSync(path, "utf8");
    return content.slice(-4000);
  } catch {
    return "(could not read error log)";
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

function runProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
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

async function runMysqlAdmin(
  binary: MysqlBinaryInfo,
  socketPath: string,
  args: string[],
  auth: { user: string; password: string } = { user: "root", password: "" }
): Promise<void> {
  const fullArgs = [
    `--socket=${socketPath}`,
    `-u${auth.user}`,
    ...(auth.password ? [`-p${auth.password}`] : []),
    ...args,
  ];
  await runProcess(binary.mysqladminPath, fullArgs, {
    env: mysqlProcessEnv(binary),
  });
}

export { DEFAULT_PORT as DEFAULT_MYSQL_PORT, DEFAULT_USERNAME as DEFAULT_MYSQL_USERNAME, DEFAULT_PASSWORD as DEFAULT_MYSQL_PASSWORD, DEFAULT_DATABASE as DEFAULT_MYSQL_DATABASE, buildMysqlUrl };
