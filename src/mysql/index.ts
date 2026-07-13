import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import {
  DEFAULT_SHUTDOWN_SIGNALS,
  registerShutdownHandlers,
} from "../shutdown.js";
import type { DbHereHandle, MysqlOptions, StopOptions } from "../types.js";
import { DEFAULT_MYSQL_VERSION, getInstalledMysqlVersions } from "./binary.js";
import {
  buildMysqlUrl,
  DEFAULT_MYSQL_DATABASE,
  DEFAULT_MYSQL_PASSWORD,
  DEFAULT_MYSQL_PORT,
  DEFAULT_MYSQL_USERNAME,
  MysqlInstance,
} from "./instance.js";

export {
  DEFAULT_MYSQL_DATABASE,
  DEFAULT_MYSQL_PASSWORD,
  DEFAULT_MYSQL_PORT,
  DEFAULT_MYSQL_USERNAME,
  DEFAULT_MYSQL_VERSION,
  MysqlInstance,
  getInstalledMysqlVersions,
};

export interface MysqlHereHandle extends DbHereHandle {
  engine: "mysql";
  instance: MysqlInstance;
}

export async function ensureMysqlHereDatabase(
  instance: MysqlInstance,
  databaseName: string
): Promise<boolean> {
  if (!databaseName || databaseName === DEFAULT_MYSQL_DATABASE) {
    return false;
  }

  const exists = await instance.databaseExists(databaseName);
  if (exists) {
    return false;
  }

  await instance.createDatabase(databaseName);
  return true;
}

export async function stopMysqlHere(
  instance: MysqlInstance,
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

export async function startMysqlHere(
  options: MysqlOptions = {}
): Promise<MysqlHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_MYSQL_PORT,
    autoPort: options.autoPort,
  });

  const version = options.mysqlVersion ?? options.version ?? DEFAULT_MYSQL_VERSION;
  const instance = new MysqlInstance({
    projectDir: options.projectDir,
    dataDir: options.dataDir,
    installationDir: options.installationDir,
    version,
    port,
    username: options.username ?? DEFAULT_MYSQL_USERNAME,
    password: options.password ?? DEFAULT_MYSQL_PASSWORD,
    socketPath: options.socketPath,
    onBinaryProgress: (message) => {
      // Keep CLI noise low; only print download/extract lines.
      console.error(message);
    },
  });

  await instance.start();

  const database = options.database ?? DEFAULT_MYSQL_DATABASE;
  const shouldCreate =
    options.createDatabaseIfMissing ?? database !== DEFAULT_MYSQL_DATABASE;

  if (shouldCreate) {
    await ensureMysqlHereDatabase(instance, database);
  }

  const username = options.username ?? DEFAULT_MYSQL_USERNAME;
  const password = options.password ?? DEFAULT_MYSQL_PASSWORD;
  const defaultCleanupOnShutdown = options.cleanupOnShutdown ?? false;

  const connectionString = buildMysqlUrl({
    user: username,
    password,
    host: "127.0.0.1",
    port,
    database: DEFAULT_MYSQL_DATABASE,
  });
  const databaseConnectionString = buildMysqlUrl({
    user: username,
    password,
    host: "127.0.0.1",
    port,
    database,
  });

  let removeShutdownHooks = () => {};

  const stopHandle = async (stopOptions: StopOptions = {}) => {
    removeShutdownHooks();
    const cleanup = stopOptions.cleanup ?? defaultCleanupOnShutdown;
    await stopMysqlHere(instance, { cleanup });
  };

  if (options.registerProcessShutdownHandlers ?? true) {
    removeShutdownHooks = registerShutdownHandlers({
      stop: async () => stopHandle({ cleanup: defaultCleanupOnShutdown }),
      signals: options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS,
    });
  }

  return {
    engine: "mysql",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username,
    serverVersion: instance.getMysqlVersion(),
    stop: stopHandle,
    cleanup: async () => stopHandle({ cleanup: true }),
    ensureDatabase: async (databaseName = database) =>
      ensureMysqlHereDatabase(instance, databaseName),
    removeShutdownHooks,
  };
}

export function getPreStartMysqlState(projectDir?: string) {
  const root = resolve(projectDir ?? process.cwd());
  const paths = getEnginePaths(root, "mysql");
  const installedVersions = getInstalledMysqlVersions(paths.bin);

  return {
    dataDir: paths.data,
    configDir: paths.config,
    hasData:
      existsSync(paths.data) &&
      (existsSync(join(paths.data, "mysql")) ||
        existsSync(join(paths.data, "ibdata1")) ||
        existsSync(join(paths.data, ".db-here-initialized"))),
    installedVersions,
    installedVersion: installedVersions[0] ?? "",
  };
}
