import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import {
  DEFAULT_SHUTDOWN_SIGNALS,
  registerShutdownHandlers,
} from "../shutdown.js";
import type { DbHereHandle, RedisOptions, StopOptions } from "../types.js";
import {
  DEFAULT_REDIS_VERSION,
  getInstalledRedisVersions,
} from "./binary.js";
import {
  buildRedisUrl,
  DEFAULT_REDIS_DATABASE,
  DEFAULT_REDIS_PASSWORD,
  DEFAULT_REDIS_PORT,
  RedisInstance,
} from "./instance.js";

export {
  DEFAULT_REDIS_DATABASE,
  DEFAULT_REDIS_PASSWORD,
  DEFAULT_REDIS_PORT,
  DEFAULT_REDIS_VERSION,
  RedisInstance,
  getInstalledRedisVersions,
};

export interface RedisHereHandle extends DbHereHandle {
  engine: "redis";
  instance: RedisInstance;
}

export async function stopRedisHere(
  instance: RedisInstance,
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

export async function startRedisHere(
  options: RedisOptions = {}
): Promise<RedisHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_REDIS_PORT,
    autoPort: options.autoPort,
  });

  const version =
    options.redisVersion ?? options.version ?? DEFAULT_REDIS_VERSION;
  const password = options.password ?? DEFAULT_REDIS_PASSWORD;
  const database = String(options.database ?? DEFAULT_REDIS_DATABASE);

  const instance = new RedisInstance({
    projectDir: options.projectDir,
    dataDir: options.dataDir,
    installationDir: options.installationDir,
    confDir: options.confDir,
    version,
    port,
    password,
    database,
    onBinaryProgress: (message) => {
      console.error(message);
    },
  });

  await instance.start();

  const defaultCleanupOnShutdown = options.cleanupOnShutdown ?? false;
  const connectionString = buildRedisUrl({
    host: "127.0.0.1",
    port,
    password,
    database: "0",
  });
  const databaseConnectionString = buildRedisUrl({
    host: "127.0.0.1",
    port,
    password,
    database,
  });

  let removeShutdownHooks = () => {};

  const stopHandle = async (stopOptions: StopOptions = {}) => {
    removeShutdownHooks();
    const cleanup = stopOptions.cleanup ?? defaultCleanupOnShutdown;
    await stopRedisHere(instance, { cleanup });
  };

  if (options.registerProcessShutdownHandlers ?? true) {
    removeShutdownHooks = registerShutdownHandlers({
      stop: async () => stopHandle({ cleanup: defaultCleanupOnShutdown }),
      signals: options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS,
    });
  }

  return {
    engine: "redis",
    instance,
    connectionString,
    databaseConnectionString,
    database,
    port,
    username: options.username ?? "",
    serverVersion: instance.getRedisVersion(),
    stop: stopHandle,
    cleanup: async () => stopHandle({ cleanup: true }),
    // Redis logical DBs always "exist"; nothing to create.
    ensureDatabase: async () => false,
    removeShutdownHooks,
  };
}

export function getPreStartRedisState(projectDir?: string) {
  const root = resolve(projectDir ?? process.cwd());
  const paths = getEnginePaths(root, "redis");
  const installedVersions = getInstalledRedisVersions(paths.bin);

  return {
    dataDir: paths.data,
    confDir: paths.config,
    hasData:
      existsSync(paths.data) &&
      (existsSync(join(paths.data, "dump.rdb")) ||
        existsSync(join(paths.data, "appendonlydir")) ||
        existsSync(join(paths.config, "redis.conf"))),
    installedVersions,
    installedVersion: installedVersions[0] ?? "",
  };
}
