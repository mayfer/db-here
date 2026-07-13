import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { startPgHere } from "../index";

const supported =
  process.platform === "darwin" || process.platform === "linux";

const port = 63000 + (process.pid % 1000);

const installedVersions = (() => {
  try {
    return readdirSync(join(process.cwd(), "db-here", "postgres", "bin"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
})();

// Prefer a binary already cached by sibling pg-here if present.
const siblingPgBin = join(process.cwd(), "..", "pg-here", "pg_local", "bin");
const installationDir =
  installedVersions.length > 0
    ? join(process.cwd(), "db-here", "postgres", "bin")
    : siblingPgBin;

const pinnedVersion = installedVersions.at(-1);

test.skipIf(!supported)(
  "postgres programmatic startup creates missing database and preserves data",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "db-here-pg-"));
    const database = "app_startup_db";
    const handle = await startPgHere({
      projectDir,
      port,
      database,
      createDatabaseIfMissing: true,
      installationDir,
      postgresVersion: pinnedVersion,
      registerProcessShutdownHandlers: false,
    });

    try {
      const client = new Client({
        connectionString: handle.databaseConnectionString,
      });
      await client.connect();
      const result = await client.query("select current_database() as db");
      expect(result.rows[0]?.db).toBe(database);

      await client.query("create table if not exists persist_test (v text)");
      await client.query("truncate table persist_test");
      await client.query("insert into persist_test (v) values ('kept')");
      await client.end();
      await handle.stop();

      const restarted = await startPgHere({
        projectDir,
        port,
        database,
        createDatabaseIfMissing: true,
        installationDir,
        postgresVersion: pinnedVersion,
        registerProcessShutdownHandlers: false,
      });

      try {
        const client2 = new Client({
          connectionString: restarted.databaseConnectionString,
        });
        await client2.connect();
        const persisted = await client2.query(
          "select v from persist_test limit 1"
        );
        expect(persisted.rows[0]?.v).toBe("kept");
        await client2.end();
      } finally {
        await restarted.stop();
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  120_000
);
