/** Shared CLI defaults / labels for db-here engines. */

export const ENGINE_CHOICES = [
  "postgres",
  "mysql",
  "redis",
  "mongodb",
  "minio",
  "clickhouse",
  "opensearch",
  "memcached",
  "pg",
  "mongo",
];

export function normalizeEngine(raw) {
  const e = String(raw ?? "postgres");
  if (e === "pg") return "postgres";
  if (e === "mongo") return "mongodb";
  return e;
}

export function engineDefaults(engine) {
  switch (engine) {
    case "mysql":
      return { username: "root", password: "root", database: "mysql" };
    case "redis":
      return { username: "", password: "", database: "0" };
    case "mongodb":
      return { username: "", password: "", database: "test" };
    case "minio":
      return {
        username: "minioadmin",
        password: "minioadmin",
        database: "default",
      };
    case "clickhouse":
      return { username: "default", password: "", database: "default" };
    case "opensearch":
      return { username: "", password: "", database: "_all" };
    case "memcached":
      return { username: "", password: "", database: "0" };
    default:
      return {
        username: "postgres",
        password: "postgres",
        database: "postgres",
      };
  }
}

export function engineLabel(engine) {
  switch (engine) {
    case "mysql":
      return "MySQL";
    case "redis":
      return "Redis";
    case "mongodb":
      return "MongoDB";
    case "minio":
      return "MinIO";
    case "clickhouse":
      return "ClickHouse";
    case "opensearch":
      return "OpenSearch";
    case "memcached":
      return "Memcached";
    default:
      return "PostgreSQL";
  }
}

export function clientHint(engine, connectionString) {
  switch (engine) {
    case "mysql":
      return `mysql ${connectionString}`;
    case "redis":
      return `redis-cli -u ${connectionString}`;
    case "mongodb":
      return `mongosh ${connectionString}`;
    case "minio":
      return `mc alias set local ${connectionString.replace(/^s3:\/\//, "http://").replace(/\/[^/]*$/, "")}  # or open console`;
    case "clickhouse":
      return `curl '${connectionString}'  # or clickhouse-client`;
    case "opensearch":
      return `curl ${connectionString}`;
    case "memcached":
      return `printf 'stats\\r\\nquit\\r\\n' | nc 127.0.0.1 ${connectionString.split(":").pop()}`;
    default:
      return `psql ${connectionString}`;
  }
}
