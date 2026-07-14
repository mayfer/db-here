/**
 * Detect whether a binary matches the current process architecture.
 * Used to reject wrong-arch caches (common when sharing install dirs
 * across machines, or after a botched download).
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type CpuArch = "arm64" | "x64" | "unknown";

export function processCpuArch(): CpuArch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return "unknown";
}

/**
 * Best-effort arch from ELF (Linux) or Mach-O (macOS) header.
 * Returns "unknown" if the file is missing or not a recognized binary.
 */
export function binaryCpuArch(path: string): CpuArch {
  if (!existsSync(path)) return "unknown";
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size < 20) return "unknown";
    const buf = readFileSync(path);

    // ELF: 0x7f 'E' 'L' 'F'
    if (
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    ) {
      // e_machine at offset 18 (little-endian for our targets)
      const machine = buf.readUInt16LE(18);
      if (machine === 0xb7) return "arm64"; // EM_AARCH64
      if (machine === 0x3e) return "x64"; // EM_X86_64
      return "unknown";
    }

    // Mach-O 64-bit little-endian: 0xFEEDFACF
    if (buf.readUInt32LE(0) === 0xfeed_facf) {
      const cputype = buf.readUInt32LE(4);
      // CPU_TYPE_ARM64 = 0x0100000c, CPU_TYPE_X86_64 = 0x01000007
      if (cputype === 0x0100_000c) return "arm64";
      if (cputype === 0x0100_0007) return "x64";
      return "unknown";
    }

    // Fat Mach-O / other — don't guess
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function binaryMatchesHost(path: string): boolean {
  const host = processCpuArch();
  if (host === "unknown") return true;
  const bin = binaryCpuArch(path);
  if (bin === "unknown") return true; // can't tell — let the OS decide
  return bin === host;
}

/**
 * Find postgres/initdb under an installation tree and wipe version dirs
 * whose binaries don't match the host CPU.
 * Returns true if anything was removed.
 */
export function wipeMismatchedPostgresInstalls(installationDir: string): boolean {
  if (!existsSync(installationDir)) return false;
  let removed = false;
  let entries;
  try {
    entries = readdirSync(installationDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionDir = join(installationDir, entry.name);
    const candidates = [
      join(versionDir, "bin", "postgres"),
      join(versionDir, "bin", "initdb"),
      join(versionDir, "postgres"),
      join(versionDir, "initdb"),
    ];
    const binary = candidates.find((p) => existsSync(p));
    if (!binary) continue;
    if (!binaryMatchesHost(binary)) {
      rmSync(versionDir, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}
