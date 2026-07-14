import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Default visible project folder for binaries + data + config. */
export const DEFAULT_DATA_ROOT = "db-here-data";
const VERSION_DIR_RE = /^\d+\.\d+(?:\.\d+)?$/;

const LIBXML2_SONAME = "libxml2.so.2";
const LIBXML2_ALTERNATE_SONAME = "libxml2.so.16";
const LIB_PATHS = [
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
  "/usr/lib/i386-linux-gnu",
  "/usr/lib",
  "/lib/x86_64-linux-gnu",
  "/lib/aarch64-linux-gnu",
  "/lib/i386-linux-gnu",
  "/lib",
  "/usr/local/lib",
];

function enginePaths(projectDir, engine, dataRoot = DEFAULT_DATA_ROOT) {
  const project = resolve(projectDir);
  const dataRootAbs = resolve(project, dataRoot);
  const root = join(dataRootAbs, engine);
  const rel = relative(project, root);
  const displayRoot =
    rel && !rel.startsWith("..") && !isAbsolute(rel)
      ? rel.split("\\").join("/")
      : root;
  return {
    root,
    displayRoot,
    data: join(root, "data"),
    config: join(root, "config"),
    bin: join(root, "bin"),
  };
}

export function getPreStartPgState(projectDir, dataRoot) {
  const paths = enginePaths(projectDir, "postgres", dataRoot);
  const installedVersions = listVersionDirs(paths.bin);

  return {
    engine: "postgres",
    dataDir: paths.data,
    configDir: paths.config,
    hasData: existsSync(paths.data),
    installedVersions,
    installedVersion: installedVersions[0] ?? "",
    localDir: paths.displayRoot,
  };
}

export function getPreStartMysqlState(projectDir, dataRoot) {
  const paths = enginePaths(projectDir, "mysql", dataRoot);
  const installedVersions = listVersionDirs(paths.bin).filter((version) =>
    existsSync(join(paths.bin, version, "bin", "mysqld"))
  );

  return {
    engine: "mysql",
    dataDir: paths.data,
    configDir: paths.config,
    hasData:
      existsSync(paths.data) &&
      (existsSync(join(paths.data, "mysql")) ||
        existsSync(join(paths.data, "ibdata1")) ||
        existsSync(join(paths.data, ".db-here-initialized"))),
    installedVersions,
    installedVersion: installedVersions[0] ?? "",
    localDir: paths.displayRoot,
  };
}

export function getPreStartRedisState(projectDir, dataRoot) {
  const paths = enginePaths(projectDir, "redis", dataRoot);
  const installedVersions = listVersionDirs(paths.bin).filter((version) =>
    existsSync(join(paths.bin, version, "bin", "redis-server"))
  );

  return {
    engine: "redis",
    dataDir: paths.data,
    confDir: paths.config,
    hasData:
      existsSync(paths.data) &&
      (existsSync(join(paths.data, "dump.rdb")) ||
        existsSync(join(paths.data, "appendonlydir")) ||
        existsSync(join(paths.config, "redis.conf"))),
    installedVersions,
    installedVersion: installedVersions[0] ?? "",
    localDir: paths.displayRoot,
  };
}

export function printStartupInfo({
  engine,
  connectionString,
  preStartState,
  requestedVersion,
  runningVersion,
}) {
  const displayVersion = runningVersion || requestedVersion || "default";
  const localDir = preStartState?.localDir ?? `${DB_HERE_DIR}/${engine}`;
  const dataPath = `${localDir}/data/`;
  const label =
    engine === "mysql" ? "MySQL" : engine === "redis" ? "Redis" : "PostgreSQL";
  const client =
    engine === "mysql"
      ? `mysql ${connectionString}`
      : engine === "redis"
        ? `redis-cli -u ${connectionString}`
        : `psql ${connectionString}`;

  if (preStartState?.hasData) {
    const installed = preStartState.installedVersion;
    if (installed && runningVersion && installed !== runningVersion) {
      console.log(
        `Reusing existing ${dataPath} (${localDir}/bin has ${installed}, running ${label} is ${runningVersion})`
      );
    } else {
      console.log(`Reusing existing ${dataPath} with ${label} ${displayVersion}`);
    }
  } else {
    console.log(`Launching ${label} ${displayVersion} into new ${localDir}/`);
  }

  if (typeof connectionString === "string" && connectionString.length > 0) {
    console.log(client);
  }
}

function listVersionDirs(baseDir) {
  if (!existsSync(baseDir)) {
    return [];
  }

  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VERSION_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareSemVerDesc);
  } catch {
    return [];
  }
}

function compareSemVerDesc(left, right) {
  const leftParts = left.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const rightParts = right.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i++) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l !== r) return r - l;
  }
  return 0;
}

/**
 * On some Linux distros the Postgres binary wants libxml2.so.2 while only
 * libxml2.so.16 is present. Create a project-local symlink + LD_LIBRARY_PATH
 * so we never need sudo or system package installs.
 */
export async function withPostgresLinuxCompat(
  start,
  projectDir,
  dataRoot = DEFAULT_DATA_ROOT
) {
  try {
    return await start();
  } catch (error) {
    if (!needsLibxml2Compat(error)) {
      throw error;
    }
    if (!ensureLibxml2Compatibility(projectDir, dataRoot)) {
      throw error;
    }
    return await start();
  }
}

function needsLibxml2Compat(error) {
  const message = String(error?.message ?? error);
  return message.includes("libxml2.so.2") || message.includes("libxml2");
}

function ensureLibxml2Compatibility(workingDir, dataRoot = DEFAULT_DATA_ROOT) {
  if (process.platform !== "linux") {
    return false;
  }

  const projectDir =
    typeof workingDir === "string" && workingDir ? workingDir : process.cwd();
  const compatDir = join(
    resolve(projectDir, dataRoot),
    "postgres",
    "config",
    "runtime-libs"
  );
  const compatLib = join(compatDir, LIBXML2_SONAME);

  if (findLibraryPath(LIBXML2_SONAME)) {
    return false;
  }

  const fallback = findLibraryPath(LIBXML2_ALTERNATE_SONAME);
  if (!fallback) {
    return false;
  }

  try {
    mkdirSync(compatDir, { recursive: true });
    if (existsSync(compatLib)) {
      try {
        if (
          lstatSync(compatLib).isSymbolicLink() &&
          readlinkSync(compatLib) === fallback
        ) {
          ensureLdLibraryPath(compatDir);
          return true;
        }
      } catch {
        // replace
      }
      rmSync(compatLib, { force: true });
    }
    symlinkSync(fallback, compatLib);
    ensureLdLibraryPath(compatDir);
    return true;
  } catch {
    return false;
  }
}

function ensureLdLibraryPath(path) {
  const currentPath = process.env.LD_LIBRARY_PATH ?? "";
  const paths = currentPath.split(":").filter(Boolean);
  if (paths.includes(path)) {
    return;
  }
  process.env.LD_LIBRARY_PATH = path + (currentPath ? `:${currentPath}` : "");
}

function findLibraryPath(name) {
  const result = spawnSync(
    "find",
    [...LIB_PATHS, "-name", `${name}*`, "-print"],
    { encoding: "utf8" }
  );
  const matches = (result.stdout ?? "").split("\n").filter(Boolean);
  if (matches.length === 0) {
    return "";
  }
  return matches.find((item) => item.endsWith(`/${name}`)) ?? matches[0];
}
