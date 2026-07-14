import { test, expect } from "bun:test";
import { createConnection } from "mysql2/promise";
import { startMysqlHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "mysql: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-mysql-");
    const installationDir = binCache("mysql");
    const port = testPort(34000);
    const database = "app_db";

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
      expect(await tcpOk(port)).toBe(true);
      const conn = await createConnection(handle.databaseConnectionString);
      await conn.query(
        "CREATE TABLE IF NOT EXISTS persist_test (v VARCHAR(32))"
      );
      await conn.query("TRUNCATE TABLE persist_test");
      await conn.query("INSERT INTO persist_test (v) VALUES ('kept')");
      const [rows] = await conn.query<Array<{ v: string }>>(
        "SELECT v FROM persist_test LIMIT 1"
      );
      expect(rows[0]?.v).toBe("kept");
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
      cleanupProject(projectDir);
    }
  },
  180_000
);
