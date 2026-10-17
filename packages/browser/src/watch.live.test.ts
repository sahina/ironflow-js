// @vitest-environment node
/**
 * Live test: KV watch and config watch (over the system.config topics) against a
 * real engine (#2949). Skips unless IRONFLOW_TEST_SERVER is set;
 * `make test-watch-live` sets it.
 */
import { describe, expect, it } from "vitest";
import type { ConfigWatchEvent, KVWatchEvent } from "@ironflow/core";
import { ironflow } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];
const KEY = process.env["IRONFLOW_TEST_API_KEY"];
// Outlasts any read deadline a watcher might poll with.
const IDLE_GAP_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns watch callbacks into awaitable events; an error rejects the next wait. */
function queue<T>() {
  const items: T[] = [];
  let error: Error | undefined;
  return {
    push: (item: T) => { items.push(item); },
    fail: (err: Error) => { error = err; },
    async next(what: string): Promise<T> {
      const deadline = Date.now() + 10_000;
      while (items.length === 0) {
        if (error) throw error;
        if (Date.now() > deadline) throw new Error(`${what}: no event in 10s`);
        await sleep(50);
      }
      return items.shift()!;
    },
  };
}

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** The browser SDK cannot write config, so the test writes it over REST. */
async function configWrite(method: "POST" | "PATCH" | "DELETE", name: string, body?: Record<string, unknown>) {
  const res = await fetch(`${SERVER}/api/v1/config/${encodeURIComponent(name)}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  expect(res.status).toBe(method === "DELETE" ? 204 : 200);
  return method === "DELETE" ? undefined : ((await res.json()) as { revision: number });
}

describe.skipIf(!SERVER)("watch — live server", () => {
  const client = ironflow;
  client.configure({ serverUrl: SERVER!, auth: { apiKey: KEY } });
  const suffix = `${Date.now()}`;

  it("kv-watch replay, put, delete", async () => {
    const name = `browserwatch${suffix}`;
    await client.kv().createBucket({ name });
    const bucket = client.kv().bucket(name);
    const pre = await bucket.put("pre", { v: 0 });
    const q = queue<KVWatchEvent>();
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
    const name = `browserwatchf${suffix}`;
    await client.kv().createBucket({ name });
    const bucket = client.kv().bucket(name);
    const q = queue<KVWatchEvent>();
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
    const q = queue<KVWatchEvent>();
    const w = client.kv().bucket(`browsernosuch${suffix}`).watch({ onUpdate: q.push, onError: q.fail });
    try {
      await expect(q.next("error")).rejects.toThrow("bucket not found");
    } finally {
      w.stop();
    }
  });

  it("config-watch set, patch and delete over the system.config topics", async () => {
    const name = `browserwatchcfg${suffix}`;
    const q = queue<ConfigWatchEvent>();
    const sub = await client.configManager().watch(name, { onUpdate: q.push, onError: q.fail });
    try {
      await sleep(IDLE_GAP_MS);
      const set = (await configWrite("POST", name, { a: 2, s: "é" }))!;
      expect(await q.next("set")).toMatchObject({ type: "config_update", name, data: { a: 2, s: "é" }, revision: set.revision });
      const patch = (await configWrite("PATCH", name, { b: true }))!;
      const got = await q.next("patch");
      expect(got).toMatchObject({ data: { a: 2, s: "é", b: true }, revision: patch.revision });
      expect(got.updatedAt).toMatch(/Z$/);
      expect(await client.configManager().get(name)).toMatchObject({ data: { a: 2, s: "é", b: true }, revision: patch.revision });
      await configWrite("DELETE", name);
      const del = await q.next("delete");
      expect(del).toMatchObject({ type: "config_update", name, data: null });
      expect(del.revision).toBeGreaterThan(patch.revision);
    } finally {
      sub.unsubscribe();
    }
  });
});
