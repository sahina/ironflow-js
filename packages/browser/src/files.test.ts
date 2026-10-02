import { beforeEach, describe, expect, it, vi } from "vitest";
import { IronflowError, PreconditionFailedError, UnauthorizedError, ValidationError } from "@ironflow/core";
import { BrowserFilesClient, downloadFromSignedUrl, uploadToSignedUrl } from "./files.js";
import type { IronflowConfig } from "./config.js";

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

const config = { serverUrl: "http://localhost:9123", environment: "test-env", auth: { token: "jwt" } } as IronflowConfig;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("BrowserFilesClient", () => {
  it("rejects a dot-segment path without sending a request", async () => {
    const b = new BrowserFilesClient(config).bucket("a");
    const bad = "../../b/objects/x";
    await expect(b.delete(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.info(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.get(bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(b.put(bad, new Uint8Array([1]), { contentType: "text/plain" })).rejects.toBeInstanceOf(ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty, '.' or '..' bucket name without sending a request", async () => {
    const c = new BrowserFilesClient(config);
    for (const bad of ["", ".", ".."]) {
      expect(() => c.bucket(bad)).toThrow(ValidationError);
      await expect(c.getBucket(bad)).rejects.toBeInstanceOf(ValidationError);
      await expect(c.updateBucket(bad, {})).rejects.toBeInstanceOf(ValidationError);
      await expect(c.deleteBucket(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("gives signed URLs that are off their own code, without API-key help", async () => {
    mockFetch.mockResolvedValueOnce(json(403, { message: "signed URLs disabled", code: "SIGNED_URLS_DISABLED" }));
    const err = (await new BrowserFilesClient(config).bucket("b").signDownload("x").catch((e: unknown) => e)) as IronflowError;
    expect(err).not.toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe("SIGNED_URLS_DISABLED");
    expect(err.message).not.toMatch(/IRONFLOW_API_KEY/);
  });

  it("uploads a File with auth, environment and an encoded path", async () => {
    mockFetch.mockResolvedValueOnce(json(201, { etag: "e1" }));
    const file = new File(["hi"], "c.txt", { type: "text/plain" });
    const info = await new BrowserFilesClient(config).bucket("docs").put("a b/c.txt", file, { contentType: file.type });
    expect(info.etag).toBe("e1");
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:9123/api/v1/files/buckets/docs/objects/a%20b/c.txt");
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBe("Bearer jwt");
    expect(h.get("X-Ironflow-Environment")).toBe("test-env");
    expect(h.get("Content-Type")).toBe("text/plain");
    expect(init.body).toBe(file);
  });

  it("sends metadata and preconditions", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { etag: "e2" }));
    await new BrowserFilesClient(config)
      .bucket("b")
      .put("x", new Uint8Array([1]), { contentType: "text/plain", metadata: { source: "t" }, ifMatch: "e1" });
    const h = new Headers(mockFetch.mock.calls[0]![1].headers);
    expect(h.get("X-Ironflow-Meta-source")).toBe("t");
    expect(h.get("If-Match")).toBe("e1");
  });

  it("maps 412 to PreconditionFailedError", async () => {
    mockFetch.mockResolvedValueOnce(json(412, { message: "m", code: "PRECONDITION_FAILED" }));
    await expect(
      new BrowserFilesClient(config).bucket("b").put("x", new Uint8Array([1]), { contentType: "text/plain", ifMatch: "old" }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  describe("upload retry", () => {
    const retry = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, connectionRetryDelayMs: 1 };
    const retrying = { ...config, retry } as IronflowConfig;

    it.each([
      ["Uint8Array", () => new Uint8Array([1])],
      ["ArrayBuffer", () => new Uint8Array([1]).buffer],
      ["Blob", () => new Blob(["x"])],
      ["File", () => new File(["x"], "x.txt")],
      ["string", () => "x"],
    ])("retries a %s body after a 503 and reports it through onRetry", async (_name, body) => {
      mockFetch.mockResolvedValueOnce(json(503, { message: "x" })).mockResolvedValueOnce(json(201, { etag: "e" }));
      const onRetry = vi.fn();
      const cfg = { ...config, retry: { ...retry, onRetry } } as IronflowConfig;
      const info = await new BrowserFilesClient(cfg).bucket("b").put("x", body() as never, { contentType: "text/plain" });
      expect(info.etag).toBe("e");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![1].body).toBe(mockFetch.mock.calls[0]![1].body);
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxAttempts: 3 }));
    });

    it("retries a network failure and gives up after maxAttempts", async () => {
      mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(new BrowserFilesClient(retrying).bucket("b").put("x", "x", { contentType: "text/plain" })).rejects.toThrow(
        /failed/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry a failure a retry cannot fix", async () => {
      mockFetch.mockResolvedValueOnce(json(413, { message: "big" }));
      await expect(new BrowserFilesClient(retrying).bucket("b").put("x", "x", { contentType: "text/plain" })).rejects.toThrow(
        "big",
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries nothing but uploads and the sign calls", async () => {
      mockFetch.mockResolvedValueOnce(json(503, { message: "x" })).mockResolvedValueOnce(json(200, { buckets: [] }));
      await expect(new BrowserFilesClient(retrying).listBuckets()).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries the sign calls", async () => {
      const signed = { url: "u", expiresAt: "t" };
      mockFetch
        .mockResolvedValueOnce(json(503, { message: "x" }))
        .mockResolvedValueOnce(json(200, signed))
        .mockResolvedValueOnce(json(503, { message: "x" }))
        .mockResolvedValueOnce(json(200, signed));
      const b = new BrowserFilesClient(retrying).bucket("b");
      expect(await b.signUpload("x")).toEqual(signed);
      expect(await b.signDownload("x")).toEqual(signed);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("sends createOnly on a signed upload request", async () => {
      mockFetch.mockResolvedValueOnce(json(200, { url: "u", expiresAt: "t" }));
      await new BrowserFilesClient(config).bucket("b").signUpload("x", { createOnly: true });
      expect(JSON.parse(mockFetch.mock.calls[0]![1].body as string)).toMatchObject({ path: "x", createOnly: true });
    });

    it("retries a sign call whose response body breaks", async () => {
      const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 200 });
      mockFetch.mockResolvedValueOnce(broken).mockResolvedValueOnce(json(200, { url: "u", expiresAt: "t" }));
      expect(await new BrowserFilesClient(retrying).bucket("b").signUpload("x")).toEqual({ url: "u", expiresAt: "t" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("times out a stalled response body", async () => {
      mockFetch.mockImplementationOnce(async (_u: string, init: RequestInit) => {
        const body = new ReadableStream({
          start: (c) => init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))),
        });
        return new Response(body, { status: 200 });
      });
      const c = new BrowserFilesClient({ ...config, timeout: 20 } as IronflowConfig);
      await expect(c.bucket("b").move("a", "b")).rejects.toMatchObject({ code: "TIMEOUT" });
    });
  });

  it("reads setAuth changes made after construction", async () => {
    const live = { ...config } as IronflowConfig;
    const files = new BrowserFilesClient(live);
    live.auth = { token: "later" };
    mockFetch.mockResolvedValueOnce(json(200, { buckets: [] }));
    await files.listBuckets();
    expect(new Headers(mockFetch.mock.calls[0]![1].headers).get("Authorization")).toBe("Bearer later");
  });

  it("lists, moves a prefix and pins a download", async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { files: [], prefixes: [] }))
      .mockResolvedValueOnce(json(200, { count: 3 }))
      .mockResolvedValueOnce(new Response("body", { headers: { "Content-Type": "text/plain", ETag: '"e1"', "Content-Length": "4" } }));
    const bucket = new BrowserFilesClient(config).bucket("docs");
    await bucket.list({ prefix: "a/", delimiter: "/" });
    expect(mockFetch.mock.calls[0]![0]).toBe("http://localhost:9123/api/v1/files/buckets/docs/objects?prefix=a%2F&delimiter=%2F");
    expect(await bucket.movePrefix("notes/", "archive/")).toBe(3);
    const obj = await bucket.get("x", { ifMatch: "e1" });
    expect(new Headers(mockFetch.mock.calls[2]![1].headers).get("If-Match")).toBe("e1");
    expect(obj.etag).toBe("e1");
    expect(obj.size).toBe(4);
    expect(await obj.text()).toBe("body");
  });
});

describe("signed URL helpers", () => {
  it("uploadToSignedUrl sends no credentials and no metadata", async () => {
    mockFetch.mockResolvedValueOnce(json(201, { path: "in/x.txt" }));
    await uploadToSignedUrl("http://h/api/v1/files/signed?token=t", new Blob(["x"], { type: "text/plain" }));
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://h/api/v1/files/signed?token=t");
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBeNull();
    expect(h.get("X-Ironflow-Environment")).toBeNull();
    expect(h.get("Content-Type")).toBe("text/plain");
    expect(init.credentials).toBe("omit");
  });

  it("downloadFromSignedUrl returns the Response and rejects on error", async () => {
    mockFetch.mockResolvedValueOnce(new Response("data"));
    const res = await downloadFromSignedUrl("http://h/api/v1/files/signed?token=t");
    expect(await res.text()).toBe("data");
    expect(mockFetch.mock.calls[0]![1].credentials).toBe("omit");

    mockFetch.mockResolvedValueOnce(json(404, { message: "gone" }));
    await expect(downloadFromSignedUrl("http://h/api/v1/files/signed?token=t")).rejects.toThrow("gone");
  });

  it("does not give API-key help for a bad token", async () => {
    mockFetch.mockResolvedValueOnce(json(403, { message: "invalid or expired signed URL", code: "FORBIDDEN" }));
    const down = (await downloadFromSignedUrl("http://h/api/v1/files/signed?token=t").catch((e: unknown) => e)) as Error;
    expect(down).toBeInstanceOf(UnauthorizedError);
    expect(down.message).toMatch(/invalid or expired/);
    expect(down.message).not.toMatch(/IRONFLOW_API_KEY/);
    mockFetch.mockResolvedValueOnce(json(403, { message: "signed URLs disabled", code: "SIGNED_URLS_DISABLED" }));
    const up = (await uploadToSignedUrl("http://h/api/v1/files/signed?token=t", new Blob(["x"])).catch((e: unknown) => e)) as IronflowError;
    expect(up.code).toBe("SIGNED_URLS_DISABLED");
  });
});
