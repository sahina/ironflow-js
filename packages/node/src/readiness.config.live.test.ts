/**
 * Live test: the config group (#3003) through the Node client. The writes are
 * set-up for the reads; config-write is proven by watch.live.test.ts. Skips
 * unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness config — live server", () => {
  const config = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  }).config();

  it("config-read", async () => {
    const name = `nodecfg${Date.now()}`;
    // The non-ASCII value proves the data survives as UTF-8.
    const data = { a: 1, s: "José", nested: { k: [1, 2] } };
    const set = await config.set(name, data);
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

      const patched = await config.patch(name, { b: true });
      expect(patched.revision).toBeGreaterThan(set.revision);
      expect(await config.get(name)).toMatchObject({ data: { ...data, b: true }, revision: patched.revision });
      expect((await find())?.revision).toBe(patched.revision);
    } finally {
      await config.delete(name);
    }
    // The config client sets no status on its errors, so the message tells not-found.
    await expect(config.get(name)).rejects.toThrow(/config not found/);
    expect((await config.list()).map((e) => e.name)).not.toContain(name);
  });
});
