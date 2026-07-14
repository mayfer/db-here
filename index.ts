export type {
  ClickhouseOptions,
  CommonDbOptions,
  DbEngine,
  DbHereHandle,
  DbHereOptions,
  MemcachedOptions,
  MinioOptions,
  MongodbOptions,
  MysqlOptions,
  OpensearchOptions,
  PostgresOptions,
  RedisOptions,
  StopOptions,
} from "./src/types.js";

export type { ShutdownSignal } from "./src/shutdown.js";
export {
  DEFAULT_DATA_ROOT,
  DB_HERE_DIR,
  getEnginePaths,
  resolveDataRoot,
} from "./src/paths.js";

export {
  startPgHere,
  createPgHereInstance,
  ensurePgHereDatabase,
  stopPgHere,
  DEFAULT_PG_PORT,
  DEFAULT_PG_USERNAME,
  DEFAULT_PG_PASSWORD,
  DEFAULT_PG_DATABASE,
  type PgHereHandle,
} from "./src/postgres.js";

export {
  startMysqlHere,
  stopMysqlHere,
  ensureMysqlHereDatabase,
  MysqlInstance,
  getPreStartMysqlState,
  getInstalledMysqlVersions,
  DEFAULT_MYSQL_PORT,
  DEFAULT_MYSQL_USERNAME,
  DEFAULT_MYSQL_PASSWORD,
  DEFAULT_MYSQL_DATABASE,
  DEFAULT_MYSQL_VERSION,
  type MysqlHereHandle,
} from "./src/mysql/index.js";

export {
  startRedisHere,
  stopRedisHere,
  RedisInstance,
  getPreStartRedisState,
  getInstalledRedisVersions,
  DEFAULT_REDIS_PORT,
  DEFAULT_REDIS_PASSWORD,
  DEFAULT_REDIS_DATABASE,
  DEFAULT_REDIS_VERSION,
  type RedisHereHandle,
} from "./src/redis/index.js";

export {
  startMongodbHere,
  getPreStartMongodbState,
  DEFAULT_MONGODB_PORT,
  DEFAULT_MONGODB_VERSION,
  DEFAULT_MONGODB_DATABASE,
  type MongodbHereHandle,
} from "./src/mongodb/index.js";

export {
  startMinioHere,
  getPreStartMinioState,
  DEFAULT_MINIO_PORT,
  DEFAULT_MINIO_USERNAME,
  DEFAULT_MINIO_PASSWORD,
  DEFAULT_MINIO_VERSION,
  type MinioHereHandle,
} from "./src/minio/index.js";

export {
  startClickhouseHere,
  getPreStartClickhouseState,
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_CLICKHOUSE_VERSION,
  DEFAULT_CLICKHOUSE_DATABASE,
  DEFAULT_CLICKHOUSE_USERNAME,
  DEFAULT_CLICKHOUSE_PASSWORD,
  type ClickhouseHereHandle,
} from "./src/clickhouse/index.js";

export {
  startOpensearchHere,
  getPreStartOpensearchState,
  DEFAULT_OPENSEARCH_PORT,
  DEFAULT_OPENSEARCH_VERSION,
  DEFAULT_OPENSEARCH_DATABASE,
  type OpensearchHereHandle,
} from "./src/opensearch/index.js";

export {
  startMemcachedHere,
  getPreStartMemcachedState,
  DEFAULT_MEMCACHED_PORT,
  DEFAULT_MEMCACHED_VERSION,
  DEFAULT_MEMCACHED_MEMORY_MB,
  type MemcachedHereHandle,
} from "./src/memcached/index.js";

import type { DbHereHandle, DbHereOptions } from "./src/types.js";
import { startClickhouseHere } from "./src/clickhouse/index.js";
import { startMemcachedHere } from "./src/memcached/index.js";
import { startMinioHere } from "./src/minio/index.js";
import { startMongodbHere } from "./src/mongodb/index.js";
import { startMysqlHere } from "./src/mysql/index.js";
import { startOpensearchHere } from "./src/opensearch/index.js";
import { startPgHere } from "./src/postgres.js";
import { startRedisHere } from "./src/redis/index.js";

const ENGINES = [
  "postgres",
  "mysql",
  "redis",
  "mongodb",
  "minio",
  "clickhouse",
  "opensearch",
  "memcached",
] as const;

/**
 * Start a project-local database. Defaults to PostgreSQL when `engine` is omitted.
 */
export async function startDbHere(
  options: DbHereOptions = {}
): Promise<DbHereHandle> {
  const engine = options.engine ?? "postgres";

  switch (engine) {
    case "postgres":
      return startPgHere({ ...options, engine: "postgres" });
    case "mysql":
      return startMysqlHere({ ...options, engine: "mysql" });
    case "redis":
      return startRedisHere({ ...options, engine: "redis" });
    case "mongodb":
      return startMongodbHere({ ...options, engine: "mongodb" });
    case "minio":
      return startMinioHere({ ...options, engine: "minio" });
    case "clickhouse":
      return startClickhouseHere({ ...options, engine: "clickhouse" });
    case "opensearch":
      return startOpensearchHere({ ...options, engine: "opensearch" });
    case "memcached":
      return startMemcachedHere({ ...options, engine: "memcached" });
    default:
      throw new Error(
        `Unsupported engine: ${String(engine)}. Supported: ${ENGINES.join(", ")}`
      );
  }
}

export { ENGINES as SUPPORTED_ENGINES };
