/**
 * Ironflow Browser file storage client, plus credential-free helpers for
 * signed URLs.
 */
import type {
  CopyFileOptions,
  FileBucketConfig,
  FileBucketInfo,
  FileInfo,
  FileObject,
  GetFileOptions,
  ListFilesOptions,
  ListFilesResult,
  MoveFileOptions,
  PutFileOptions,
  SignUploadOptions,
  SignedUrl,
} from "@ironflow/core";
import { DEFAULT_CLIENT_RETRY, DEFAULT_TIMEOUTS, HEADERS, IronflowError, UnauthorizedError, encodeBucketName, encodeFilePath, fileErrorFor, throwIfAuthError } from "@ironflow/core";
import type { IronflowConfig } from "./config.js";

/** Every browser body is replayable, so `contentLength` is never needed. */
export type BrowserFileBody = Blob | File | ArrayBuffer | Uint8Array | string;

const SIGNED_URLS_DISABLED = "SIGNED_URLS_DISABLED";

/** signedUrl: the request carried a token, not an API key. */
async function errorFrom(res: Response, signedUrl = false): Promise<IronflowError> {
  const text = await res.text().catch(() => "");
  let message = text || res.statusText;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string; code?: string };
    message = parsed.message ?? parsed.error ?? message;
    code = parsed.code;
  } catch {
    // not JSON; keep the raw text
  }
  // 401 and 403 keep UnauthenticatedError / UnauthorizedError, as every other
  // client does. A bucket with signed URLs off is not a credential problem.
  if (code !== SIGNED_URLS_DISABLED) {
    // API-key help would mislead the holder of a bad or expired token.
    if (signedUrl && res.status === 403) return new UnauthorizedError(`files: 403 ${message}`);
    throwIfAuthError(res.status, "files");
  }
  return fileErrorFor(res.status, message, code);
}

export class BrowserFilesClient {
  // The config is the live object, so a later setAuth() reaches this client.
  constructor(private readonly config: IronflowConfig) {}

  /**
   * One HTTP exchange. Only an upload and a sign call pass `retryable`: every
   * browser body is replayable, a sign call only mints a URL, and a retried
   * non-idempotent request could repeat its effect.
   */
  async send(path: string, init: RequestInit, retryable = false, buffer = false): Promise<Response> {
    const r = this.config.retry ?? {};
    const max = retryable ? Math.max(1, r.maxAttempts ?? DEFAULT_CLIENT_RETRY.MAX_ATTEMPTS) : 1;
    const backoff = r.backoffMultiplier ?? DEFAULT_CLIENT_RETRY.BACKOFF_MULTIPLIER;
    let delay = r.initialDelayMs ?? DEFAULT_CLIENT_RETRY.INITIAL_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(path, init, buffer);
      } catch (err) {
        const retry = err instanceof IronflowError && (err.retryable || err.status === 408);
        if (!retry || attempt >= max) throw err;
        const connection = err.code === "REQUEST_FAILED" || err.code === "TIMEOUT";
        const delayMs = connection ? (r.connectionRetryDelayMs ?? DEFAULT_CLIENT_RETRY.CONNECTION_RETRY_DELAY_MS) : delay;
        r.onRetry?.({ attempt, maxAttempts: max, error: err, delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delay = Math.min(delay * backoff, r.maxDelayMs ?? DEFAULT_CLIENT_RETRY.MAX_DELAY_MS);
      }
    }
  }

