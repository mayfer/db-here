/**
 * CLI --version helpers: package version, and parse pin values.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string[]} argv  hideBin(process.argv)
 * @returns {{ present: boolean, value: string | undefined }}
 */
export function parseVersionFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      const next = argv[i + 1];
      // Value only if it looks like a version pin, not another flag/engine name.
      if (next && !next.startsWith("-") && looksLikeVersion(next)) {
        return { present: true, value: next };
      }
      return { present: true, value: undefined };
    }
    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length);
      return { present: true, value: value.length > 0 ? value : undefined };
    }
  }
  return { present: false, value: undefined };
}

function looksLikeVersion(value) {
  return (
    value === "latest" ||
    /^\d/.test(value) ||
    /^v\d/i.test(value) ||
    /^RELEASE\./i.test(value)
  );
}

export function packageVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    );
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
