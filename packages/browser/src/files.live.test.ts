// @vitest-environment node
/**
 * Live test: files-storage (#3003) through the browser client. It covers the
 * bucket routes, the object routes and both signed-URL directions; the
 * browser cannot run a worker, so the file event is read back from the events
 * list instead. Skips unless IRONFLOW_TEST_SERVER is set; `make test-files-live` sets it.
 */
import { ConflictError, PreconditionFailedError, UnsupportedMediaTypeError } from "@ironflow/core";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { downloadFromSignedUrl, uploadToSignedUrl } from "./files.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];

describe.skipIf(!SERVER)("file storage — live server", () => {
  it("buckets, objects, listing, copy, move, conditional writes and signed URLs", async () => {
    const client = new IronflowClient();
    client.configure({ serverUrl: SERVER!, auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] } });
    const files = client.files();
    const name = `live-browser-${Math.random().toString(16).slice(2, 12)}`;

    // Bucket routes.
    const created = await files.createBucket(name, { emitEvents: true, allowSignedUrls: true });
    expect(created).toMatchObject({ name, emitEvents: true, allowSignedUrls: true, allowedContentTypes: [] });
    expect(created.maxObjectBytes).toBeGreaterThan(0);
    expect(created.createdAt).toBeTruthy();
    expect((await files.listBuckets()).map((b) => b.name)).toContain(name);
    expect(await files.getBucket(name)).toMatchObject({ name, allowSignedUrls: true });
    const updated = await files.updateBucket(name, { allowedContentTypes: ["text/*"] });
    expect(updated).toMatchObject({ name, allowedContentTypes: ["text/*"], emitEvents: true });
    const b = files.bucket(name);
    await expect(b.put("blocked.pdf", "x", { contentType: "application/pdf" })).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    );

    // Put, with metadata, and the conditional writes.
    const content = "hello from the browser";
    const info = await b.put("docs/a.txt", content, { contentType: "text/plain", metadata: { source: "browser" } });
    expect(info).toMatchObject({ bucket: name, path: "docs/a.txt", size: content.length, contentType: "text/plain" });
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.etag).toBeTruthy();
    expect(info.metadata).toMatchObject({ source: "browser" });
    await expect(b.put("docs/a.txt", "x", { contentType: "text/plain", ifNoneMatch: true })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(b.put("docs/a.txt", "x", { contentType: "text/plain", ifMatch: "stale" })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const rewritten = await b.put("docs/a.txt", content, { contentType: "text/plain", ifMatch: info.etag });
    expect(rewritten.etag).not.toBe(info.etag);

    // Get, info and a range.
    const got = await b.get("docs/a.txt", { ifMatch: rewritten.etag });
    expect(await got.text()).toBe(content);
    expect(got.etag).toBe(rewritten.etag);
    await expect(b.get("docs/a.txt", { ifMatch: info.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await (await b.get("docs/a.txt", { range: "bytes=0-4" })).text()).toBe("hello");
    expect(await b.info("docs/a.txt")).toMatchObject({ path: "docs/a.txt", etag: rewritten.etag, sha256: info.sha256 });
    await expect(b.info("docs/missing.txt")).rejects.toMatchObject({ status: 404 });

    // Listing: a prefix, a delimiter and a page.
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

    // Copy keeps the source; move removes it and honors If-Match.
    const copy = await b.copy("docs/a.txt", "docs/copy.txt");
    expect(copy).toMatchObject({ path: "docs/copy.txt", sha256: info.sha256, size: content.length });
    await b.info("docs/a.txt");
    await expect(b.move("docs/copy.txt", "docs/moved.txt", { ifMatch: "stale" })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const moved = await b.move("docs/copy.txt", "docs/moved.txt", { ifMatch: copy.etag });
    expect(moved).toMatchObject({ path: "docs/moved.txt", sha256: info.sha256 });
    await expect(b.info("docs/copy.txt")).rejects.toMatchObject({ status: 404 });

    // Signed URLs carry their own credential.
    const down = await b.signDownload("docs/a.txt", 60);
    expect(Date.parse(down.expiresAt)).toBeGreaterThan(Date.now());
    expect(await (await downloadFromSignedUrl(down.url)).text()).toBe(content);
    const up = await b.signUpload("in/signed.txt", { maxBytes: 1024, contentType: "text/plain" });
    expect(up.url.startsWith(`${SERVER}/api/v1/files/signed?token=`)).toBe(true);
    const uploaded = await uploadToSignedUrl(up.url, new TextEncoder().encode("signed body"), "text/plain");
    expect(uploaded).toMatchObject({ path: "in/signed.txt", size: "signed body".length });
    expect(await b.movePrefix("in/", "archive/")).toBe(1);
    expect((await b.info("archive/signed.txt")).size).toBe("signed body".length);

    // A create-only upload URL writes a free path once and refuses to overwrite it.
    const once = await b.signUpload("once.txt", { contentType: "text/plain", createOnly: true });
    await uploadToSignedUrl(once.url, new TextEncoder().encode("first"), "text/plain");
    await expect(uploadToSignedUrl(once.url, new TextEncoder().encode("again"), "text/plain")).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );

    // The create event reaches the events list.
    const events = await client.listEvents({ name: "ironflow.file.created" });
    const event = events.events.find((e) => (e.data as { bucket?: string }).bucket === name);
    expect(event?.data).toMatchObject({ bucket: name });

    // A bucket with files will not delete.
    await expect(files.deleteBucket(name)).rejects.toBeInstanceOf(ConflictError);
    for (const path of ["docs/a.txt", "docs/b.txt", "docs/moved.txt", "top.txt", "archive/signed.txt", "once.txt"]) await b.delete(path);
    await files.deleteBucket(name);
    await expect(files.getBucket(name)).rejects.toMatchObject({ status: 404 });
  }, 60000);
});
