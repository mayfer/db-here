import { resolve } from "node:path";
import { PostgresInstance } from "pg-embedded";
import { Client } from "pg";
import { getEnginePaths } from "./paths.js";
import { resolvePort } from "./ports.js";
import {
  DEFAULT_PG_SERVER_VERSION,
  ensurePostgresServerBinary,
} from "./postgres-binary.js";
import {
  DEFAULT_SHUTDOWN_SIGNALS,
  registerShutdownHandlers,
  type ShutdownSignal,
} from "./shutdown.js";
import type { DbHereHandle, PostgresOptions, StopOptions } from "./types.js";

const DEFAULT_USERNAME = "postgres";
const DEFAULT_PASSWORD = "postgres";
const DEFAULT_PORT = 55432;
const DEFAULT_DATABASE = "postgres";
const PG_STAT_STATEMENTS_EXTENSION = "pg_stat_statements";

export {
  DEFAULT_PORT as DEFAULT_PG_PORT,
  DEFAULT_USERNAME as DEFAULT_PG_USERNAME,
  DEFAULT_PASSWORD as DEFAULT_PG_PASSWORD,
  DEFAULT_DATABASE as DEFAULT_PG_DATABASE,
  DEFAULT_PG_SERVER_VERSION,
};

export interface PgHereHandle extends DbHereHandle {
  engine: "postgres";
  instance: PostgresInstance;
}

export function createPgHereInstance(
  options: PostgresOptions & { version?: string } = {}
): PostgresInstance {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const paths = getEnginePaths(projectDir, "postgres");
  const dataDir = resolve(options.dataDir ?? paths.data);
  const installationDir = resolve(options.installationDir ?? paths.bin);
  const postgresVersion =
    options.postgresVersion ??
    options.version ??
    DEFAULT_PG_SERVER_VERSION;

  return new PostgresInstance({
    // Pin exact version so pg-embedded does not re-download a different arch.
    version: postgresVersion,
    dataDir,
    installationDir,
    port: options.port ?? DEFAULT_PORT,
    username: options.username ?? DEFAULT_USERNAME,
    password: options.password ?? DEFAULT_PASSWORD,
    persistent: options.persistent ?? true,
  });
}

export async function ensurePgHereDatabase(
  instance: PostgresInstance,
  databaseName: string
): Promise<boolean> {
  if (!databaseName || databaseName === DEFAULT_DATABASE) {
    return false;
  }

  const exists = await instance.databaseExists(databaseName);
  if (exists) {
    return false;
  }

  await instance.createDatabase(databaseName);
  return true;
}

export async function stopPgHere(
  instance: PostgresInstance,
  options: StopOptions = {}
): Promise<void> {
  try {
    await instance.stop();
  } catch {
    // no-op
  }

  if (options.cleanup) {
    try {
      await instance.cleanup();
    } catch {
      // no-op
    }
  }
}

