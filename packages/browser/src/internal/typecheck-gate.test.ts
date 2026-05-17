/**
 * Drift-detection guard for issue #643.
 *
 * Asserts that the package's typecheck config (`tsconfig.json`) covers
 * EVERY test file present on disk anywhere in the package (matches
 * `*.test.ts`, `*.spec.ts`, or anything under `__type_tests__/`).
 * Without this guard, an `include`/`exclude` edit could silently drop
 * test files from the gate, letting type rot accumulate undetected.
 *
 * Walks the whole package root (excluding `node_modules`/`dist`/`dist-bundle`)
 * so the gate stays valid even if test files migrate to new top-level
 * locations later.
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
  if (parsed.error) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  }

  const result = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    dirname(configPath),
    /*existingOptions*/ undefined,
    configPath
  );
  const errors = result.errors
    .filter((e) => e.code !== 18002 && e.code !== 18003)
    .map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"));
  expect(errors).toEqual([]);
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
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "dist-bundle"
      ) {
        continue;
      }
      out.push(...walk(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(p: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(p) ||
    p.includes(`${sep}__type_tests__${sep}`)
  );
}

describe("typecheck gate (issue #643)", () => {
  it("tsconfig.json covers every test file that exists on disk", () => {
    const included = new Set(effectiveFileNames(tsconfigPath).map(normalize));
    const onDisk = walk(pkgRoot, isTestFile).map(normalize);

    expect(onDisk.length).toBeGreaterThan(0);
    const missing = onDisk.filter((f) => !included.has(f));
    expect(missing).toEqual([]);
  });

  it("tsconfig.build.json EXCLUDES every test file on disk from emit", () => {
    const included = new Set(effectiveFileNames(tsconfigBuildPath).map(normalize));
    const offenders: string[] = [];

    for (const f of included) {
      if (
        /\.(test|spec)\.tsx?$/.test(f) ||
        f.includes("/__type_tests__/") ||
        f.includes("/tests/")
      ) {
        offenders.push(f);
      }
    }

    expect(offenders).toEqual([]);
  });
});
