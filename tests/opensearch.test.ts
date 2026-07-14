import { test, expect } from "bun:test";
import { startOpensearchHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "opensearch: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-os-");
    const installationDir = binCache("opensearch");
    const port = testPort(59200);
    const index = "persist_test";

    const handle = await startOpensearchHere({
      engine: "opensearch",
      projectDir,
      port,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);
      const base = `http://127.0.0.1:${port}`;
      const put = await fetch(`${base}/${index}/_doc/1?refresh=true`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: "kept" }),
      });
      expect(put.ok).toBe(true);
      const get = await fetch(`${base}/${index}/_doc/1`);
      expect(get.ok).toBe(true);
      const body = (await get.json()) as { _source?: { v?: string } };
      expect(body._source?.v).toBe("kept");
      await handle.stop();

      const restarted = await startOpensearchHere({
        engine: "opensearch",
        projectDir,
        port,
        installationDir,
        registerProcessShutdownHandlers: false,
      });
      try {
        expect(await tcpOk(port)).toBe(true);
        // Wait briefly for shard recovery
        let value: string | undefined;
        for (let i = 0; i < 40; i++) {
          const again = await fetch(`${base}/${index}/_doc/1`);
          if (again.ok) {
            const b = (await again.json()) as { _source?: { v?: string } };
            value = b._source?.v;
            if (value === "kept") break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(value).toBe("kept");
      } finally {
        await restarted.stop();
      }
    } finally {
      cleanupProject(projectDir);
    }
  },
  600_000
);
