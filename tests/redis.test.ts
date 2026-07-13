import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { startRedisHere } from "../index";

const supported =
  process.platform === "darwin" || process.platform === "linux";

const port = 36000 + (process.pid % 1000);

test.skipIf(!supported)(
  "redis programmatic startup persists data and config under db-here/redis",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "db-here-redis-"));
    const installationDir = join(process.cwd(), "db-here", "redis", "bin");

    const handle = await startRedisHere({
      engine: "redis",
      projectDir,
      port,
      password: "s3cret",
      database: "2",
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(handle.engine).toBe("redis");
      expect(handle.port).toBe(port);
      expect(handle.databaseConnectionString).toContain(`:${port}/2`);
      expect(handle.serverVersion).toMatch(/^7\./);

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
          "s3cret",
          "--no-auth-warning",
          "-n",
          "2",
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
        password: "s3cret",
        database: "2",
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
            "s3cret",
            "--no-auth-warning",
            "-n",
            "2",
            "GET",
            "persist_test",
          ],
          { encoding: "utf8", env }
        );
        expect(getResult.status).toBe(0);
        expect(getResult.stdout.trim()).toBe("kept");

        // Config lives under db-here/redis/config
        const confPath = join(
          projectDir,
          "db-here",
          "redis",
          "config",
          "redis.conf"
        );
        const { existsSync, readFileSync } = await import("node:fs");
        expect(existsSync(confPath)).toBe(true);
        expect(readFileSync(confPath, "utf8")).toContain(`port ${port}`);
        expect(readFileSync(confPath, "utf8")).toContain("requirepass s3cret");
        expect(existsSync(join(projectDir, "db-here", "redis", "data"))).toBe(
          true
        );
      } finally {
        await restarted.stop();
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  180_000
);
