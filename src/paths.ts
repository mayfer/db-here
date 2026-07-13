import { join, resolve } from "node:path";

/**
 * Top-level project folder for all engines.
 * Named after the tool so it won't collide with common project folders.
 */
export const DB_HERE_DIR = "db-here";

export type LocalEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mongodb"
  | "minio"
  | "clickhouse"
  | "opensearch"
  | "memcached";

export interface EnginePaths {
  /** e.g. db-here/mysql */
  root: string;
  /** Relative display path, e.g. db-here/mysql */
  displayRoot: string;
  /** Database / object files */
  data: string;
  /** Config, pid, logs, sockets */
  config: string;
  /** Downloaded server binaries */
  bin: string;
}

/**
 * Canonical layout:
 *
 * ```
 * db-here/
 *   <engine>/
 *     data/
 *     config/
 *     bin/
 * ```
 */
export function getEnginePaths(
  projectDir: string,
  engine: LocalEngine
): EnginePaths {
  const root = resolve(projectDir, DB_HERE_DIR, engine);
  return {
    root,
    displayRoot: `${DB_HERE_DIR}/${engine}`,
    data: join(root, "data"),
    config: join(root, "config"),
    bin: join(root, "bin"),
  };
}
