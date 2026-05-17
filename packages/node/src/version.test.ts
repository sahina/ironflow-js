import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./version.js";

describe("SDK_VERSION", () => {
  it("matches the version in package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("is not the stale 0.1.0 literal (issue #461)", () => {
    expect(SDK_VERSION).not.toBe("0.1.0");
  });
});
