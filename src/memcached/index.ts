import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  chmodX,
  detectOsCpu,
  downloadFile,
  extractTar,
  findFirst,
  makeTempDir,
  runCommand,
  safeRename,
  waitForTcp,
} from "../download.js";
import { wrapEngineHandle } from "../engine-handle.js";
import { getEnginePaths } from "../paths.js";
import { resolvePort } from "../ports.js";
import { spawnDetached, waitForExit } from "../process.js";
import type { DbHereHandle, MemcachedOptions } from "../types.js";

export const DEFAULT_MEMCACHED_PORT = 51211;
export const DEFAULT_MEMCACHED_VERSION = "1.6.45";
export const DEFAULT_MEMCACHED_MEMORY_MB = 64;

export interface MemcachedHereHandle extends DbHereHandle {
  engine: "memcached";
  instance: MemcachedInstance;
}

class MemcachedInstance {
  readonly dataDir: string;
  readonly configDir: string;
  readonly installationDir: string;
  readonly version: string;
  readonly port: number;
  readonly memoryMb: number;
  private process: ChildProcess | null = null;
  private binaryPath = "";
  private libDir = "";
  private readonly onProgress?: (m: string) => void;

  constructor(opts: {
    projectDir: string;
    dataDir?: string;
    configDir?: string;
    installationDir?: string;
    version: string;
    port: number;
    memoryMb: number;
    onProgress?: (m: string) => void;
  }) {
    const paths = getEnginePaths(opts.projectDir, "memcached");
    this.dataDir = resolve(opts.dataDir ?? paths.data);
    this.configDir = resolve(opts.configDir ?? paths.config);
    this.installationDir = resolve(opts.installationDir ?? paths.bin);
    this.version = opts.version;
    this.port = opts.port;
    this.memoryMb = opts.memoryMb;
    this.onProgress = opts.onProgress;
  }

  async start(): Promise<void> {
    const ensured = await ensureMemcachedBinary({
      installationDir: this.installationDir,
      version: this.version,
      onProgress: this.onProgress,
    });
    this.binaryPath = ensured.binaryPath;
    this.libDir = ensured.libDir;

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    // memcached is in-memory; dataDir is reserved for future persistence hooks.
    writeFileSync(
      join(this.configDir, "memcached.env"),
      `PORT=${this.port}\nMEMORY_MB=${this.memoryMb}\n`,
      "utf8"
    );

    // -u is only needed/allowed when starting as root.
    const args = [
      "-l",
      "127.0.0.1",
      "-p",
      String(this.port),
      "-m",
      String(this.memoryMb),
    ];
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      args.push(
        "-u",
        process.env.USER || process.env.LOGNAME || "nobody"
      );
    }

    const env = { ...process.env };
    if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = this.libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
    }

    const stderrChunks: Buffer[] = [];
    // Linux homebrew bottles need the system dynamic linker invoked explicitly.
    if (process.platform === "linux") {
      const loader = findLinuxLoader();
      this.process = spawnDetached(loader, [
        "--library-path",
        this.libDir,
        this.binaryPath,
        ...args,
      ], { env, stderr: "pipe" });
    } else {
      this.process = spawnDetached(this.binaryPath, args, {
        env,
        stderr: "pipe",
      });
    }

    this.process.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    this.process.on("exit", () => {
      this.process = null;
    });

    try {
      await waitForTcp(this.port, "127.0.0.1", 30_000);
    } catch (error) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new Error(
        `Memcached failed to start on port ${this.port}.\n${stderr || "(no stderr)"}\n${error}`
      );
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      await waitForExit(this.process, 5_000);
      this.process = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

function findLinuxLoader(): string {
  const candidates = [
    "/lib64/ld-linux-x86-64.so.2",
    "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    "/lib/ld-linux-aarch64.so.1",
    "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "Could not find a system dynamic linker to run memcached on Linux"
  );
}

type BrewBottleKey =
  | "arm64_sonoma"
  | "sonoma"
  | "arm64_linux"
  | "x86_64_linux"
  | "arm64_sequoia"
  | "arm64_tahoe";

function brewBottleKeys(): BrewBottleKey[] {
  const { os, cpu } = detectOsCpu();
  if (os === "darwin" && cpu === "arm64") {
    return ["arm64_sonoma", "arm64_sequoia", "arm64_tahoe"];
  }
  if (os === "darwin" && cpu === "x64") {
    return ["sonoma"];
  }
  if (os === "linux" && cpu === "arm64") {
    return ["arm64_linux"];
  }
  return ["x86_64_linux"];
}

