import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDiscovery } from "./discovery.js";

const doc = (o: object = {}) => JSON.stringify({ version: 1, url: "http://127.0.0.1:52431", ...o });

// Virtual fs: map of absolute path -> text.
function run(files: Record<string, string>, env: Record<string, string | undefined> = {}, cwd = "/a/b/c") {
  return resolveDiscovery({ env, cwd, readFile: (p) => files[p] ?? null });
}
const F = "/a/b/c/.ironflow/engine.json";

describe("resolveDiscovery", () => {
  it("fills URL vars and optional key/env", () => {
    expect(run({ [F]: doc({ api_key: "ifkey_x", environment: "dev" }) })).toEqual({
      IRONFLOW_SERVER_URL: "http://127.0.0.1:52431",
      IRONFLOW_API_KEY: "ifkey_x",
      IRONFLOW_ENV: "dev",
    });
  });

  it("api_key is optional", () => {
    expect(run({ [F]: doc() })).not.toHaveProperty("IRONFLOW_API_KEY");
  });

  it.each(["IRONFLOW_SERVER_URL", "IRONFLOW_API_KEY"])("no-op when %s is set", (name) => {
    expect(run({ [F]: doc({ api_key: "k" }) }, { [name]: "x" })).toBeUndefined();
  });

  it("treats empty variables as unset", () => {
    expect(run({ [F]: doc() }, { IRONFLOW_SERVER_URL: "", IRONFLOW_API_KEY: "" })).toBeDefined();
  });

  it("IRONFLOW_NO_DISCOVERY=1 disables", () => {
    expect(run({ [F]: doc() }, { IRONFLOW_NO_DISCOVERY: "1" })).toBeUndefined();
  });

  it("nearest parent wins and stops at the first file found", () => {
    const files = {
      "/a/.ironflow/engine.json": doc({ url: "http://127.0.0.1:1" }),
      "/a/b/.ironflow/engine.json": doc({ url: "http://127.0.0.1:2" }),
    };
    expect(run(files)?.IRONFLOW_SERVER_URL).toBe("http://127.0.0.1:2");
    // An invalid nearer file hides a valid farther one.
    expect(run({ ...files, "/a/b/.ironflow/engine.json": "{" })).toBeUndefined();
  });

  it("finds a file at the filesystem root", () => {
    expect(run({ "/.ironflow/engine.json": doc() })).toBeDefined();
  });

  it.each([
    "http://localhost:1",
    "http://127.1.2.3:1",
    "http://[::1]:1",
  ])("accepts loopback %s", (url) => {
    expect(run({ [F]: doc({ url }) })?.IRONFLOW_SERVER_URL).toBe(url);
  });

  it.each([
    "https://127.0.0.1:1",
    "http://example.com:1",
    "http://0.0.0.0:1",
    "http://10.0.0.1:1",
    "http://[::2]:1",
    "http://127.0.0.1.evil.com",
    "not a url",
  ])("ignores %s", (url) => {
    expect(run({ [F]: doc({ url }) })).toBeUndefined();
  });

  it("ignores version != 1, missing url, non-objects, invalid JSON", () => {
    expect(run({ [F]: doc({ version: 2 }) })).toBeUndefined();
    expect(run({ [F]: JSON.stringify({ version: 1 }) })).toBeUndefined();
    expect(run({ [F]: "null" })).toBeUndefined();
    expect(run({ [F]: "{nope" })).toBeUndefined();
  });

  it("ignores a file over 64 KiB", () => {
    expect(run({ [F]: doc({ pad: "x".repeat(64 * 1024) }) })).toBeUndefined();
  });

  it("environment fills IRONFLOW_ENV only when unset", () => {
    const files = { [F]: doc({ environment: "dev" }) };
    expect(run(files)?.IRONFLOW_ENV).toBe("dev");
    expect(run(files, { IRONFLOW_ENV: "prod" })).not.toHaveProperty("IRONFLOW_ENV");
  });
});

describe("constructors pick up the discovery file", () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ironflow-discovery-"));
    mkdirSync(join(dir, ".ironflow"));
    writeFileSync(join(dir, ".ironflow", "engine.json"), doc({ url: "http://127.0.0.1:52431", api_key: "ifkey_t" }));
    for (const k of ["IRONFLOW_SERVER_URL", "IRONFLOW_API_KEY", "IRONFLOW_ENV", "IRONFLOW_NO_DISCOVERY"]) {
      delete process.env[k];
    }
    process.chdir(dir);
    vi.resetModules(); // fresh once-per-process flag
  });

  afterEach(() => {
    process.chdir(cwd);
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it("IronflowClient reads URL and key from the file", async () => {
    const { IronflowClient } = await import("../client.js");
    const client = new IronflowClient({}) as unknown as { serverUrl: string; apiKey?: string };
    expect(client.serverUrl).toBe("http://127.0.0.1:52431");
    expect(client.apiKey).toBe("ifkey_t");
  });
});
