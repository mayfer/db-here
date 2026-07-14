import { test, expect } from "bun:test";
import { Client } from "pg";
import { startPgHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

/**
 * Contract for every engine test:
 * 1. start
 * 2. write + read a value
 * 3. stop
 * 4. start again on the same data dir
 * 5. read the value back (durable engines)
 */
test.skipIf(!supported)(
  "postgres: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-pg-");
    const installationDir = binCache("postgres");
    const port = testPort(63000);
    const database = "app_db";

    const handle = await startPgHere({
      projectDir,
      port,
      database,
      createDatabaseIfMissing: true,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);
      const client = new Client({
        connectionString: handle.databaseConnectionString,
      });
      await client.connect();
      await client.query("create table if not exists persist_test (v text)");
      await client.query("truncate table persist_test");
      await client.query("insert into persist_test (v) values ('kept')");
      const row = await client.query("select v from persist_test limit 1");
      expect(row.rows[0]?.v).toBe("kept");
      await client.end();
      await handle.stop();

      const restarted = await startPgHere({
        projectDir,
        port,
        database,
        createDatabaseIfMissing: true,
        installationDir,
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
      cleanupProject(projectDir);
    }
  },
  180_000
);
