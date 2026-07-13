import {
  DEFAULT_SHUTDOWN_SIGNALS,
  registerShutdownHandlers,
} from "./shutdown.js";
import type {
  CommonDbOptions,
  DbEngine,
  DbHereHandle,
  StopOptions,
} from "./types.js";

export async function wrapEngineHandle<
  TInstance,
  TEngine extends DbEngine = DbEngine,
>(options: {
  engine: TEngine;
  instance: TInstance;
  connectionString: string;
  databaseConnectionString: string;
  database: string;
  port: number;
  username: string;
  serverVersion?: string;
  common: CommonDbOptions;
  stopInstance: (instance: TInstance) => Promise<void>;
  cleanupInstance: (instance: TInstance) => Promise<void>;
  ensureDatabase?: (name?: string) => Promise<boolean>;
}): Promise<DbHereHandle & { engine: TEngine; instance: TInstance }> {
  const defaultCleanupOnShutdown = options.common.cleanupOnShutdown ?? false;
  let removeShutdownHooks = () => {};

  const stopHandle = async (stopOptions: StopOptions = {}) => {
    removeShutdownHooks();
    const cleanup = stopOptions.cleanup ?? defaultCleanupOnShutdown;
    try {
      await options.stopInstance(options.instance);
    } catch {
      // no-op
    }
    if (cleanup) {
      try {
        await options.cleanupInstance(options.instance);
      } catch {
        // no-op
      }
    }
  };

  if (options.common.registerProcessShutdownHandlers ?? true) {
    removeShutdownHooks = registerShutdownHandlers({
      stop: async () => stopHandle({ cleanup: defaultCleanupOnShutdown }),
      signals: options.common.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS,
    });
  }

  return {
    engine: options.engine,
    instance: options.instance,
    connectionString: options.connectionString,
    databaseConnectionString: options.databaseConnectionString,
    database: options.database,
    port: options.port,
    username: options.username,
    serverVersion: options.serverVersion,
    stop: stopHandle,
    cleanup: async () => stopHandle({ cleanup: true }),
    ensureDatabase: options.ensureDatabase ?? (async () => false),
    removeShutdownHooks,
  };
}
