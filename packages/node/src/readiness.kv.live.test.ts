/**
 * Live test: the kv group (#3003) through the Node client. Each test makes its
 * own bucket. Watch is in watch.live.test.ts. Skips unless
 * IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness kv — live server", () => {
  const kv = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  }).kv();

  it("kv-buckets", async () => {
    const name = `nodekvb${Date.now()}`;
    const created = await kv.createBucket({ name, description: "readiness", ttlSeconds: 3600, history: 3 });
    try {
      expect(created).toMatchObject({ name, description: "readiness", ttl_seconds: 3600, history: 3, values: 0 });
      expect(created.created_at).toBeTruthy();

      await kv.bucket(name).put("k", { v: 1 });
      const info = await kv.getBucketInfo(name);
      expect(info).toMatchObject({ name, description: "readiness", ttl_seconds: 3600, history: 3, values: 1 });
      expect(info.bytes).toBeGreaterThan(0);
      expect(info.created_at).toBe(created.created_at);

      expect((await kv.listBuckets()).find((b) => b.name === name)).toMatchObject({ name, values: 1 });
    } finally {
      await kv.deleteBucket(name);
    }
    await expect(kv.getBucketInfo(name)).rejects.toMatchObject({ status: 404 });
    expect((await kv.listBuckets()).map((b) => b.name)).not.toContain(name);
  });

  it("kv-keys", async () => {
    const name = `nodekvk${Date.now()}`;
    await kv.createBucket({ name });
    try {
      const bucket = kv.bucket(name);
      // The non-ASCII value proves the bytes survive the base64 round trip.
      const { revision } = await bucket.put("user.a", { who: "José" });
      expect(revision).toBeGreaterThan(0);
      expect(await bucket.getJSON("user.a")).toMatchObject({
        key: "user.a",
        value: { who: "José" },
        revision,
        operation: "put",
      });

      // Create refuses an existing key; update is a compare-and-swap on the revision.
      await expect(bucket.create("user.a", 1)).rejects.toMatchObject({ status: 412 });
      const next = await bucket.update("user.a", 2, revision);
      expect(next.revision).toBeGreaterThan(revision);
      await expect(bucket.update("user.a", 3, revision)).rejects.toMatchObject({ status: 412 });
      expect(await bucket.getJSON("user.a")).toMatchObject({ value: 2, revision: next.revision });

      await bucket.create("user.b", {});
      await bucket.create("other.c", {});
      expect((await bucket.listKeys()).sort()).toEqual(["other.c", "user.a", "user.b"]);
      expect((await bucket.listKeys("user.*")).sort()).toEqual(["user.a", "user.b"]);

      // Delete leaves a tombstone: the key reads as missing and drops out of the list.
      await bucket.delete("user.a");
      await expect(bucket.get("user.a")).rejects.toMatchObject({ status: 404 });
      await bucket.purge("user.b");
      expect(await bucket.listKeys()).toEqual(["other.c"]);
    } finally {
      await kv.deleteBucket(name);
    }
  });
});
