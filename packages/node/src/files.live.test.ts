/**
 * Live test: file storage round trip against a real server.
 * Skips unless IRONFLOW_TEST_SERVER is set; `make test-files-live` sets it.
 */
import { createHash, randomBytes } from "node:crypto";
import { ConflictError, PreconditionFailedError, UnsupportedMediaTypeError } from "@ironflow/core";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createFunction } from "./function.js";
import { createWorker } from "./worker.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];
const API_KEY = process.env["IRONFLOW_TEST_API_KEY"];

const waitFor = async <T>(poll: () => Promise<T | undefined>, ms: number, what: string): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await poll();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!SERVER)("file storage — live server", () => {
  it("put, event-triggered read, signed upload, move prefix, delete", async () => {
    const client = new IronflowClient({ serverUrl: SERVER!, apiKey: API_KEY });
    const files = client.files();
    const suffix = randomBytes(5).toString("hex");
    const bucketName = `live-${suffix}`;
    const fnId = `files-live-node-${suffix}`;
    await files.createBucket(bucketName, { emitEvents: true, allowSignedUrls: true });

    // Pinned to the event's etag, so a concurrent overwrite cannot change what it hashes.
    const fn = createFunction(
      { id: fnId, triggers: [{ event: "ironflow.file.created", expression: `data.bucket == '${bucketName}'` }] },
      async ({ event }) => {
        const d = event.data as { bucket: string; path: string; etag: string };
        const obj = await files.bucket(d.bucket).get(d.path, { ifMatch: d.etag });
        return { sha256: createHash("sha256").update(Buffer.from(await obj.arrayBuffer())).digest("hex") };
      },
    );
    const worker = createWorker({ serverUrl: SERVER!, apiKey: API_KEY, functions: [fn], logger: false });
    // start() resolves only when the worker stops, so it is not awaited.
    void worker.start().catch(() => {});
    try {
      await waitFor(
        async () => ((await client.listFunctions()) as Array<{ id: string }>).some((f) => f.id === fnId) || undefined,
        15000,
        "function registered",
      );

      const b = files.bucket(bucketName);
      const content = "hello from the live round trip";
      const want = createHash("sha256").update(content).digest("hex");
      const info = await b.put("in/a.txt", content, { contentType: "text/plain" });
      expect(info.sha256).toBe(want);

      const run = await waitFor(
        async () => {
          const { runs } = await client.listRuns({ functionId: fnId });
          const r = runs[0];
          if (r?.status === "failed") throw new Error(`run failed: ${r.error?.message}`);
          return r?.status === "completed" ? r : undefined;
        },
        10000,
        "file.created run to complete",
      );
      expect((run.output as { sha256: string }).sha256).toBe(want);

      const up = await b.signUpload("in/b.txt", { maxBytes: 1024, contentType: "text/plain" });
      console.log(`signed URL: ${up.url.split("?")[0]}`);
      expect(up.url.startsWith(`${SERVER}/api/v1/files/signed?token=`)).toBe(true);
      // No Authorization header: the token alone grants the write.
      const put = await fetch(up.url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "signed body" });
      expect(put.status).toBe(201);
      expect((await b.info("in/b.txt")).size).toBe("signed body".length);

      expect(await b.movePrefix("in/", "archive/")).toBe(2);
      await b.delete("archive/a.txt");
      await b.delete("archive/b.txt");
      await files.deleteBucket(bucketName);
    } finally {
      await worker.drain();
    }
  }, 60000);

  // files-storage (#3003): the bucket and object routes the round trip does not touch.
  it("buckets, conditional writes, listing, copy, move, ranges and signed downloads", async () => {
    const client = new IronflowClient({ serverUrl: SERVER!, apiKey: API_KEY });
    const files = client.files();
    const name = `live-routes-node-${randomBytes(5).toString("hex")}`;

    const created = await files.createBucket(name, { emitEvents: true, allowSignedUrls: true });
    expect(created).toMatchObject({ name, emitEvents: true, allowSignedUrls: true, allowedContentTypes: [] });
    expect(created.maxObjectBytes).toBeGreaterThan(0);
    expect(created.createdAt).toBeTruthy();
    expect((await files.listBuckets()).map((b) => b.name)).toContain(name);
    expect(await files.getBucket(name)).toMatchObject({ name, allowSignedUrls: true });
    expect(await files.updateBucket(name, { allowedContentTypes: ["text/*"] })).toMatchObject({
      name,
      allowedContentTypes: ["text/*"],
      emitEvents: true,
    });
    const b = files.bucket(name);
    await expect(b.put("blocked.pdf", "x", { contentType: "application/pdf" })).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    );

    const content = "hello from node";
    const info = await b.put("docs/a.txt", content, { contentType: "text/plain", metadata: { source: "node" } });
    expect(info).toMatchObject({ bucket: name, path: "docs/a.txt", size: content.length, contentType: "text/plain" });
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.etag).toBeTruthy();
    expect(info.metadata).toMatchObject({ source: "node" });
    await expect(b.put("docs/a.txt", "x", { contentType: "text/plain", ifNoneMatch: true })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(b.put("docs/a.txt", "x", { contentType: "text/plain", ifMatch: "stale" })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const rewritten = await b.put("docs/a.txt", content, { contentType: "text/plain", ifMatch: info.etag });
    expect(rewritten.etag).not.toBe(info.etag);

    const got = await b.get("docs/a.txt", { ifMatch: rewritten.etag });
    expect(await got.text()).toBe(content);
    expect(got.etag).toBe(rewritten.etag);
    await expect(b.get("docs/a.txt", { ifMatch: info.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await (await b.get("docs/a.txt", { range: "bytes=0-4" })).text()).toBe("hello");
    expect(await b.info("docs/a.txt")).toMatchObject({ path: "docs/a.txt", etag: rewritten.etag, sha256: info.sha256 });
    await expect(b.info("docs/missing.txt")).rejects.toMatchObject({ status: 404 });

    await b.put("top.txt", "t", { contentType: "text/plain" });
    await b.put("docs/b.txt", "b", { contentType: "text/plain" });
    expect((await b.list({ prefix: "docs/" })).files.map((f) => f.path).sort()).toEqual(["docs/a.txt", "docs/b.txt"]);
    const level = await b.list({ delimiter: "/" });
    expect(level.files.map((f) => f.path)).toEqual(["top.txt"]);
    expect(level.prefixes).toEqual(["docs/"]);
    const page1 = await b.list({ prefix: "docs/", limit: 1 });
    expect(page1.files).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await b.list({ prefix: "docs/", limit: 1, cursor: page1.nextCursor });
    expect([page1.files[0]!.path, page2.files[0]!.path].sort()).toEqual(["docs/a.txt", "docs/b.txt"]);

    const copy = await b.copy("docs/a.txt", "docs/copy.txt");
    expect(copy).toMatchObject({ path: "docs/copy.txt", sha256: info.sha256, size: content.length });
    await b.info("docs/a.txt");
    await expect(b.move("docs/copy.txt", "docs/moved.txt", { ifMatch: "stale" })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const moved = await b.move("docs/copy.txt", "docs/moved.txt", { ifMatch: copy.etag });
    expect(moved).toMatchObject({ path: "docs/moved.txt", sha256: info.sha256 });
    await expect(b.info("docs/copy.txt")).rejects.toMatchObject({ status: 404 });

    // A signed download carries its own credential.
    const down = await b.signDownload("docs/a.txt", 60);
    expect(Date.parse(down.expiresAt)).toBeGreaterThan(Date.now());
    const res = await fetch(down.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);

    // A create-only upload URL writes a free path once and refuses to overwrite it.
    const once = await b.signUpload("once.txt", { contentType: "text/plain", createOnly: true });
    const putOnce = () => fetch(once.url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "first" });
    expect((await putOnce()).status).toBe(201);
    expect((await putOnce()).status).toBe(412);

    // A bucket with files will not delete.
    await expect(files.deleteBucket(name)).rejects.toBeInstanceOf(ConflictError);
    for (const path of ["docs/a.txt", "docs/b.txt", "docs/moved.txt", "top.txt", "once.txt"]) await b.delete(path);
    await files.deleteBucket(name);
    await expect(files.getBucket(name)).rejects.toMatchObject({ status: 404 });
  }, 60000);
});
