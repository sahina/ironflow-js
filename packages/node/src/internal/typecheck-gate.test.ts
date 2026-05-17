/**
 * Drift-detection guard for issue #634.
 *
 * Asserts that the package's typecheck config (`tsconfig.json`) covers
 * EVERY test file present on disk under `src/**` and `tests/**`. Without
 * this guard, an `include`/`exclude` edit could silently drop test files
 * from the gate, letting type rot accumulate undetected.
 *
 * Uses `ts.parseJsonConfigFileContent` so the EFFECTIVE include set
 * after `extends` resolution and JSONC comment stripping is what's
 * checked, not a string-match against the raw file. Filesystem walk
 * is platform-agnostic (Node fs returns native separators; we
 * normalize to `/` before comparison).
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import * as fs from "node:fs";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const tsconfigPath = resolve(pkgRoot, "tsconfig.json");
const tsconfigBuildPath = resolve(pkgRoot, "tsconfig.build.json");

function effectiveFileNames(configPath: string): readonly string[] {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(configPath, raw);
  expect(parsed.error).toBeUndefined();

  const result = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    dirname(configPath),
    /*existingOptions*/ undefined,
    configPath
  );
  expect(result.errors.filter((e) => e.code !== 18002 && e.code !== 18003)).toEqual([]);
  return result.fileNames;
}

function normalize(p: string): string {
  return p.split(sep).join("/");
}

function walk(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walk(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

describe("typecheck gate (issue #634)", () => {
  it("tsconfig.json covers every src/**/*.test.ts that exists on disk", () => {
    const included = new Set(effectiveFileNames(tsconfigPath).map(normalize));
    const onDisk = walk(resolve(pkgRoot, "src"), (p) => p.endsWith(".test.ts")).map(
      normalize
    );

    expect(onDisk.length).toBeGreaterThan(0);
    const missing = onDisk.filter((f) => !included.has(f));
    expect(missing).toEqual([]);
  });

  it("tsconfig.json covers every tests/**/*.test.ts that exists on disk", () => {
    const included = new Set(effectiveFileNames(tsconfigPath).map(normalize));
    const onDisk = walk(resolve(pkgRoot, "tests"), (p) => p.endsWith(".test.ts")).map(
      normalize
    );

    expect(onDisk.length).toBeGreaterThan(0);
    const missing = onDisk.filter((f) => !included.has(f));
    expect(missing).toEqual([]);
  });

  it("tsconfig.json covers every src/**/__type_tests__/**/*.ts that exists on disk", () => {
    const included = new Set(effectiveFileNames(tsconfigPath).map(normalize));
    const onDisk = walk(
      resolve(pkgRoot, "src"),
      (p) => p.includes(`${sep}__type_tests__${sep}`) && p.endsWith(".ts")
    ).map(normalize);

    expect(onDisk.length).toBeGreaterThan(0);
    const missing = onDisk.filter((f) => !included.has(f));
    expect(missing).toEqual([]);
  });

  it("tsconfig.build.json EXCLUDES every test file on disk from emit", () => {
    const included = new Set(effectiveFileNames(tsconfigBuildPath).map(normalize));
    const offenders: string[] = [];

    for (const f of included) {
      if (
        /\.test\.ts$/.test(f) ||
        f.includes("/__type_tests__/") ||
        f.includes("/tests/")
      ) {
        offenders.push(f);
      }
    }

    expect(offenders).toEqual([]);
  });
});
