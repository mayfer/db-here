import type { ShutdownSignal } from "./shutdown.js";

export type DbEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mongodb"
  | "minio"
  | "clickhouse"
  | "opensearch"
  | "memcached";

export interface StopOptions {
  cleanup?: boolean;
}

export interface CommonDbOptions {
  /**
   * Project working directory (default: `process.cwd()`).
   * Used as the base for relative `dataRoot` and default paths.
   */
  projectDir?: string;
  /**
   * Parent folder for engine state (`<dataRoot>/<engine>/{data,config,bin}`).
   * Relative paths resolve under `projectDir`. Default: `db-here-data`.
   * CLI: `--data-root`.
   */
  dataRoot?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  createDatabaseIfMissing?: boolean;
  registerProcessShutdownHandlers?: boolean;
  shutdownSignals?: ShutdownSignal[];
  cleanupOnShutdown?: boolean;
  autoPort?: boolean;
  version?: string;
  /** Override engine data directory (default: `<dataRoot>/<engine>/data`). */
  dataDir?: string;
  /** Override binary install directory (default: `<dataRoot>/<engine>/bin`). */
  installationDir?: string;
  /** Override config directory (default: `<dataRoot>/<engine>/config`). */
  configDir?: string;
}

export interface DbHereHandle {
  engine: DbEngine;
  connectionString: string;
  databaseConnectionString: string;
  database: string;
  port: number;
  username: string;
  /** Running server version string when known. */
  serverVersion?: string;
  stop: (options?: StopOptions) => Promise<void>;
  cleanup: () => Promise<void>;
  ensureDatabase: (databaseName?: string) => Promise<boolean>;
  removeShutdownHooks: () => void;
}

export interface PostgresOptions extends CommonDbOptions {
  /** Set when calling `startDbHere`; optional for `startPgHere`. */
  engine?: "postgres";
  postgresVersion?: string;
  persistent?: boolean;
  enablePgStatStatements?: boolean;
}

export interface MysqlOptions extends CommonDbOptions {
  engine?: "mysql";
  mysqlVersion?: string;
  socketPath?: string;
}

export interface RedisOptions extends CommonDbOptions {
  engine?: "redis";
  confDir?: string;
  redisVersion?: string;
}

export interface MongodbOptions extends CommonDbOptions {
  engine?: "mongodb";
  mongodbVersion?: string;
}

export interface MinioOptions extends CommonDbOptions {
  engine?: "minio";
  /** Console UI port (default: API port + 1). */
  consolePort?: number;
  minioVersion?: string;
}

export interface ClickhouseOptions extends CommonDbOptions {
  engine?: "clickhouse";
  /** Native TCP port (default: HTTP port + 1). */
  nativePort?: number;
  clickhouseVersion?: string;
}

export interface OpensearchOptions extends CommonDbOptions {
  engine?: "opensearch";
  opensearchVersion?: string;
}

export interface MemcachedOptions extends CommonDbOptions {
  engine?: "memcached";
  memcachedVersion?: string;
  /** Memory limit in MB (default 64). */
  memoryMb?: number;
}

/** Options for `startDbHere` — `engine` is always required (no default). */
export type DbHereOptions =
  | (PostgresOptions & { engine: "postgres" })
  | (MysqlOptions & { engine: "mysql" })
  | (RedisOptions & { engine: "redis" })
  | (MongodbOptions & { engine: "mongodb" })
  | (MinioOptions & { engine: "minio" })
  | (ClickhouseOptions & { engine: "clickhouse" })
  | (OpensearchOptions & { engine: "opensearch" })
  | (MemcachedOptions & { engine: "memcached" });
