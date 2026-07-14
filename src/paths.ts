import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Default project folder for downloaded binaries, data files, and config.
 * Visible (not dot-prefixed) so it’s obvious what to gitignore / wipe.
 */
export const DEFAULT_DATA_ROOT = "db-here-data";

/** @deprecated Use DEFAULT_DATA_ROOT — kept as an alias for older imports. */
export const DB_HERE_DIR = DEFAULT_DATA_ROOT;

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
  /** Absolute engine root, e.g. …/db-here-data/mysql */
  root: string;
  /** Absolute data-root parent (…/db-here-data) */
  dataRoot: string;
  /** Relative display path when under projectDir, else absolute */
  displayRoot: string;
  /** Database / object files */
  data: string;
  /** Config, pid, logs, sockets */
  config: string;
  /** Downloaded server binaries */
  bin: string;
}

/**
 * Resolve the data-root directory.
 * Relative paths are under `projectDir`; absolute paths are used as-is.
 */
export function resolveDataRoot(
  projectDir: string,
  dataRoot: string = DEFAULT_DATA_ROOT
): string {
  return resolve(projectDir, dataRoot);
}

/**
 * Canonical layout:
 *
 * ```
 * db-here-data/          (or custom --data-root / dataRoot)
 *   <engine>/
 *     data/
 *     config/
 *     bin/
 * ```
 */
export function getEnginePaths(
  projectDir: string,
  engine: LocalEngine,
  dataRoot: string = DEFAULT_DATA_ROOT
): EnginePaths {
  const project = resolve(projectDir);
  const dataRootAbs = resolveDataRoot(project, dataRoot);
  const root = join(dataRootAbs, engine);

  const rel = relative(project, root);
  // Under project: show project-relative path; otherwise absolute.
  const displayRoot =
    rel && !rel.startsWith("..") && !isAbsolute(rel)
      ? rel.split("\\").join("/")
      : root;

  return {
    root,
    dataRoot: dataRootAbs,
    displayRoot,
    data: join(root, "data"),
    config: join(root, "config"),
    bin: join(root, "bin"),
  };
}