  private async attempt(path: string, init: RequestInit, buffer: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(HEADERS.ENVIRONMENT, this.config.environment);
    const credential = this.config.auth?.apiKey || this.config.auth?.token;
    if (credential) headers.set("Authorization", `Bearer ${credential}`);

    const timeout = this.config.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    // fetch resolves only after the server has read the whole request body, so a
    // fixed timer would abort a large upload.
    const timer = init.method === "PUT" ? undefined : setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${this.config.serverUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!res.ok) throw await errorFrom(res);
      // fetch resolves at the headers. Reading a JSON body here keeps a reset
      // or stalled body under the timer and the retry, like a failed fetch.
      return buffer ? new Response(res.status === 204 ? null : await res.arrayBuffer(), res) : res;
    } catch (err) {
      if (err instanceof IronflowError) throw err;
      // Only the timer aborts this controller. A body read can surface the
      // abort under another error name, so the signal is the test.
      if (controller.signal.aborted) {
        throw new IronflowError(`files request timeout after ${timeout}ms`, { code: "TIMEOUT", retryable: true });
      }
      throw new IronflowError(`files ${init.method} ${path} failed: ${String(err)}`, { code: "REQUEST_FAILED", retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  // Named `request` and called with a full `/api/v1/...` literal at every call
  // site: that is the only shape scripts/sdkcoverage can read.
  async request<T>(method: string, path: string, body?: unknown, retry = false): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.send(path, init, retry, true);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  createBucket(name: string, config: FileBucketConfig = {}): Promise<FileBucketInfo> {
    return this.request("POST", "/api/v1/files/buckets", { name, ...config });
  }
  async listBuckets(): Promise<FileBucketInfo[]> {
    return (await this.request<{ buckets: FileBucketInfo[] }>("GET", "/api/v1/files/buckets")).buckets;
  }
  async getBucket(name: string): Promise<FileBucketInfo> {
    return this.request("GET", `/api/v1/files/buckets/${encodeBucketName(name)}`);
  }
  async updateBucket(name: string, config: FileBucketConfig): Promise<FileBucketInfo> {
    return this.request("PATCH", `/api/v1/files/buckets/${encodeBucketName(name)}`, config);
  }
  async deleteBucket(name: string): Promise<void> {
    await this.request("DELETE", `/api/v1/files/buckets/${encodeBucketName(name)}`);
  }
  bucket(name: string): BrowserFileBucketHandle {
    return new BrowserFileBucketHandle(name, this);
  }
}

export class BrowserFileBucketHandle {
  private readonly bucket: string;

  constructor(
    readonly name: string,
    private readonly client: BrowserFilesClient,
  ) {
    this.bucket = encodeBucketName(name);
  }

  async put(path: string, body: BrowserFileBody, opts: PutFileOptions): Promise<FileInfo> {
    const headers = new Headers({ "Content-Type": opts.contentType });
    for (const [k, v] of Object.entries(opts.metadata ?? {})) headers.set(`X-Ironflow-Meta-${k}`, v);
    if (opts.ifMatch) headers.set("If-Match", opts.ifMatch);
    if (opts.ifNoneMatch) headers.set("If-None-Match", "*");
    // Assigned to a `url` local so scripts/sdkcoverage can pair the path with
    // the verb below.
    const url = `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`;
    const res = await this.client.send(url, { method: "PUT", headers, body: body as BodyInit }, true);
    return (await res.json()) as FileInfo;
  }

  async get(path: string, opts: GetFileOptions = {}): Promise<FileObject> {
    const headers = new Headers();
    if (opts.ifMatch) headers.set("If-Match", opts.ifMatch);
    if (opts.range) headers.set("Range", opts.range);
    const url = `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`;
    const res = await this.client.send(url, { method: "GET", headers });
    const len = res.headers.get("Content-Length");
    return {
      body: res.body as ReadableStream<Uint8Array>,
      contentType: res.headers.get("Content-Type") ?? "",
      etag: (res.headers.get("ETag") ?? "").replace(/^"|"$/g, ""),
      size: len === null ? undefined : Number(len),
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
    };
  }

  async info(path: string): Promise<FileInfo> {
    return this.client.request("GET", `/api/v1/files/buckets/${this.bucket}/info/${encodeFilePath(path)}`);
  }

  list(opts: ListFilesOptions = {}): Promise<ListFilesResult> {
    const q = new URLSearchParams();
    if (opts.prefix) q.set("prefix", opts.prefix);
    if (opts.delimiter) q.set("delimiter", opts.delimiter);
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    // A nested template literal would hide the path from scripts/sdkcoverage.
    const qs = q.size > 0 ? `?${q}` : "";
    return this.client.request("GET", `/api/v1/files/buckets/${this.bucket}/objects${qs}`);
  }

  async delete(path: string): Promise<void> {
    await this.client.request("DELETE", `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`);
  }

  move(from: string, to: string, opts: MoveFileOptions = {}): Promise<FileInfo> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/move`, { from, to, ...opts });
  }

  copy(from: string, to: string, opts: CopyFileOptions = {}): Promise<FileInfo> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/copy`, { from, to, ...opts });
  }

  async movePrefix(from: string, to: string): Promise<number> {
    const res = await this.client.request<{ count: number }>("POST", `/api/v1/files/buckets/${this.bucket}/move-prefix`, { from, to });
    return res.count;
  }

  signUpload(path: string, opts: SignUploadOptions = {}): Promise<SignedUrl> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/signed-urls/upload`, { path, ...opts }, true);
  }

  signDownload(path: string, ttlSeconds?: number): Promise<SignedUrl> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/signed-urls/download`, { path, ttlSeconds }, true);
  }
}

/**
 * Upload with a URL from bucket.signUpload(). No Ironflow credentials are
 * sent: the token in the URL is the credential, so this works for end users
 * who are not Ironflow principals.
 */
export async function uploadToSignedUrl(
  url: string,
  body: Blob | File | ArrayBuffer | Uint8Array,
  contentType?: string,
): Promise<FileInfo> {
  const type = contentType ?? (body instanceof Blob ? body.type : "");
  const res = await fetch(url, {
    method: "PUT",
    body: body as BodyInit,
    headers: type ? { "Content-Type": type } : {},
    credentials: "omit",
  });
  if (!res.ok) throw await errorFrom(res, true);
  return (await res.json()) as FileInfo;
}

/** Download with a URL from bucket.signDownload(); the caller reads the Response. */
export async function downloadFromSignedUrl(url: string): Promise<Response> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw await errorFrom(res, true);
  return res;
}
