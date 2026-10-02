import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IronflowError, PayloadTooLargeError,PreconditionFailedError, UnauthorizedError, UnsupportedMediaTypeError, ValidationError } from "@ironflow/core";
import { createClient } from "./client.js";
import { FilesClient } from "./files.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function client(attempts = 1) {
  return new FilesClient({
    serverUrl: "http://localhost:9123",
    apiKey: "k",
    timeout: 5000,
    retry: { maxAttempts: attempts, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, connectionRetryDelayMs: 1 },
  });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FilesClient", () => {
  it("sends the environment header when configured", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { buckets: [] }));
    await new FilesClient({ serverUrl: "http://localhost:9123", timeout: 5000, environment: "staging" }).listBuckets();
    expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get("X-Ironflow-Environment")).toBe("staging");
  });

  it("client.files() carries the client's environment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { buckets: [] }));
    await createClient({ serverUrl: "http://localhost:9123", environment: "staging" }).files().listBuckets();
    expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get("X-Ironflow-Environment")).toBe("staging");
  });

  it("rejects a dot-segment path without sending a request", async () => {
    const b = client().bucket("a");
    const bad = "../../b/objects/x";
    await expect(b.delete(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.info(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.get(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.put(bad, "x", { contentType: "text/plain" })).rejects.toBeInstanceOf(ValidationError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects an empty, '.' or '..' bucket name without sending a request", async () => {
    for (const bad of ["", ".", ".."]) {
      expect(() => client().bucket(bad)).toThrow(ValidationError);
      await expect(client().getBucket(bad)).rejects.toBeInstanceOf(ValidationError);
      await expect(client().updateBucket(bad, {})).rejects.toBeInstanceOf(ValidationError);
      await expect(client().deleteBucket(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("still escapes a slash in a bucket name", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, {}));
    await client().getBucket("a/b");
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe("http://localhost:9123/api/v1/files/buckets/a%2Fb");
  });

  it("retries the sign calls, but not a move", async () => {
    const signed = { url: "u", expiresAt: "t" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(503, { message: "x" }))
      .mockResolvedValueOnce(json(200, signed))
      .mockResolvedValueOnce(json(429, { message: "x" }))
      .mockResolvedValueOnce(json(200, signed))
      .mockResolvedValueOnce(json(503, { message: "x" }));
    const b = client(3).bucket("b");
    expect(await b.signUpload("x")).toEqual(signed);
    expect(await b.signDownload("x")).toEqual(signed);
    await expect(b.move("a", "c")).rejects.toBeInstanceOf(IronflowError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
  });

  it("sends createOnly on a signed upload request", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { url: "u", expiresAt: "t" }));
    await client().bucket("b").signUpload("x", { createOnly: true });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ path: "x", createOnly: true });
  });

  it("retries a sign call whose response body breaks", async () => {
    const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 200 });
    vi.mocked(fetch).mockResolvedValueOnce(broken).mockResolvedValueOnce(json(200, { url: "u", expiresAt: "t" }));
    expect(await client(3).bucket("b").signUpload("x")).toEqual({ url: "u", expiresAt: "t" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled response body", async () => {
    vi.mocked(fetch).mockImplementationOnce(async (_u, init) => {
      const body = new ReadableStream({
        start: (c) => init!.signal!.addEventListener("abort", () => c.error(new Error("aborted"))),
      });
      return new Response(body, { status: 200 });
    });
    const c = new FilesClient({ serverUrl: "http://localhost:9123", timeout: 20, retry: { maxAttempts: 1 } });
    await expect(c.bucket("b").move("a", "b")).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  it("gives signed URLs that are off their own code, without API-key help", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(403, { message: "signed URLs disabled", code: "SIGNED_URLS_DISABLED" }));
    const err = (await client().bucket("b").signUpload("x").catch((e: unknown) => e)) as IronflowError;
    expect(err).not.toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe("SIGNED_URLS_DISABLED");
    expect(err.status).toBe(403);
    expect(err.message).not.toMatch(/IRONFLOW_API_KEY/);
  });

  it("puts raw bytes with an encoded path, metadata and preconditions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(201, { bucket: "docs", path: "a b/c.txt", etag: "e1" }));
    const info = await client()
      .bucket("docs")
      .put("a b/c.txt", new TextEncoder().encode("hi"), {
        contentType: "text/plain",
        metadata: { source: "t" },
        ifNoneMatch: true,
      });
    expect(info.etag).toBe("e1");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:9123/api/v1/files/buckets/docs/objects/a%20b/c.txt");
    const h = new Headers(init!.headers);
    expect(init!.method).toBe("PUT");
    expect(h.get("Content-Type")).toBe("text/plain");
    expect(h.get("X-Ironflow-Meta-source")).toBe("t");
    expect(h.get("If-None-Match")).toBe("*");
    expect(h.get("Authorization")).toBe("Bearer k");
  });

  it("retries a Uint8Array body but not a stream body", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(503, { message: "x" }))
      .mockResolvedValueOnce(json(201, { etag: "e" }));
    await client(3).bucket("b").put("x", new Uint8Array([1, 2, 3]), { contentType: "application/octet-stream" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(503, { message: "x" }))
      .mockResolvedValueOnce(json(201, { etag: "e" }));
    await expect(
      client(3)
        .bucket("b")
        .put("x", Readable.from([Buffer.from("abc")]), { contentType: "text/plain", contentLength: 3 }),
    ).rejects.toThrow();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("says a failed stream upload cannot be replayed and keeps the error class", async () => {
    const stream = () => Readable.from([Buffer.from("abc")]);
    const opts = { contentType: "text/plain", contentLength: 3 };
    vi.mocked(fetch).mockResolvedValueOnce(json(503, { message: "x" }));
    const err = await client(3).bucket("b").put("x", stream(), opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IronflowError);
    expect((err as IronflowError).status).toBe(503);
    expect((err as Error).message).toMatch(/stream.*cannot be replayed/);

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    const netErr = await client(3).bucket("b").put("x", stream(), opts).catch((e: unknown) => e);
    expect((netErr as Error).message).toMatch(/stream.*cannot be replayed/);

    // A non-retryable failure keeps its own message.
    vi.mocked(fetch).mockResolvedValueOnce(json(413, { message: "too big" }));
    await expect(client(3).bucket("b").put("x", stream(), opts)).rejects.toThrow(/^too big$/);
  });

  it("requires contentLength for stream bodies", async () => {
    await expect(
      client().bucket("b").put("x", Readable.from([Buffer.from("a")]), { contentType: "text/plain" }),
    ).rejects.toThrow(/contentLength/);
  });

  it.each([
    [412, PreconditionFailedError],
    [413, PayloadTooLargeError],
    [415, UnsupportedMediaTypeError],
  ])("maps %i to a typed error", async (status, cls) => {
    vi.mocked(fetch).mockResolvedValueOnce(json(status, { code: "X", message: "m", error: "m" }));
    await expect(
      client().bucket("b").put("x", new Uint8Array([1]), { contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(cls);
  });

  it("streams a download and pins the version", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("body", { status: 200, headers: { "Content-Type": "text/plain", ETag: '"e1"', "Content-Length": "4" } }),
    );
    const obj = await client().bucket("b").get("x", { ifMatch: "e1" });
    expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get("If-Match")).toBe("e1");
    expect(obj.etag).toBe("e1");
    expect(await obj.text()).toBe("body");
  });

  it("moves a prefix", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { count: 3 }));
    expect(await client().bucket("docs").movePrefix("notes/", "archive/")).toBe(3);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:9123/api/v1/files/buckets/docs/move-prefix");
    expect(JSON.parse(String(init!.body))).toEqual({ from: "notes/", to: "archive/" });
  });

  it("does not time out a byte upload", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      (_u, init) =>
        new Promise((resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve(json(201, { etag: "e" })), 30);
        }),
    );
    const c = new FilesClient({ serverUrl: "http://localhost:9123", timeout: 5 });
    await expect(c.bucket("b").put("x", new Uint8Array([1]), { contentType: "text/plain" })).resolves.toBeTruthy();
  });

  it("keeps UnauthorizedError for 403 and reports failures to onError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(403, { message: "no" }));
    const onError = vi.fn();
    const c = new FilesClient({ serverUrl: "http://localhost:9123", timeout: 5000, onError });
    await expect(c.bucket("b").delete("x")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onError).toHaveBeenCalledWith(expect.any(UnauthorizedError), expect.objectContaining({ method: "files.delete" }));
  });
});
