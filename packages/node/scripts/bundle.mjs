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
mkdirSync(join(bundleDir, "internal"), { recursive: true });

// Entry points matching the exports
const entryPoints = [
  { in: join(distDir, "index.js"), out: "index" },
  { in: join(distDir, "serve.js"), out: "serve" },
  { in: join(distDir, "worker.js"), out: "worker" },
  { in: join(distDir, "worker-streaming.js"), out: "worker-streaming" },
];

// Bundle each entry point
for (const entry of entryPoints) {
  await esbuild.build({
    entryPoints: [entry.in],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: join(bundleDir, `${entry.out}.js`),
    sourcemap: true,
    // Externalize node built-ins and optional deps
    external: [
      "@bufbuild/protobuf",
      "@connectrpc/connect",
      "@connectrpc/connect-node",
      "zod",
      "node:*",
    ],
  });
}

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
    "./serve": {
      types: "./serve.d.ts",
      import: "./serve.js",
    },
    "./worker": {
      types: "./worker.d.ts",
      import: "./worker.js",
    },
    "./worker-streaming": {
      types: "./worker-streaming.d.ts",
      import: "./worker-streaming.js",
    },
  },
  sideEffects: false,
  dependencies: {
    "zod": pkg.dependencies["zod"],
  },
  optionalDependencies: pkg.optionalDependencies,
  peerDependencies: {
    "@ironflow/core": pkg.version,
  },
  peerDependenciesMeta: {
    "@ironflow/core": {
      optional: true,
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
