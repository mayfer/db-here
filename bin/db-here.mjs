#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startDbHere } from "../dist/index.js";
import {
  getPreStartClickhouseState,
} from "../dist/src/clickhouse/index.js";
import {
  getPreStartMemcachedState,
} from "../dist/src/memcached/index.js";
import { getPreStartMinioState } from "../dist/src/minio/index.js";
import { getPreStartMongodbState } from "../dist/src/mongodb/index.js";
import { getPreStartOpensearchState } from "../dist/src/opensearch/index.js";
import {
  getPreStartMysqlState,
  getPreStartPgState,
  getPreStartRedisState,
  withPostgresLinuxCompat,
} from "../scripts/cli-helpers.mjs";
import {
  ENGINE_CHOICES,
  clientHint,
  engineDefaults,
  engineLabel,
  normalizeEngine,
} from "../scripts/cli-shared.mjs";

const argv = await yargs(hideBin(process.argv))
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
  .option("db-version", { describe: "Engine version pin (when supported)" })
  .option("auto-port", {
    default: "true",
    describe: "Auto-assign available port when default is in use",
    type: "string",
  })
  .example("$0 mongodb", "MongoDB")
  .example("$0 minio", "MinIO")
  .example("$0 clickhouse", "ClickHouse")
  .example("$0 opensearch", "OpenSearch")
  .example("$0 memcached", "Memcached")
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
const version = argv["db-version"];
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
const localDir = preStartState.localDir;
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
