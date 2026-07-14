import { arch, platform } from "node:os";

/** conda-forge platform subdirs we support. */
export type CondaSubdir =
  | "osx-arm64"
  | "osx-64"
  | "linux-64"
  | "linux-aarch64";

export interface RedisPlatformInfo {
  subdir: CondaSubdir;
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
}

export function detectRedisPlatform(): RedisPlatformInfo {
  const os = platform();
  const cpu = arch();

  if (os === "darwin" && cpu === "arm64") {
    return { subdir: "osx-arm64", os: "darwin", cpu: "arm64" };
  }
  if (os === "darwin" && cpu === "x64") {
    return { subdir: "osx-64", os: "darwin", cpu: "x64" };
  }
  if (os === "linux" && cpu === "x64") {
    return { subdir: "linux-64", os: "linux", cpu: "x64" };
  }
  if (os === "linux" && cpu === "arm64") {
    return { subdir: "linux-aarch64", os: "linux", cpu: "arm64" };
  }

  throw new Error(
    `Unsupported platform for Redis: ${os}/${cpu}. Supported: macOS (arm64, x64) and Linux (x64, arm64).`
  );
}

/**
 * Pinned conda-forge package builds for redis-server + openssl.
 * These are official conda-forge builds with @rpath / relative lib loading
 * so we can keep everything under <dataRoot>/redis/ with no system install.
 */
export const DEFAULT_REDIS_VERSION = "7.4.7";
export const OPENSSL_PACKAGE_VERSION = "3.5.4";

/** redis-server package basename (without subdir/) per platform. */
export const REDIS_PACKAGE_BUILDS: Record<
  CondaSubdir,
  { redis: string; openssl: string }
> = {
  "osx-arm64": {
    redis: "redis-server-7.4.7-hd37bc49_0.conda",
    openssl: "openssl-3.5.4-h5503f6c_0.conda",
  },
  "osx-64": {
    redis: "redis-server-7.4.7-habe0402_0.conda",
    openssl: "openssl-3.5.4-h230baf5_0.conda",
  },
  "linux-64": {
    redis: "redis-server-7.4.7-h35e630c_0.conda",
    openssl: "openssl-3.5.4-h26f9b46_0.conda",
  },
  "linux-aarch64": {
    redis: "redis-server-7.4.7-h546c87b_0.conda",
    openssl: "openssl-3.5.4-h8e36d6e_0.conda",
  },
};

export function condaPackageUrl(subdir: CondaSubdir, fileName: string): string {
  return `https://conda.anaconda.org/conda-forge/${subdir}/${fileName}`;
}
