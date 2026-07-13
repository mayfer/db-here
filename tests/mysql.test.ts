import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "mysql2/promise";
import { startMysqlHere } from "../index";

const supported =
  process.platform === "darwin" || process.platform === "linux";

const port = 34000 + (process.pid % 1000);

test.skipIf(!supported)(
  "mysql programmatic startup creates database and preserves data on stop",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "db-here-mysql-"));
    const database = "app_startup_db";
    const installationDir = join(process.cwd(), "db-here", "mysql", "bin");

    const handle = await startMysqlHere({
      engine: "mysql",
      projectDir,
      port,
      database,
      createDatabaseIfMissing: true,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      const conn = await createConnection(handle.databaseConnectionString);
      const [rows] = await conn.query<Array<{ db: string }>>(
        "SELECT DATABASE() AS db"
      );
      expect(rows[0]?.db).toBe(database);

      await conn.query("CREATE TABLE IF NOT EXISTS persist_test (v VARCHAR(32))");
      await conn.query("TRUNCATE TABLE persist_test");
      await conn.query("INSERT INTO persist_test (v) VALUES ('kept')");

      const [versionRows] = await conn.query<Array<{ v: string }>>(
        "SELECT VERSION() AS v"
      );
      expect(String(versionRows[0]?.v ?? "")).toMatch(/^9\./);

      await conn.end();
      await handle.stop();

      const restarted = await startMysqlHere({
        engine: "mysql",
        projectDir,
        port,
        database,
        createDatabaseIfMissing: true,
        installationDir,
        registerProcessShutdownHandlers: false,
      });

      try {
        const conn2 = await createConnection(restarted.databaseConnectionString);
        const [persisted] = await conn2.query<Array<{ v: string }>>(
          "SELECT v FROM persist_test LIMIT 1"
        );
        expect(persisted[0]?.v).toBe("kept");
        await conn2.end();
      } finally {
        await restarted.stop();
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  180_000
);
