import { arch, platform } from "node:os";

export type MysqlPlatformId =
  | "macos15-arm64"
  | "macos15-x86_64"
  | "linux-glibc2.28-x86_64"
  | "linux-glibc2.28-aarch64";

export interface MysqlPlatformInfo {
  id: MysqlPlatformId;
  archiveExt: ".tar.gz" | ".tar.xz";
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
}

/**
 * Official MySQL Community Server generic binary platforms we support.
 * These tarballs ship their own shared libraries and need no package manager
 * or system MySQL install.
 */
export function detectMysqlPlatform(): MysqlPlatformInfo {
  const os = platform();
  const cpu = arch();

  if (os === "darwin") {
    if (cpu === "arm64") {
      return {
        id: "macos15-arm64",
        archiveExt: ".tar.gz",
        os: "darwin",
        cpu: "arm64",
      };
    }
    if (cpu === "x64") {
      return {
        id: "macos15-x86_64",
        archiveExt: ".tar.gz",
        os: "darwin",
        cpu: "x64",
      };
    }
  }

  if (os === "linux") {
    if (cpu === "x64") {
      return {
        id: "linux-glibc2.28-x86_64",
        archiveExt: ".tar.xz",
        os: "linux",
        cpu: "x64",
      };
    }
    if (cpu === "arm64") {
      return {
        id: "linux-glibc2.28-aarch64",
        archiveExt: ".tar.xz",
        os: "linux",
        cpu: "arm64",
      };
    }
  }

  throw new Error(
    `Unsupported platform for MySQL: ${os}/${cpu}. Supported: macOS (arm64, x64) and Linux (x64, arm64).`
  );
}

export function mysqlArchiveFileName(
  version: string,
  platformInfo: MysqlPlatformInfo
): string {
  return `mysql-${version}-${platformInfo.id}${platformInfo.archiveExt}`;
}

export function mysqlDownloadUrl(
  version: string,
  platformInfo: MysqlPlatformInfo
): string {
  const majorMinor = version.split(".").slice(0, 2).join(".");
  const fileName = mysqlArchiveFileName(version, platformInfo);
  // Oracle CDN — stable direct download, no login / license form.
  return `https://cdn.mysql.com/Downloads/MySQL-${majorMinor}/${fileName}`;
}
