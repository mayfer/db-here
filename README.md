# db-here

Run a local database **inside your project folder** with one command.

Downloads the server binary, keeps data local, needs **no system packages, no Docker, no Homebrew, no OS configuration** for almost every engine.

Especially useful for **AI agents and automation**: spin up a real database without fighting OS installers, package managers, or Docker — then **back up or restore by copying a directory**.

| Engine     | CLI                     | Default port | Local folder                 |
|------------|-------------------------|--------------|------------------------------|
| PostgreSQL | `db-here postgres`      | `55432`      | `db-here-data/postgres/`     |
| MySQL      | `db-here mysql`         | `33306`      | `db-here-data/mysql/`        |
| Redis      | `db-here redis`         | `56379`      | `db-here-data/redis/`        |
| MongoDB    | `db-here mongodb`       | `57017`      | `db-here-data/mongodb/`      |
| MinIO      | `db-here minio`         | `59000`      | `db-here-data/minio/`        |
| ClickHouse | `db-here clickhouse`    | `58123`      | `db-here-data/clickhouse/`   |
| OpenSearch | `db-here opensearch`    | `59200`      | `db-here-data/opensearch/`   |
| Memcached  | `db-here memcached`     | `51211`      | `db-here-data/memcached/`    |

**The engine is always required** — there is no default. Pass it on the CLI or set `engine` in the JS API.

## Why this is nice for agents (and humans)

- **No OS installs** — no `apt install postgresql`, no Docker daemon, no Homebrew services. Binaries land under your project.
- **Explicit and scriptable** — `db-here postgres` / `startDbHere({ engine: "postgres" })` is a clear one-liner for tools and CI.
- **Trivial backups & restores** — stop the server, then copy or restore `db-here-data/<engine>/` (or your custom `--data-root`). Data, config, and often the binaries live together.
- **Project-scoped** — each app can have its own isolated data tree; wipe = delete the folder.

## 30-second start

```bash
bunx db-here postgres
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
| version | auto (via `pg-embedded` / theseus-rs binaries) |

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
| Linux | OpenSearch `2.19.1` (official bundle, **bundled JDK** — no system Java) |
| macOS | Elasticsearch `8.17.0` (no official OpenSearch macOS server builds; security disabled; **bundled JDK** — no system Java) |

### Memcached

| Flag | Default |
|------|---------|
| port | `51211` |
| memory | `64` MB |
| version | `1.6.38` |

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
bun run db-here postgres
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

// Unified entry — engine is required
const mongo = await startDbHere({ engine: "mongodb", database: "my_app" });
console.log(mongo.databaseConnectionString);
await mongo.stop();

// Per-engine helpers (engine implied by the function name)
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

- **PostgreSQL** — platform binaries (theseus-rs / `pg-embedded`) under `db-here-data/postgres/bin/`.
- **MySQL** — official MySQL Community Server generic tarball under `db-here-data/mysql/bin/<version>/`.
- **Redis** — conda-forge `redis-server` + `openssl` under `db-here-data/redis/bin/<version>/`.
- **MongoDB** — official Community Server tarball from `fastdl.mongodb.org`.
- **MinIO** — single official binary per OS/arch (`dl.min.io`).
- **ClickHouse** — static binary (macOS builds / Linux common-static tgz).
- **OpenSearch** — official Linux bundle with **embedded JDK**. On macOS, Elasticsearch with security off (also **ships its own JDK** under the install tree — no system Java / `JAVA_HOME` required).
- **Memcached** — prebuilt Homebrew bottles + linked libs on **macOS**. On **Linux**, builds from source into the project tree (see caveats).

Supported platforms (no OS-level setup for most engines):

- macOS arm64 / x64  
- Linux x64 / arm64

## Caveats

### Memcached on Linux needs a C toolchain (once)

**Memcached is the only engine that may require build tools.** On Linux we compile memcached + libevent from source (Homebrew bottles need a very new glibc and break on Amazon Linux and similar). You need a C compiler and `make` available once, e.g.:

```bash
# Amazon Linux / RHEL-ish
sudo dnf install -y gcc make

# Debian / Ubuntu
sudo apt-get install -y build-essential
```

This is **not** an OS install of memcached itself — the binary still ends up under `db-here-data/memcached/`. macOS uses prebuilt bottles and does not need a local compile.

### OpenSearch / Elasticsearch and Java

**No system Java install.** Official OpenSearch (Linux) and Elasticsearch (macOS fallback) distributions include a **bundled JDK** inside the downloaded tree. db-here does not expect `java` on your `PATH` or a global `JAVA_HOME`.

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

### Backup / restore

With the engine stopped:

```bash
# backup
cp -a db-here-data/postgres ./backups/postgres-$(date +%F)

# restore
rm -rf db-here-data/postgres
cp -a ./backups/postgres-2026-07-13 db-here-data/postgres
```

Same idea for any engine folder (or the whole `db-here-data/` tree).

Add `db-here-data/` to `.gitignore` (this package’s template already does).

## Zero dependencies outside the project

| Requirement | Needed? |
|-------------|---------|
| Docker | No |
| Homebrew / apt packages of the database | No |
| System server binaries | No |
| System Java (OpenSearch / Elasticsearch) | No — bundled JDK |
| Root / sudo | No (except optional Linux build tools for Memcached) |
| Network after first binary download | No |
| C compiler / make | **Only Memcached on Linux** (one-time source build) |

Only needs a normal Node/Bun runtime and outbound HTTPS once for the first binary download (plus `gcc`/`make` for Memcached on Linux if you use that engine).
