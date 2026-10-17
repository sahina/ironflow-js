/**
 * Live test: KV and config watch against a real engine (#2949).
 * Skips unless IRONFLOW_TEST_SERVER is set; `make test-watch-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];
// Outlasts any read deadline a watcher might poll with.
const IDLE_GAP_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns watch callbacks into awaitable events; an error rejects the next wait. */
function queue<T>() {
  const items: T[] = [];
  let error: Error | undefined;
  let wake: (() => void) | undefined;
  return {
    push: (item: T) => { items.push(item); wake?.(); },
    fail: (err: Error) => { error = err; wake?.(); },
    async next(what: string): Promise<T> {
      const deadline = Date.now() + 10_000;
      while (items.length === 0) {
        if (error) throw error;
        if (Date.now() > deadline) throw new Error(`${what}: no event in 10s`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 100); });
      }
      return items.shift()!;
    },
  };
}

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

describe.skipIf(!SERVER)("watch — live server", () => {
  const client = new IronflowClient({ serverUrl: SERVER!, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
  const suffix = `${Date.now()}`;

  it("kv-watch replay, put, delete", async () => {
    const name = `nodewatch${suffix}`;
    await client.kv().createBucket({ name });
    const bucket = client.kv().bucket(name);
    const pre = await bucket.put("pre", { v: 0 });
    const q = queue<import("@ironflow/core").KVWatchEvent>();
    const w = bucket.watch({ onUpdate: q.push, onError: q.fail });
    try {
      const replay = await q.next("replay");
      expect(replay).toMatchObject({ key: "pre", operation: "put", revision: pre.revision, bucket: name });
      expect(JSON.parse(decode(replay.value))).toEqual({ v: 0 });

      await sleep(IDLE_GAP_MS);
      const put = await bucket.put("user.a", { v: 1, s: "é" });
      const got = await q.next("put");
      expect(got).toMatchObject({ key: "user.a", operation: "put", revision: put.revision });
      expect(JSON.parse(decode(got.value))).toEqual({ v: 1, s: "é" });

      await bucket.delete("user.a");
      const del = await q.next("delete");
      expect(del).toMatchObject({ key: "user.a", operation: "delete", value: "" });
      expect(del.revision).toBeGreaterThan(put.revision);
    } finally {
      w.stop();
    }
  });

  it("kv-watch key filter", async () => {
    const name = `nodewatchf${suffix}`;
    await client.kv().createBucket({ name });
    const bucket = client.kv().bucket(name);
    const q = queue<import("@ironflow/core").KVWatchEvent>();
    const w = bucket.watch({ onUpdate: q.push, onError: q.fail }, { key: "user.*" });
    try {
      await sleep(500);
      await bucket.put("other.x", 1);
      await bucket.put("user.b", 2);
      const got = await q.next("filtered");
      expect(got.key).toBe("user.b");
      expect(decode(got.value)).toBe("2");
    } finally {
      w.stop();
    }
  });

  it("kv-watch missing bucket reports the server's error", async () => {
    const q = queue<import("@ironflow/core").KVWatchEvent>();
    const w = client.kv().bucket(`nodenosuch${suffix}`).watch({ onUpdate: q.push, onError: q.fail });
    try {
      await expect(q.next("error")).rejects.toThrow("bucket not found");
    } finally {
      w.stop();
    }
  });

  it("config-watch replay, set, patch, delete", async () => {
    const name = `nodewatchcfg${suffix}`;
    const cfg = client.config();
    const pre = await cfg.set(name, { a: 1 });
    const q = queue<import("@ironflow/core").ConfigWatchEvent>();
    const w = cfg.watch(name, { onUpdate: q.push, onError: q.fail });
    try {
      const replay = await q.next("replay");
      expect(replay).toMatchObject({ name, data: { a: 1 }, revision: pre.revision });
      expect(replay.updatedAt).toMatch(/Z$/);

      await sleep(IDLE_GAP_MS);
      const set = await cfg.set(name, { a: 2, s: "é" });
      expect(await q.next("set")).toMatchObject({ data: { a: 2, s: "é" }, revision: set.revision });
      await cfg.patch(name, { b: true });
      expect((await q.next("patch")).data).toEqual({ a: 2, s: "é", b: true });
      await cfg.delete(name);
      expect((await q.next("delete")).data).toBeNull();
    } finally {
      w.stop();
    }
  });
});
