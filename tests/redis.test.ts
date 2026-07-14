import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startRedisHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "redis: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-redis-");
    const installationDir = binCache("redis");
    const port = testPort(36000);
    const password = "s3cret";
    const database = "2";

    const handle = await startRedisHere({
      engine: "redis",
      projectDir,
      port,
      password,
      database,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);
      const cli = join(installationDir, "7.4.7", "bin", "redis-cli");
      const libDir = join(installationDir, "7.4.7", "lib");
      const env = {
        ...process.env,
        LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH ?? ""]
          .filter(Boolean)
          .join(":"),
      };

      const setResult = spawnSync(
        cli,
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-a",
          password,
          "--no-auth-warning",
          "-n",
          database,
          "SET",
          "persist_test",
          "kept",
        ],
        { encoding: "utf8", env }
      );
      expect(setResult.status).toBe(0);
      expect(setResult.stdout.trim()).toBe("OK");
      await handle.stop();

      const restarted = await startRedisHere({
        engine: "redis",
        projectDir,
        port,
        password,
        database,
        installationDir,
        registerProcessShutdownHandlers: false,
      });
      try {
        const getResult = spawnSync(
          cli,
          [
            "-h",
            "127.0.0.1",
            "-p",
            String(port),
            "-a",
            password,
            "--no-auth-warning",
            "-n",
            database,
            "GET",
            "persist_test",
          ],
          { encoding: "utf8", env }
        );
        expect(getResult.status).toBe(0);
        expect(getResult.stdout.trim()).toBe("kept");
      } finally {
        await restarted.stop();
      }
    } finally {
      cleanupProject(projectDir);
    }
  },
  180_000
);
