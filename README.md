# db-here

Run a local database **inside your project folder** with one command.

Downloads the server binary, keeps data local, needs **no system packages, no Docker, no Homebrew, no OS configuration**.

| Engine     | CLI                 | Default port | Local folder                 |
|------------|---------------------|--------------|------------------------------|
| PostgreSQL | `db-here` / `postgres` | `55432`   | `db-here-data/postgres/`     |
| MySQL      | `db-here mysql`     | `33306`      | `db-here-data/mysql/`        |
| Redis      | `db-here redis`     | `56379`      | `db-here-data/redis/`        |
| MongoDB    | `db-here mongodb`   | `57017`      | `db-here-data/mongodb/`      |
| MinIO      | `db-here minio`     | `59000`      | `db-here-data/minio/`        |
| ClickHouse | `db-here clickhouse`| `58123`      | `db-here-data/clickhouse/`   |
| OpenSearch | `db-here opensearch`| `59200`      | `db-here-data/opensearch/`   |
| Memcached  | `db-here memcached` | `51211`      | `db-here-data/memcached/`    |

## 30-second start

```bash
# PostgreSQL (default)
bunx db-here

# Other engines
bunx db-here mysql
bunx db-here redis
bunx db-here mongodb
bunx db-here minio
bunx db-here clickhouse
bunx db-here opensearch
bunx db-here memcached
```

Examples of the connect line printed after launch:

```text
psql postgresql://postgres:postgres@localhost:55432/postgres
mysql mysql://root:root@127.0.0.1:33306/mysql
redis-cli -u redis://127.0.0.1:56379/0
mongosh mongodb://127.0.0.1:57017/test
# MinIO S3 API + console URL
curl 'http://127.0.0.1:58123/?query=SELECT%201'
curl http://127.0.0.1:59200
printf 'stats\r\nquit\r\n' | nc 127.0.0.1 51211
```

The process stays alive until you stop it.  
**Ctrl+C** → exits and stops the database.

## Defaults

### PostgreSQL

| Flag | Default |
|------|---------|
| username | `postgres` |
| password | `postgres` |
| database | `postgres` |
| port | `55432` |
| version | auto (via `pg-embedded`) |

### MySQL

| Flag | Default |
|------|---------|
| username | `root` |
| password | `root` |
| database | `mysql` |
| port | `33306` |
| version | `9.7.1` |

### Redis

| Flag | Default |
|------|---------|
| password | _(empty — no `requirepass`)_ |
| database | `0` (logical DB index) |
| port | `56379` |
| version | `7.4.7` |

### MongoDB

| Flag | Default |
|------|---------|
| database | `test` |
| port | `57017` |
| version | `8.0.9` |

### MinIO

| Flag | Default |
|------|---------|
| access key | `minioadmin` |
| secret key | `minioadmin` |
| API port | `59000` |
| console port | API port + 1 |

### ClickHouse

| Flag | Default |
|------|---------|
| username | `default` |
| password | _(empty)_ |
| database | `default` |
| HTTP port | `58123` |
| native port | HTTP port + 1 |

### OpenSearch

| Flag | Default |
|------|---------|
| port | `59200` |
| Linux | OpenSearch `2.19.1` |
| macOS | Elasticsearch `8.17.0` (no official OpenSearch macOS builds; security disabled) |

### Memcached

| Flag | Default |
|------|---------|
| port | `51211` |
| memory | `64` MB |
| version | `1.6.45` |

## Custom run

```bash
bunx db-here postgres --username me --password secret --database my_app --port 55433
bunx db-here mysql    --username root --password secret --database my_app --port 33307
bunx db-here redis    --password secret --database 0 --port 56379
bunx db-here mongodb  --database my_app --port 57017
bunx db-here minio    --username minioadmin --password secret --port 59000
bunx db-here clickhouse --username default --password secret --port 58123
bunx db-here memcached --port 51211

# Custom folder for binaries + data + config (default: db-here-data)
bunx db-here postgres --data-root ./my-local-dbs
```

In this repo (same CLI as `bunx db-here`):

```bash
bun run db-here
bun run db-here mysql
bun run db-here redis
bun run db-here mongodb
bun run db-here minio
bun run db-here clickhouse
bun run db-here opensearch
bun run db-here memcached
```

## Programmatic (JS/TS API)

Yes — this package exports a full programmatic API (not CLI-only).

```ts
import {
  startDbHere,
  startClickhouseHere,
  startMemcachedHere,
  startMinioHere,
  startMongodbHere,
  startMysqlHere,
  startOpensearchHere,
  startPgHere,
  startRedisHere,
  DEFAULT_DATA_ROOT,
} from "db-here";

// Unified entry (defaults to postgres when engine is omitted)
const mongo = await startDbHere({ engine: "mongodb", database: "my_app" });
console.log(mongo.databaseConnectionString);
await mongo.stop();

// Per-engine helpers
const minio = await startMinioHere({ password: "secret" });
console.log(minio.connectionString, minio.consolePort);

const ch = await startClickhouseHere();
const res = await fetch(`${ch.connectionString}/?query=SELECT%201`);

const cache = await startMemcachedHere({ memoryMb: 128 });
await cache.stop();

// Custom data root (same as CLI --data-root; default is "db-here-data")
const pg = await startPgHere({
  dataRoot: "./my-local-dbs", // relative to projectDir / cwd
  // or absolute: dataRoot: "/var/tmp/app-dbs",
});
console.log(DEFAULT_DATA_ROOT); // "db-here-data"
await pg.stop();
```

Common options (all engines): `projectDir`, `dataRoot`, `port`, `username`,
`password`, `database`, `version`, `autoPort`, plus optional overrides
`dataDir` / `installationDir` / `configDir`.

## How it works

- **PostgreSQL** — [`pg-embedded`](https://www.npmjs.com/package/pg-embedded) platform binaries under `db-here-data/postgres/bin/`.
- **MySQL** — official MySQL Community Server generic tarball under `db-here-data/mysql/bin/<version>/`.
- **Redis** — conda-forge `redis-server` + `openssl` under `db-here-data/redis/bin/<version>/`.
- **MongoDB** — official Community Server tarball from `fastdl.mongodb.org`.
- **MinIO** — single official binary per OS/arch (`dl.min.io`).
- **ClickHouse** — static binary (macOS builds / Linux common-static tgz).
- **OpenSearch** — official Linux bundle; on macOS falls back to Elasticsearch with security off (same local HTTP API shape).
- **Memcached** — Homebrew bottle + linked libs on macOS; Linux bottle with `ld --library-path` style isolation.

Supported platforms (no OS-level setup):

- macOS arm64 / x64  
- Linux x64 / arm64

## Layout after first run

```text
your-project/
  db-here-data/          # or --data-root / dataRoot
    postgres/
      data/
      config/
      bin/
    mysql/
      data/
      config/
      bin/<version>/
    redis/
      data/
      config/
      bin/<version>/
    mongodb/
      data/
      config/
      bin/<version>/
    minio/
      data/
      config/
      bin/latest/
    clickhouse/
      data/
      config/
      bin/<version>/
    opensearch/
      data/
      config/
      bin/
    memcached/
      data/
      config/
      bin/<version>/
```

Add `db-here-data/` to `.gitignore` (this package’s template already does).

## Zero dependencies outside the project

| Requirement | Needed? |
|-------------|---------|
| Docker | No |
| Homebrew / apt packages | No |
| System server binaries | No |
| Root / sudo | No |
| Network after first binary download | No |

Only needs a normal Node/Bun runtime and outbound HTTPS once for the first binary download.
