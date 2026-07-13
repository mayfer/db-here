import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startDbHere } from "../index.ts";
import {
  getPreStartClickhouseState,
} from "../src/clickhouse/index.ts";
import {
  getPreStartMemcachedState,
} from "../src/memcached/index.ts";
import { getPreStartMinioState } from "../src/minio/index.ts";
import { getPreStartMongodbState } from "../src/mongodb/index.ts";
import { getPreStartOpensearchState } from "../src/opensearch/index.ts";
import {
  getPreStartMysqlState,
  getPreStartPgState,
  getPreStartRedisState,
  withPostgresLinuxCompat,
} from "./cli-helpers.mjs";
import {
  ENGINE_CHOICES,
  clientHint,
  engineDefaults,
  engineLabel,
  normalizeEngine,
} from "./cli-shared.mjs";
import { packageVersion, parseVersionFlag } from "./cli-versions.mjs";

const rawArgs = hideBin(process.argv);
const versionFlag = parseVersionFlag(rawArgs);

// Bare --version → print db-here package version (never starts a DB).
if (versionFlag.present && versionFlag.value === undefined) {
  console.log(packageVersion());
  process.exit(0);
}

const argv = await yargs(rawArgs)
  .scriptName("db-here")
  .usage("$0 <engine> [options]")
  .command("$0 [engine]", "Start a project-local database", (y) =>
    y.positional("engine", {
      describe: "Database engine",
      choices: ENGINE_CHOICES,
      default: "postgres",
    })
  )
  .version(false)
  .option("username", { alias: "u", describe: "Username / access key" })
  .option("password", { alias: "p", describe: "Password / secret key" })
  .option("port", { describe: "Listen port (engine default if omitted)" })
  .option("database", {
    alias: "d",
    describe: "Database / bucket / index / logical DB",
  })
  .option("version", {
    describe: "Pin engine version (omit value to print db-here version)",
    type: "string",
  })
  .option("auto-port", {
    default: "true",
    describe: "Auto-assign available port when default is in use",
    type: "string",
  })
  .example("$0", "PostgreSQL")
  .example("$0 mysql", "MySQL")
  .example("$0 --version", "Print db-here package version")
  .example("$0 mysql --version 9.7.1", "Start MySQL 9.7.1")
  .help()
  .parse();

const engine = normalizeEngine(argv.engine);
const supported = [
  "postgres",
  "mysql",
  "redis",
  "mongodb",
  "minio",
  "clickhouse",
  "opensearch",
  "memcached",
];
if (!supported.includes(engine)) {
  console.error(`Unknown engine: ${argv.engine}`);
  console.error(`Supported: ${supported.join(", ")}`);
  process.exit(1);
}

const defaults = engineDefaults(engine);
const username = argv.username ?? defaults.username;
const password = argv.password ?? defaults.password;
const database = argv.database ?? defaults.database;
const version = versionFlag.value;
const projectDir = process.cwd();

const preStartState = (() => {
  switch (engine) {
    case "mysql":
      return getPreStartMysqlState(projectDir);
    case "redis":
      return getPreStartRedisState(projectDir);
    case "mongodb":
      return getPreStartMongodbState(projectDir);
    case "minio":
      return getPreStartMinioState(projectDir);
    case "clickhouse":
      return getPreStartClickhouseState(projectDir);
    case "opensearch":
      return getPreStartOpensearchState(projectDir);
    case "memcached":
      return getPreStartMemcachedState(projectDir);
    default:
      return getPreStartPgState(projectDir);
  }
})();

if (!preStartState.localDir) {
  preStartState.localDir = `db-here/${engine}`;
}

const start = () =>
  startDbHere({
    engine,
    projectDir,
    port: argv.port !== undefined ? Number(argv.port) : undefined,
    username,
    password,
    database,
    version,
    autoPort: argv["auto-port"] === "true",
  });

const handle =
  engine === "postgres"
    ? await withPostgresLinuxCompat(start, projectDir)
    : await start();

const displayVersion = handle.serverVersion ?? version ?? "default";
const localDir = preStartState.localDir ?? `db-here/${engine}`;
const label = engineLabel(engine);
if (preStartState.hasData) {
  console.log(`Reusing existing ${localDir}/data/ with ${label} ${displayVersion}`);
} else {
  console.log(`Launching ${label} ${displayVersion} into new ${localDir}/`);
}
console.log(clientHint(engine, handle.databaseConnectionString));
if (engine === "minio" && handle.consolePort) {
  console.log(`console http://127.0.0.1:${handle.consolePort}`);
}

setInterval(() => {}, 1 << 30);
