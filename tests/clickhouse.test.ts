import { test, expect } from "bun:test";
import { startClickhouseHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "clickhouse: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-ch-");
    const installationDir = binCache("clickhouse");
    const port = testPort(58100);

    const handle = await startClickhouseHere({
      engine: "clickhouse",
      projectDir,
      port,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);
      const base = `http://127.0.0.1:${port}`;
      // GET is readonly on modern ClickHouse — mutations need POST.
      const post = (sql: string) =>
        fetch(`${base}/`, {
          method: "POST",
          body: sql,
          headers: { "content-type": "text/plain" },
        });
      const create = await post(
        "CREATE TABLE IF NOT EXISTS persist_test (v String) ENGINE = MergeTree ORDER BY v"
      );
      expect(create.ok).toBe(true);
      const insert = await post("INSERT INTO persist_test VALUES ('kept')");
      expect(insert.ok).toBe(true);
      const select = await fetch(
        `${base}/?query=${encodeURIComponent("SELECT v FROM persist_test LIMIT 1")}`
      );
      expect(select.ok).toBe(true);
      expect((await select.text()).trim()).toBe("kept");
      await handle.stop();

      const restarted = await startClickhouseHere({
        engine: "clickhouse",
        projectDir,
        port,
        installationDir,
        registerProcessShutdownHandlers: false,
      });
      try {
        expect(await tcpOk(port)).toBe(true);
        const again = await fetch(
          `${base}/?query=${encodeURIComponent(
            "SELECT v FROM persist_test LIMIT 1"
          )}`
        );
        expect(again.ok).toBe(true);
        expect((await again.text()).trim()).toBe("kept");
      } finally {
        await restarted.stop();
      }
    } finally {
      cleanupProject(projectDir);
    }
  },
  300_000
);
