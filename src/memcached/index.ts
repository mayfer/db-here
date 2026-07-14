import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
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
/** Default memcached release (source build on Linux; brew bottle on macOS). */
export const DEFAULT_MEMCACHED_VERSION = "1.6.38";
export const DEFAULT_MEMCACHED_MEMORY_MB = 64;
const LIBEVENT_VERSION = "2.1.12-stable";

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
    dataRoot?: string;
    dataDir?: string;
    configDir?: string;
    installationDir?: string;
    version: string;
    port: number;
    memoryMb: number;
    onProgress?: (m: string) => void;
  }) {
    const paths = getEnginePaths(opts.projectDir, "memcached", opts.dataRoot);
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
    if (this.libDir && existsSync(this.libDir)) {
      if (process.platform === "linux") {
        env.LD_LIBRARY_PATH =
          this.libDir +
          (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
      } else if (process.platform === "darwin") {
        env.DYLD_LIBRARY_PATH =
          this.libDir +
          (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
      }
    }

    const stderrChunks: Buffer[] = [];
    this.process = spawnDetached(this.binaryPath, args, {
      env,
      stderr: "pipe",
    });

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

type BrewBottleKey =
  | "arm64_sonoma"
  | "sonoma"
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
  return ["arm64_sonoma"];
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

  // Homebrew Linux bottles need very new glibc (e.g. 2.38) and fail on
  // Amazon Linux / older distros. Build from source on Linux instead.
  if (process.platform === "linux") {
    return ensureMemcachedFromSource(options);
  }

  return ensureMemcachedFromBrew(options);
}

async function ensureMemcachedFromBrew(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<{ binaryPath: string; libDir: string }> {
  const basedir = join(options.installationDir, options.version);
  const binaryPath = join(basedir, "bin", "memcached");
  const libDir = join(basedir, "lib");

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

    await relocateMacBinary(binaryPath, libDir);
    options.onProgress?.(`Memcached ${options.version} ready`);
    return { binaryPath, libDir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Build memcached + libevent from official sources into the project bin tree.
 * Needs a C compiler and make once (standard on build hosts; not a package
 * install of memcached itself).
 */
async function ensureMemcachedFromSource(options: {
  installationDir: string;
  version: string;
  onProgress?: (m: string) => void;
}): Promise<{ binaryPath: string; libDir: string }> {
  const basedir = join(options.installationDir, options.version);
  const binaryPath = join(basedir, "bin", "memcached");
  const libDir = join(basedir, "lib");

  await assertBuildTools();

  options.onProgress?.(
    `Building Memcached ${options.version} from source (Linux; avoids Homebrew glibc)…`
  );

  const work = makeTempDir("db-here-mc-src");
  try {
    mkdirSync(basedir, { recursive: true });

    // 1) libevent
    const libeventUrl = `https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz`;
    const libeventArchive = join(work, "libevent.tar.gz");
    options.onProgress?.(`Downloading libevent ${LIBEVENT_VERSION}…`);
    await downloadFile(libeventUrl, libeventArchive, options.onProgress);
    await extractTar(libeventArchive, work);
    const libeventSrc = findFirst(
      work,
      (name) => name.startsWith("libevent-") && !name.endsWith(".tar.gz")
    );
    if (!libeventSrc || !existsSync(join(libeventSrc, "configure"))) {
      throw new Error("libevent source tree not found after extract");
    }
    options.onProgress?.(`Compiling libevent…`);
    await runCommand(
      join(libeventSrc, "configure"),
      [
        `--prefix=${basedir}`,
        "--disable-samples",
        "--disable-openssl",
        "--enable-shared",
      ],
      { cwd: libeventSrc }
    );
    await runCommand("make", ["-j", String(parallelJobs())], {
      cwd: libeventSrc,
    });
    await runCommand("make", ["install"], { cwd: libeventSrc });

    // 2) memcached
    const memUrl = `https://www.memcached.org/files/memcached-${options.version}.tar.gz`;
    const memArchive = join(work, "memcached.tar.gz");
    options.onProgress?.(
      `Downloading Memcached ${options.version} source…`
    );
    await downloadFile(memUrl, memArchive, options.onProgress);
    await extractTar(memArchive, work);
    const memSrc = findFirst(
      work,
      (name) =>
        name === `memcached-${options.version}` ||
        (name.startsWith("memcached-") && !name.endsWith(".tar.gz"))
    );
    if (!memSrc || !existsSync(join(memSrc, "configure"))) {
      throw new Error("memcached source tree not found after extract");
    }
    options.onProgress?.(`Compiling Memcached ${options.version}…`);
    await runCommand(
      join(memSrc, "configure"),
      [`--prefix=${basedir}`, `--with-libevent=${basedir}`],
      {
        cwd: memSrc,
        env: {
          ...process.env,
          CPPFLAGS: `-I${join(basedir, "include")} ${process.env.CPPFLAGS ?? ""}`.trim(),
          LDFLAGS: `-L${libDir} ${process.env.LDFLAGS ?? ""}`.trim(),
          LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ""),
        },
      }
    );
    await runCommand("make", ["-j", String(parallelJobs())], { cwd: memSrc });
    await runCommand("make", ["install"], { cwd: memSrc });

    if (!existsSync(binaryPath)) {
      throw new Error(`memcached missing after build: ${binaryPath}`);
    }
    chmodX(binaryPath);
    options.onProgress?.(`Memcached ${options.version} ready (source build)`);
    return { binaryPath, libDir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function assertBuildTools(): Promise<void> {
  const missing: string[] = [];
  for (const tool of ["cc", "make"]) {
    try {
      await runCommand("sh", ["-c", `command -v ${tool}`]);
    } catch {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Memcached on Linux is built from source (Homebrew bottles need glibc ≥ 2.38). ` +
        `Missing build tools: ${missing.join(", ")}. ` +
        `Install a C compiler and make, then retry (e.g. Amazon Linux: sudo dnf install -y gcc make).`
    );
  }
}

function parallelJobs(): number {
  const n = cpus()?.length ?? 2;
  return Math.max(1, Math.min(8, Number(n) || 2));
}

async function relocateMacBinary(
  binaryPath: string,
  libDir: string
): Promise<void> {
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
    dataRoot: options.dataRoot,
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

export function getPreStartMemcachedState(
  projectDir?: string,
  dataRoot?: string
) {
  const paths = getEnginePaths(
    resolve(projectDir ?? process.cwd()),
    "memcached",
    dataRoot
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
