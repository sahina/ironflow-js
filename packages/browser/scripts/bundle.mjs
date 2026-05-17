#!/usr/bin/env node
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");
const bundleDir = join(rootDir, "dist-bundle");

// Clean and create bundle directory
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

// Bundle with esbuild - inline @ironflow/core but externalize other deps
await esbuild.build({
  entryPoints: [join(distDir, "index.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(bundleDir, "index.js"),
  sourcemap: true,
  // Keep external packages that should be installed by consumer
  external: [
    "@bufbuild/protobuf",
    "@connectrpc/connect",
    "@connectrpc/connect-web",
    "zod",
  ],
});

// Copy type definitions recursively
function copyDtsFiles(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDtsFiles(srcPath, destPath);
    } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map')) {
      cpSync(srcPath, destPath);
    }
  }
}

copyDtsFiles(distDir, bundleDir);

// Update package.json for the bundle
const pkgPath = join(rootDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

// Remove @ironflow/core from dependencies since it's bundled
// Keep the workspace:* reference types working by keeping @ironflow/core as a dev/peer dep for types only
const bundlePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": {
      types: "./index.d.ts",
      import: "./index.js",
    },
  },
  sideEffects: false,
  dependencies: {
    "@bufbuild/protobuf": pkg.dependencies["@bufbuild/protobuf"],
    "@connectrpc/connect": pkg.dependencies["@connectrpc/connect"],
    "@connectrpc/connect-web": pkg.dependencies["@connectrpc/connect-web"],
    "zod": pkg.dependencies["zod"],
    // Include @ironflow/core types - consumer needs to install it for types
  },
  peerDependencies: {
    "@ironflow/core": pkg.version, // Same version for types compatibility
  },
  peerDependenciesMeta: {
    "@ironflow/core": {
      optional: true, // Runtime doesn't need it (bundled), but types do
    },
  },
  engines: pkg.engines,
  keywords: pkg.keywords,
  author: pkg.author,
  license: pkg.license,
};

writeFileSync(
  join(bundleDir, "package.json"),
  JSON.stringify(bundlePkg, null, 2)
);

// Copy README
cpSync(join(rootDir, "README.md"), join(bundleDir, "README.md"));

console.log("Bundle created successfully in dist-bundle/");
console.log("Files:", readdirSync(bundleDir));
