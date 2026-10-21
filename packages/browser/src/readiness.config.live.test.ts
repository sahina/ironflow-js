// @vitest-environment node
/**
 * Live test: the config group (#3003) through the browser client, which reads
 * config only (its write methods were removed, #1892 R-1), so a plain
 * fetch writes the data it reads. Skips unless IRONFLOW_READINESS_SEED is set;
 * `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness config — live server", () => {
  const server = process.env["IRONFLOW_TEST_SERVER"]!;
  const apiKey = process.env["IRONFLOW_TEST_API_KEY"]!;
  ironflow.configure({ serverUrl: server, auth: { apiKey } });
  const config = ironflow.configManager();

  const write = async (method: string, name: string, body?: unknown): Promise<{ revision: number }> => {
    const res = await fetch(`${server}/api/v1/config/${name}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status).toBeLessThan(300);
    return res.status === 204 ? { revision: 0 } : ((await res.json()) as { revision: number });
  };

  it("config-read", async () => {
    const name = `browsercfg${Date.now()}`;
    // The non-ASCII value proves the data survives as UTF-8.
    const data = { a: 1, s: "José", nested: { k: [1, 2] } };
    const set = await write("POST", name, data);
    try {
      const got = await config.get(name);
      expect(got).toMatchObject({ name, data, revision: set.revision });
      expect(got.updatedAt).toBeTruthy();

      // List gives the name, revision and time, not the data.
      const find = async () => (await config.list()).find((e) => e.name === name);
      const entry = await find();
      expect(entry).toMatchObject({ name, revision: set.revision });
      expect(entry?.updatedAt).toBeTruthy();
      expect(entry).not.toHaveProperty("data");

      const patched = await write("PATCH", name, { b: true });
      expect(patched.revision).toBeGreaterThan(set.revision);
      expect(await config.get(name)).toMatchObject({ data: { ...data, b: true }, revision: patched.revision });
      expect((await find())?.revision).toBe(patched.revision);
    } finally {
      await write("DELETE", name);
    }
    // The config client sets no status on its errors, so the message tells not-found.
    await expect(config.get(name)).rejects.toThrow(/config not found/);
    expect((await config.list()).map((e) => e.name)).not.toContain(name);
  });
});
