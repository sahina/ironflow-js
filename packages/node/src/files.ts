/**
 * Ironflow Node.js file storage client.
 */
import { Readable } from "node:stream";
import type {
  ClientRetryConfig,
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
import { DEFAULT_CLIENT_RETRY, HEADERS, IronflowError, encodeBucketName, encodeFilePath, fileErrorFor, throwIfAuthError } from "@ironflow/core";
import type { ErrorContext, OnErrorHandler } from "./types.js";

export interface FilesClientConfig {
  serverUrl: string;
  apiKey?: string;
  environment?: string;
  timeout: number;
  retry?: ClientRetryConfig;
  onError?: OnErrorHandler;
}

export type FileBody = Uint8Array | ArrayBuffer | Blob | string | Readable | ReadableStream<Uint8Array>;

function isReplayable(body: FileBody): body is Uint8Array | ArrayBuffer | Blob | string {
  return typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob;
}

const SIGNED_URLS_DISABLED = "SIGNED_URLS_DISABLED";

async function errorFrom(res: Response): Promise<IronflowError> {
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
  if (code !== SIGNED_URLS_DISABLED) throwIfAuthError(res.status, "files");
  return fileErrorFor(res.status, message, code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ResolvedRetry = Required<Omit<ClientRetryConfig, "onRetry">> & Pick<ClientRetryConfig, "onRetry">;

export class FilesClient {
  private readonly retry: ResolvedRetry;

  constructor(private readonly config: FilesClientConfig) {
    // Every ClientRetryConfig field is optional, so a spread would leave
    // maxAttempts undefined and a 5xx would retry without end. Resolve each
    // field, as client.ts does.
    const r = config.retry ?? {};
    this.retry = {
      maxAttempts: Math.max(1, r.maxAttempts ?? DEFAULT_CLIENT_RETRY.MAX_ATTEMPTS),
      initialDelayMs: r.initialDelayMs ?? DEFAULT_CLIENT_RETRY.INITIAL_DELAY_MS,
      maxDelayMs: r.maxDelayMs ?? DEFAULT_CLIENT_RETRY.MAX_DELAY_MS,
      backoffMultiplier: r.backoffMultiplier ?? DEFAULT_CLIENT_RETRY.BACKOFF_MULTIPLIER,
      connectionRetryDelayMs: r.connectionRetryDelayMs ?? DEFAULT_CLIENT_RETRY.CONNECTION_RETRY_DELAY_MS,
      onRetry: r.onRetry,
    };
  }

  /**
   * One HTTP exchange with retry. `replayable` is false for stream bodies:
   * a consumed stream cannot be sent twice, so those get exactly one attempt.
   */
  async send(path: string, init: RequestInit, replayable: boolean, clientMethod?: string, buffer = false): Promise<Response> {
    try {
      return await this.exchange(path, init, replayable, buffer);
    } catch (err) {
      const statusCode = err instanceof IronflowError ? err.status : undefined;
      await this.callOnError(err as Error, { method: clientMethod ?? "files", endpoint: path, statusCode });
      throw err;
    }
  }

  private async exchange(path: string, init: RequestInit, replayable: boolean, buffer: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.config.apiKey) headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    if (this.config.environment) headers.set(HEADERS.ENVIRONMENT, this.config.environment);
    const max = replayable ? this.retry.maxAttempts : 1;
    let delay = this.retry.initialDelayMs;
    // A stream is spent after one attempt; say so instead of surfacing a bare 503.
    // The message is extended in place so the error keeps its class.
    const failFirst = <E extends Error>(e: E): E => {
      if ((init as { duplex?: string }).duplex === "half") {
        e.message += " (the upload body is a stream and cannot be replayed, so the request was not retried)";
      }
      return e;
    };
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      // fetch resolves only after the server has read the whole request body.
      // A fixed timer would abort a large upload, and the retry would send it again.
      const timer = init.method === "PUT" ? undefined : setTimeout(() => controller.abort(), this.config.timeout);
      let res: Response;
      try {
        res = await fetch(`${this.config.serverUrl}${path}`, { ...init, headers, signal: controller.signal });
        // fetch resolves at the headers. Reading a JSON body here keeps a reset
        // or stalled body under the timer and the retry, like a failed fetch.
        if (buffer && res.ok) {
          res = new Response(res.status === 204 ? null : await res.arrayBuffer(), res);
        }
      } catch (err) {
        clearTimeout(timer);
        const cause = new IronflowError(`request failed: ${String(err)}`, { code: "REQUEST_FAILED", retryable: true });
        if (attempt >= max) throw failFirst(cause);
        this.retry.onRetry?.({ attempt, maxAttempts: max, error: cause, delayMs: this.retry.connectionRetryDelayMs });
        await sleep(this.retry.connectionRetryDelayMs);
        continue;
      }
      clearTimeout(timer);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      if (!retryable) throw await errorFrom(res);
      if (attempt >= max) throw failFirst(await errorFrom(res));
      const failure = await errorFrom(res).catch((e: unknown) => e as Error);
      this.retry.onRetry?.({ attempt, maxAttempts: max, error: failure, delayMs: delay });
      await sleep(delay);
      delay = Math.min(delay * this.retry.backoffMultiplier, this.retry.maxDelayMs);
    }
  }

  // Named `request` and called with a full `/api/v1/...` literal at every call
  // site: that is the only shape scripts/sdkcoverage can read (tsCallRe).
  // Files POSTs (move, copy, create) are not idempotent, so they get one
  // attempt. A sign call only mints a URL and passes retry.
  async request<T>(method: string, path: string, body?: unknown, clientMethod?: string, retry = method !== "POST"): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.send(path, init, retry, clientMethod, true);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  createBucket(name: string, config: FileBucketConfig = {}): Promise<FileBucketInfo> {
    return this.request("POST", "/api/v1/files/buckets", { name, ...config }, "files.createBucket");
  }
  async listBuckets(): Promise<FileBucketInfo[]> {
    return (await this.request<{ buckets: FileBucketInfo[] }>("GET", "/api/v1/files/buckets", undefined, "files.listBuckets")).buckets;
  }
  async getBucket(name: string): Promise<FileBucketInfo> {
    return this.request("GET", `/api/v1/files/buckets/${encodeBucketName(name)}`, undefined, "files.getBucket");
  }
  async updateBucket(name: string, config: FileBucketConfig): Promise<FileBucketInfo> {
    return this.request("PATCH", `/api/v1/files/buckets/${encodeBucketName(name)}`, config, "files.updateBucket");
  }
  async deleteBucket(name: string): Promise<void> {
    await this.request("DELETE", `/api/v1/files/buckets/${encodeBucketName(name)}`, undefined, "files.deleteBucket");
  }
  bucket(name: string): FileBucketHandle {
    return new FileBucketHandle(name, this);
  }

  private async callOnError(error: Error, context: ErrorContext): Promise<void> {
    if (!this.config.onError) return;
    try {
      await this.config.onError(error, context);
    } catch (callbackError) {
      console.error("[ironflow] onError callback threw:", callbackError);
    }
  }
}

export class FileBucketHandle {
  private readonly bucket: string;

  constructor(
    readonly name: string,
    private readonly client: FilesClient,
  ) {
    this.bucket = encodeBucketName(name);
  }

  async put(path: string, body: FileBody, opts: PutFileOptions): Promise<FileInfo> {
    const headers = new Headers({ "Content-Type": opts.contentType });
    for (const [k, v] of Object.entries(opts.metadata ?? {})) headers.set(`X-Ironflow-Meta-${k}`, v);
    if (opts.ifMatch) headers.set("If-Match", opts.ifMatch);
    if (opts.ifNoneMatch) headers.set("If-None-Match", "*");
    const replayable = isReplayable(body);
    // Assigned to a `url` local so scripts/sdkcoverage can pair the path with
    // the verb below.
    const url = `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`;
    const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers };
    if (replayable) {
      init.body = body as RequestInit["body"];
    } else {
      if (opts.contentLength === undefined) {
        throw new IronflowError("put: contentLength is required for a stream body", { code: "VALIDATION" });
      }
      headers.set("Content-Length", String(opts.contentLength));
      init.body = (body instanceof Readable ? Readable.toWeb(body) : body) as RequestInit["body"];
      init.duplex = "half"; // required by fetch for a streamed request body
    }
    const res = await this.client.send(url, init, replayable, "files.put");
    return (await res.json()) as FileInfo;
  }

  async get(path: string, opts: GetFileOptions = {}): Promise<FileObject> {
    const headers = new Headers();
    if (opts.ifMatch) headers.set("If-Match", opts.ifMatch);
    if (opts.range) headers.set("Range", opts.range);
    const url = `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`;
    const res = await this.client.send(url, { method: "GET", headers }, true, "files.get");
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
    return this.client.request("GET", `/api/v1/files/buckets/${this.bucket}/info/${encodeFilePath(path)}`, undefined, "files.info");
  }

  list(opts: ListFilesOptions = {}): Promise<ListFilesResult> {
    const q = new URLSearchParams();
    if (opts.prefix) q.set("prefix", opts.prefix);
    if (opts.delimiter) q.set("delimiter", opts.delimiter);
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    // A nested template literal would hide the path from scripts/sdkcoverage.
    const qs = q.size > 0 ? `?${q}` : "";
    return this.client.request("GET", `/api/v1/files/buckets/${this.bucket}/objects${qs}`, undefined, "files.list");
  }

  async delete(path: string): Promise<void> {
    await this.client.request("DELETE", `/api/v1/files/buckets/${this.bucket}/objects/${encodeFilePath(path)}`, undefined, "files.delete");
  }

  move(from: string, to: string, opts: MoveFileOptions = {}): Promise<FileInfo> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/move`, { from, to, ...opts }, "files.move");
  }

  copy(from: string, to: string, opts: CopyFileOptions = {}): Promise<FileInfo> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/copy`, { from, to, ...opts }, "files.copy");
  }

  async movePrefix(from: string, to: string): Promise<number> {
    const res = await this.client.request<{ count: number }>(
      "POST",
      `/api/v1/files/buckets/${this.bucket}/move-prefix`,
      { from, to },
      "files.movePrefix",
    );
    return res.count;
  }

  signUpload(path: string, opts: SignUploadOptions = {}): Promise<SignedUrl> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/signed-urls/upload`, { path, ...opts }, "files.signUpload", true);
  }

  signDownload(path: string, ttlSeconds?: number): Promise<SignedUrl> {
    return this.client.request("POST", `/api/v1/files/buckets/${this.bucket}/signed-urls/download`, { path, ttlSeconds }, "files.signDownload", true);
  }
}