async function fetchBrewBottleUrl(
  formula: string
): Promise<{ url: string; version: string; key: string }> {
  const response = await fetch(
    `https://formulae.brew.sh/api/formula/${encodeURIComponent(formula)}.json`
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve brew formula ${formula}`);
  }
  const data = (await response.json()) as {
    versions: { stable: string };
    bottle: { stable: { files: Record<string, { url: string }> } };
  };
  const files = data.bottle.stable.files;
  for (const key of brewBottleKeys()) {
    if (files[key]?.url) {
      return {
        url: files[key].url,
        version: data.versions.stable,
        key,
      };
    }
  }
  throw new Error(
    `No Homebrew bottle for ${formula} on this platform (${brewBottleKeys().join(", ")})`
  );
}

async function ensureMemcachedBinary(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<{ binaryPath: string; libDir: string }> {
  const basedir = join(options.installationDir, options.version);
  const binaryPath = join(basedir, "bin", "memcached");
  const libDir = join(basedir, "lib");
  if (existsSync(binaryPath)) {
    return { binaryPath, libDir };
  }

  options.onProgress?.(
    `Downloading Memcached ${options.version} (Homebrew bottles)…`
  );

  const formulas = ["memcached", "libevent", "openssl@3"];
  const work = makeTempDir("db-here-mc");
  try {
    mkdirSync(join(basedir, "bin"), { recursive: true });
    mkdirSync(libDir, { recursive: true });

    for (const formula of formulas) {
      const bottle = await fetchBrewBottleUrl(formula);
      options.onProgress?.(`Fetching ${formula} (${bottle.key})…`);
      const archive = join(work, `${formula.replaceAll("@", "_")}.tar.gz`);
      await downloadFile(bottle.url, archive, options.onProgress, {
        Authorization: "Bearer QQ==",
      });
      const extractDir = join(work, formula.replaceAll("@", "_"));
      mkdirSync(extractDir, { recursive: true });
      await extractTar(archive, extractDir);

      if (formula === "memcached") {
        const found = findFirst(
          extractDir,
          (name, full) => name === "memcached" && full.includes("/bin/")
        );
        if (!found) throw new Error("memcached binary missing from bottle");
        safeRename(found, binaryPath);
        chmodX(binaryPath);
      } else {
        // copy shared libs
        const libRoot = findFirst(extractDir, (name) => name === "lib");
        if (!libRoot) continue;
        for (const entry of readdirSync(libRoot)) {
          if (
            entry.includes("ssl") ||
            entry.includes("crypto") ||
            entry.includes("event")
          ) {
            const src = join(libRoot, entry);
            const dest = join(libDir, entry);
            if (!existsSync(dest)) {
              safeRename(src, dest);
            }
          }
        }
      }
    }

    if (process.platform === "darwin") {
      await relocateMacBinary(binaryPath, libDir);
    }

    options.onProgress?.(`Memcached ${options.version} ready`);
    return { binaryPath, libDir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function relocateMacBinary(
  binaryPath: string,
  libDir: string
): Promise<void> {
  // Fix dylib ids + references so no Homebrew prefix is required.
  const libs = readdirSync(libDir).filter((n) => n.endsWith(".dylib"));
  for (const name of libs) {
    const lib = join(libDir, name);
    try {
      await runCommand("install_name_tool", ["-id", `@loader_path/${name}`, lib]);
    } catch {
      // ignore
    }
    try {
      const { stdout } = await runCommand("otool", ["-L", lib]);
      for (const line of stdout.split("\n").slice(1)) {
        const dep = line.trim().split(" ")[0] ?? "";
        if (!dep || dep.startsWith("/usr/lib") || dep.startsWith("/System/")) {
          continue;
        }
        const base = dep.split("/").pop()!;
        if (libs.includes(base) || existsSync(join(libDir, base))) {
          try {
            await runCommand("install_name_tool", [
              "-change",
              dep,
              `@loader_path/${base}`,
              lib,
            ]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    try {
      await runCommand("codesign", ["-s", "-", "-f", lib]);
    } catch {
      // ignore
    }
  }

  try {
    const { stdout } = await runCommand("otool", ["-L", binaryPath]);
    for (const line of stdout.split("\n").slice(1)) {
      const dep = line.trim().split(" ")[0] ?? "";
      if (!dep || dep.startsWith("/usr/lib") || dep.startsWith("/System/")) {
        continue;
      }
      const base = dep.split("/").pop()!;
      if (existsSync(join(libDir, base))) {
        await runCommand("install_name_tool", [
          "-change",
          dep,
          `@loader_path/../lib/${base}`,
          binaryPath,
        ]);
      }
    }
    await runCommand("codesign", ["-s", "-", "-f", binaryPath]);
  } catch (error) {
    throw new Error(`Failed to relocate memcached binary: ${error}`);
  }

  try {
    chmodSync(binaryPath, 0o755);
  } catch {
    // ignore
  }
}

export async function startMemcachedHere(
  options: MemcachedOptions = {}
): Promise<MemcachedHereHandle> {
  const port = await resolvePort({
    port: options.port,
    defaultPort: DEFAULT_MEMCACHED_PORT,
    autoPort: options.autoPort,
  });
  const version =
    options.memcachedVersion ?? options.version ?? DEFAULT_MEMCACHED_VERSION;
  const memoryMb = options.memoryMb ?? DEFAULT_MEMCACHED_MEMORY_MB;
  const projectDir = resolve(options.projectDir ?? process.cwd());

  const instance = new MemcachedInstance({
    projectDir,
    dataDir: options.dataDir,
    configDir: options.configDir,
    installationDir: options.installationDir,
    version,
    port,
    memoryMb,
    onProgress: (m) => console.error(m),
  });

  await instance.start();

  const connectionString = `memcached://127.0.0.1:${port}`;

  return wrapEngineHandle({
    engine: "memcached",
    instance,
    connectionString,
    databaseConnectionString: connectionString,
    database: options.database ?? "0",
    port,
    username: "",
    serverVersion: version,
    common: options,
    stopInstance: (i) => i.stop(),
    cleanupInstance: (i) => i.cleanup(),
  });
}

export function getPreStartMemcachedState(projectDir?: string) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "memcached"
  );
  return {
    dataDir: paths.data,
    hasData: existsSync(join(paths.config, "memcached.env")),
    localDir: paths.displayRoot,
    installedVersion: existsSync(
      join(paths.bin, DEFAULT_MEMCACHED_VERSION, "bin", "memcached")
    )
      ? DEFAULT_MEMCACHED_VERSION
      : "",
  };
}
