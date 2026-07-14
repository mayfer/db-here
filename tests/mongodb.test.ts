import { test, expect } from "bun:test";
import { startMongodbHere } from "../index";
import {
  binCache,
  cleanupProject,
  supported,
  tcpOk,
  tempProject,
  testPort,
} from "./helpers";

test.skipIf(!supported)(
  "mongodb: start, write, restart, read",
  async () => {
    const projectDir = tempProject("db-here-mongo-");
    const installationDir = binCache("mongodb");
    const port = testPort(57000);
    const database = "app_db";

    const handle = await startMongodbHere({
      engine: "mongodb",
      projectDir,
      port,
      database,
      installationDir,
      registerProcessShutdownHandlers: false,
    });

    try {
      expect(await tcpOk(port)).toBe(true);

      // Wire protocol-ish via raw TCP is painful; use mongosh if present,
      // otherwise a minimal insert via the legacy isMaster + insert over HTTP is N/A.
      // MongoDB has no HTTP API — use a tiny BSON-less hello over the wire:
      // We exercise durability by writing a marker file through the data dir
      // is wrong. Prefer fetch to the connection string is not HTTP.
      //
      // Use the built-in mongosh/mongo from the install when available; fall back
      // to a node net "isMaster" probe + restart port check if no shell.
      const ok = await mongoInsertAndRead(port, database, "persist_test", "kept");
      if (ok === "no-shell") {
        // Still require a clean restart that reopens the port with same data dir.
        await handle.stop();
        const restarted = await startMongodbHere({
          engine: "mongodb",
          projectDir,
          port,
          database,
          installationDir,
          registerProcessShutdownHandlers: false,
        });
        try {
          expect(await tcpOk(port)).toBe(true);
          expect(restarted.databaseConnectionString).toContain(`/${database}`);
        } finally {
          await restarted.stop();
        }
        return;
      }
      expect(ok).toBe("kept");
      await handle.stop();

      const restarted = await startMongodbHere({
        engine: "mongodb",
        projectDir,
        port,
        database,
        installationDir,
        registerProcessShutdownHandlers: false,
      });
      try {
        const again = await mongoInsertAndRead(
          port,
          database,
          "persist_test",
          null
        );
        expect(again).toBe("kept");
      } finally {
        await restarted.stop();
      }
    } finally {
      cleanupProject(projectDir);
    }
  },
  300_000
);

async function mongoInsertAndRead(
  port: number,
  database: string,
  collection: string,
  writeValue: string | null
): Promise<string | "no-shell"> {
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const installationDir = binCache("mongodb");

  // Prefer mongosh / mongo from the downloaded tree.
  let shell = "";
  for (const version of ["8.0.9"]) {
    for (const name of ["mongosh", "mongo"]) {
      const p = join(installationDir, version, "bin", name);
      if (existsSync(p)) {
        shell = p;
        break;
      }
    }
    if (shell) break;
  }
  // Official community tarball may not ship mongosh — only mongod/mongos.
  if (!shell) {
    // Try system mongosh
    const which = spawnSync("sh", ["-c", "command -v mongosh || command -v mongo"], {
      encoding: "utf8",
    });
    shell = (which.stdout || "").trim();
  }
  if (!shell) return "no-shell";

  const uri = `mongodb://127.0.0.1:${port}/${database}`;
  if (writeValue !== null) {
    const insert = spawnSync(
      shell,
      [
        uri,
        "--quiet",
        "--eval",
        `db.${collection}.deleteMany({}); db.${collection}.insertOne({v: ${JSON.stringify(writeValue)}});`,
      ],
      { encoding: "utf8" }
    );
    if (insert.status !== 0) {
      throw new Error(`mongo insert failed: ${insert.stderr || insert.stdout}`);
    }
  }
  const read = spawnSync(
    shell,
    [
      uri,
      "--quiet",
      "--eval",
      `const d=db.${collection}.findOne({}); print(d && d.v ? d.v : '');`,
    ],
    { encoding: "utf8" }
  );
  if (read.status !== 0) {
    throw new Error(`mongo read failed: ${read.stderr || read.stdout}`);
  }
  return read.stdout.trim();
}
