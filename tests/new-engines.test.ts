import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  startClickhouseHere,
  startMemcachedHere,
  startMinioHere,
  startMongodbHere,
  startOpensearchHere,
} from "../index";

const shouldSkip =
  process.env.SKIP_NEW_ENGINE_TEST === "1" ||
  (process.platform !== "darwin" && process.platform !== "linux");

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "db-here-new-"));
}

async function tcpOk(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.setTimeout(500);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });
}

test.skipIf(shouldSkip)(
  "memcached starts and answers",
  async () => {
    const projectDir = tempProject();
    const installationDir = join(process.cwd(), "db-here", "memcached", "bin");
    const port = 51300 + (process.pid % 50);
    const handle = await startMemcachedHere({
      engine: "memcached",
      projectDir,
      installationDir,
      port,
      registerProcessShutdownHandlers: false,
    });
    try {
      expect(await tcpOk(port)).toBe(true);
      expect(handle.connectionString).toContain(String(port));
    } finally {
      await handle.stop();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  180_000
);

test.skipIf(shouldSkip)(
  "minio starts",
  async () => {
    const projectDir = tempProject();
    const installationDir = join(process.cwd(), "db-here", "minio", "bin");
    const port = 59100 + (process.pid % 50);
    const handle = await startMinioHere({
      engine: "minio",
      projectDir,
      installationDir,
      port,
      registerProcessShutdownHandlers: false,
    });
    try {
      expect(await tcpOk(port)).toBe(true);
    } finally {
      await handle.stop();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  180_000
);

test.skipIf(shouldSkip)(
  "mongodb starts",
  async () => {
    const projectDir = tempProject();
    const installationDir = join(process.cwd(), "db-here", "mongodb", "bin");
    const port = 57100 + (process.pid % 50);
    const handle = await startMongodbHere({
      engine: "mongodb",
      projectDir,
      installationDir,
      port,
      registerProcessShutdownHandlers: false,
    });
    try {
      expect(await tcpOk(port)).toBe(true);
      expect(handle.databaseConnectionString).toContain(`/${handle.database}`);
    } finally {
      await handle.stop();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  300_000
);

test.skipIf(shouldSkip || process.env.SKIP_CLICKHOUSE_TEST === "1")(
  "clickhouse starts",
  async () => {
    const projectDir = tempProject();
    const installationDir = join(process.cwd(), "db-here", "clickhouse", "bin");
    const port = 58200 + (process.pid % 50);
    const handle = await startClickhouseHere({
      engine: "clickhouse",
      projectDir,
      installationDir,
      port,
      registerProcessShutdownHandlers: false,
    });
    try {
      expect(await tcpOk(port)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/?query=SELECT%201`);
      expect(res.ok).toBe(true);
      expect((await res.text()).trim()).toBe("1");
    } finally {
      await handle.stop();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  300_000
);

// OpenSearch/ES is a large download (~300MB+); skip unless explicitly enabled.
test.skipIf(
  shouldSkip || process.env.RUN_OPENSEARCH_TEST !== "1"
)(
  "opensearch starts",
  async () => {
    const projectDir = tempProject();
    const installationDir = join(process.cwd(), "db-here", "opensearch", "bin");
    const port = 59300 + (process.pid % 50);
    const handle = await startOpensearchHere({
      engine: "opensearch",
      projectDir,
      installationDir,
      port,
      registerProcessShutdownHandlers: false,
    });
    try {
      expect(await tcpOk(port)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { tagline?: string; version?: unknown };
      expect(body.version).toBeDefined();
    } finally {
      await handle.stop();
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  600_000
);
