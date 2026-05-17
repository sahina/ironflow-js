#!/usr/bin/env node
// Regenerates src/version.ts from package.json so the SDK reports the correct
// version to the server during worker registration.
//
// Runs automatically as the `prebuild` npm script.

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const pkgPath = join(rootDir, "package.json");
const versionPath = join(rootDir, "src", "version.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const contents = `// Auto-generated from package.json by scripts/sync-version.mjs
// Do not edit manually; run \`pnpm build\` (or the prebuild hook) to regenerate.
export const SDK_VERSION = ${JSON.stringify(pkg.version)};
`;

const existing = (() => {
  try {
    return readFileSync(versionPath, "utf-8");
  } catch {
    return "";
  }
})();

if (existing !== contents) {
  writeFileSync(versionPath, contents);
  console.log(`sync-version: wrote ${pkg.version} to src/version.ts`);
} else {
  console.log(`sync-version: ${pkg.version} already current`);
}