export async function startPgHere(
  options: PostgresOptions = {}
): Promise<PgHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_PORT,
    autoPort: options.autoPort,
  });

  const projectDir = resolve(options.projectDir ?? process.cwd());
  const paths = getEnginePaths(projectDir, "postgres");
  const installationDir = resolve(options.installationDir ?? paths.bin);
  const version =
    options.postgresVersion ?? options.version ?? DEFAULT_PG_SERVER_VERSION;

  // Install the correct host-arch server ourselves (theseus-rs binaries).
  // pg-embedded has been observed to place x86_64 builds on linux/arm64.
  const ensured = await ensurePostgresServerBinary({
    installationDir,
    version,
    onProgress: (m) => console.error(m),
  });

  const startWithPinned = async () => {
    const instance = createPgHereInstance({
      ...options,
      port,
      installationDir,
      version: ensured.version,
      postgresVersion: ensured.version,
    });
    await instance.start();
    return instance;
  };

  let instance: PostgresInstance;
  try {
    instance = await startWithPinned();
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    // If pg-embedded still mangled the install, re-download host-arch and retry once.
    if (
      message.includes("Exec format error") ||
      message.includes("os error 8")
    ) {
      await ensurePostgresServerBinary({
        installationDir,
        version: ensured.version,
        onProgress: (m) => console.error(m),
      });
      // Force wipe+redownload path inside ensure by removing version dir if still wrong
      instance = await startWithPinned();
    } else {
      throw error;
    }
  }

  const database = options.database ?? DEFAULT_DATABASE;
  const shouldCreate =
    options.createDatabaseIfMissing ?? database !== DEFAULT_DATABASE;

  if (shouldCreate) {
    await ensurePgHereDatabase(instance, database);
  }

  if (options.enablePgStatStatements ?? true) {
    await ensurePgStatStatements(instance, database);
  }

  const defaultCleanupOnShutdown = options.cleanupOnShutdown ?? false;
  const connectionString = instance.connectionInfo.connectionString;
  const databaseConnectionString = setConnectionDatabase(
    connectionString,
    database
  );
  let removeShutdownHooks = () => {};

  const stopHandle = async (stopOptions: StopOptions = {}) => {
    removeShutdownHooks();
    const cleanup = stopOptions.cleanup ?? defaultCleanupOnShutdown;
    await stopPgHere(instance, { cleanup });
  };

  if (options.registerProcessShutdownHandlers ?? true) {
    removeShutdownHooks = registerShutdownHandlers({
      stop: async () => stopHandle({ cleanup: defaultCleanupOnShutdown }),
      signals: options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS,
    });
  }

  let serverVersion: string | undefined;
  try {
    if (typeof instance.getPostgreSqlVersion === "function") {
      serverVersion = instance.getPostgreSqlVersion();
    }
  } catch {
    serverVersion = undefined;
  }
  serverVersion = serverVersion ?? ensured.version;

  return {
    engine: "postgres",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username: options.username ?? DEFAULT_USERNAME,
    serverVersion,
    stop: stopHandle,
    cleanup: async () => stopHandle({ cleanup: true }),
    ensureDatabase: async (databaseName = database) =>
      ensurePgHereDatabase(instance, databaseName),
    removeShutdownHooks,
  };
}

function setConnectionDatabase(
  connectionString: string,
  database: string
): string {
  const connectionUrl = new URL(connectionString);
  connectionUrl.pathname = `/${database}`;
  return connectionUrl.toString();
}

async function ensurePgStatStatements(
  instance: PostgresInstance,
  database: string
): Promise<void> {
  await ensureSharedPreloadLibrary(instance, PG_STAT_STATEMENTS_EXTENSION);
  await ensureExtension(instance, database, PG_STAT_STATEMENTS_EXTENSION);
}

async function ensureSharedPreloadLibrary(
  instance: PostgresInstance,
  libraryName: string
): Promise<boolean> {
  const adminConnection = setConnectionDatabase(
    instance.connectionInfo.connectionString,
    DEFAULT_DATABASE
  );
  const client = new Client({ connectionString: adminConnection });

  try {
    await client.connect();
    const result = await client.query("show shared_preload_libraries");
    const rawLibraries = String(
      result.rows[0]?.shared_preload_libraries ?? ""
    );
    const libraries = parsePreloadLibraries(rawLibraries);

    if (libraries.includes(libraryName)) {
      return false;
    }

    const nextLibraries = [...libraries, libraryName];
    const librariesValue = escapeSqlLiteral(nextLibraries.join(","));
    await client.query(
      `ALTER SYSTEM SET shared_preload_libraries = '${librariesValue}'`
    );
  } finally {
    await client.end().catch(() => {});
  }

  await instance.stop().catch(() => {});
  await instance.start();
  return true;
}

async function ensureExtension(
  instance: PostgresInstance,
  database: string,
  extensionName: string
): Promise<void> {
  const connectionString = setConnectionDatabase(
    instance.connectionInfo.connectionString,
    database
  );
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query(
      `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extensionName)}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function parsePreloadLibraries(value: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((library) => library.trim())
    .filter(Boolean);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export type { ShutdownSignal };
