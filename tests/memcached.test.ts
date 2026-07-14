import { test, expect } from "bun:test";
import { createConnection } from "node:net";
import { startMemcachedHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "memcached: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-mc-");
    const installationDir = binCache("memcached");
    const port = testPort(51200);

    const handle = await startMemcachedHere({
      engine: "memcached",
      projectDir,
      port,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);
      await memcachedSet(port, "persist_test", "kept");
      expect(await memcachedGet(port, "persist_test")).toBe("kept");
      await handle.stop();

      // Memcached is in-memory only — after restart the key is gone, but the
      // server must come back and accept the same write again.
      const restarted = await startMemcachedHere({
        engine: "memcached",
        projectDir,
        port,
        installationDir,
        registerProcessShutdownHandlers: false,
      });
      try {
        expect(await tcpOk(port)).toBe(true);
        expect(await memcachedGet(port, "persist_test")).toBe(null);
        await memcachedSet(port, "persist_test", "kept");
        expect(await memcachedGet(port, "persist_test")).toBe("kept");
      } finally {
        await restarted.stop();
      }
    } finally {
      cleanupProject(projectDir);
    }
  },
  300_000
);

function memcachedSet(
  port: number,
  key: string,
  value: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("STORED") || buf.includes("ERROR")) {
        s.end();
        if (buf.includes("STORED")) resolve();
        else reject(new Error(buf));
      }
    });
    s.on("error", reject);
    s.write(
      `set ${key} 0 0 ${Buffer.byteLength(value)}\r\n${value}\r\n`
    );
  });
}

function memcachedGet(
  port: number,
  key: string
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("END\r\n")) {
        s.end();
        const m = buf.match(new RegExp(`VALUE ${key} \\d+ (\\d+)\\r\\n`));
        if (!m) {
          resolve(null);
          return;
        }
        const len = Number(m[1]);
        const start = buf.indexOf("\r\n", m.index!) + 2;
        resolve(buf.slice(start, start + len));
      }
    });
    s.on("error", reject);
    s.write(`get ${key}\r\n`);
  });
}
