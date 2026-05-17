/**
 * Ironflow Browser KV Client
 *
 * Key-Value store operations for browser-based applications.
 * Includes WebSocket-based watch support.
 */

import type {
  KVBucketConfig,
  KVBucketInfo,
  KVEntry,
  KVPutResult,
  KVListKeysResult,
  KVListBucketsResult,
  KVWatchEvent,
  KVWatchCallbacks,
  KVWatchOptions,
  KVWatcher,
} from "@ironflow/core";
import { IronflowError, DEFAULT_TIMEOUTS, HEADERS } from "@ironflow/core";
import type { IronflowConfig } from "./config.js";

/**
 * KV bucket handle for key-level operations in the browser.
 */
export class BrowserKVBucketHandle {
  constructor(
    private readonly bucketName: string,
    private readonly config: IronflowConfig
  ) {}

  /**
   * Get a value by key.
   */
  async get(key: string): Promise<KVEntry> {
    return this.restRequest<KVEntry>(
      "GET",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`
    );
  }

  /**
   * Put a value unconditionally.
   */
  async put(key: string, value: unknown): Promise<KVPutResult> {
    return this.restRequest<KVPutResult>(
      "PUT",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      value
    );
  }

  /**
   * Create a value only if the key doesn't exist (if-not-exists).
   */
  async create(key: string, value: unknown): Promise<KVPutResult> {
    return this.restRequest<KVPutResult>(
      "PUT",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      value,
      { "If-None-Match": "*" }
    );
  }

  /**
   * Update a value only if the revision matches (compare-and-swap).
   */
  async update(
    key: string,
    value: unknown,
    revision: number
  ): Promise<KVPutResult> {
    return this.restRequest<KVPutResult>(
      "PUT",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      value,
      { "If-Match": String(revision) }
    );
  }

  /**
   * Delete a key (soft delete / tombstone).
   */
  async delete(key: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`
    );
  }

  /**
   * Purge a key and all its history.
   */
  async purge(key: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}?purge=true`
    );
  }

  /**
   * List keys with an optional wildcard filter.
   */
  async listKeys(filter?: string): Promise<string[]> {
    let path = `/api/v1/kv/buckets/${enc(this.bucketName)}/keys`;
    if (filter) {
      path += `?filter=${encodeURIComponent(filter)}`;
    }
    const result = await this.restRequest<KVListKeysResult>("GET", path);
    return result.keys;
  }

  /**
   * Watch for changes on keys matching a pattern.
   * Uses WebSocket for real-time notifications.
   */
  watch(callbacks: KVWatchCallbacks, options?: KVWatchOptions): KVWatcher {
    const serverUrl = this.config.serverUrl;
    const wsUrl = serverUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    let path = `/api/v1/kv/buckets/${enc(this.bucketName)}/watch`;
    if (options?.key) {
      path += `?key=${encodeURIComponent(options.key)}`;
    }

    const ws = new WebSocket(`${wsUrl}${path}`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as KVWatchEvent;
        if (data.type === "kv_update") {
          callbacks.onUpdate(data);
        }
      } catch (err) {
        callbacks.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    };

    ws.onerror = () => {
      callbacks.onError?.(new Error("KV watch WebSocket error"));
    };

    ws.onclose = () => {
      callbacks.onClose?.();
    };

    return {
      stop: () => {
        ws.close();
      },
    };
  }

  private async restRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const timeout = this.config.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config.environment,
      };

      if (body !== undefined) {
        headers["Content-Type"] =
          typeof body === "string"
            ? "application/octet-stream"
            : "application/json";
      }

      if (this.config.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.auth.apiKey}`;
      }

      if (extraHeaders) {
        Object.assign(headers, extraHeaders);
      }

      const response = await fetch(url, {
        method,
        headers,
        body:
          body !== undefined
            ? typeof body === "string"
              ? body
              : JSON.stringify(body)
            : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `KV request failed: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throw new IronflowError(errorMessage, {
          code: `HTTP_${response.status}`,
          retryable: response.status >= 500,
        });
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (error instanceof IronflowError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(`KV request timeout after ${timeout}ms`, {
          code: "TIMEOUT",
          retryable: true,
        });
      }
      throw new IronflowError(`KV ${method} ${path} failed`, {
        code: "REQUEST_FAILED",
        retryable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Browser KV client for bucket management and key operations.
 */
export class BrowserKVClient {
  constructor(private readonly config: IronflowConfig) {}

  /**
   * Create a new bucket.
   */
  async createBucket(config: KVBucketConfig): Promise<KVBucketInfo> {
    const body: Record<string, unknown> = { name: config.name };
    if (config.description) body.description = config.description;
    if (config.ttlSeconds) body.ttl_seconds = config.ttlSeconds;
    if (config.maxValueSize) body.max_value_size = config.maxValueSize;
    if (config.maxBytes) body.max_bytes = config.maxBytes;
    if (config.history) body.history = config.history;

    return this.restRequest<KVBucketInfo>(
      "POST",
      "/api/v1/kv/buckets",
      body
    );
  }

  /**
   * Delete a bucket.
   */
  async deleteBucket(name: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(name)}`
    );
  }

  /**
   * List all buckets.
   */
  async listBuckets(): Promise<KVBucketInfo[]> {
    const result = await this.restRequest<KVListBucketsResult>(
      "GET",
      "/api/v1/kv/buckets"
    );
    return result.buckets;
  }

  /**
   * Get bucket info.
   */
  async getBucketInfo(name: string): Promise<KVBucketInfo> {
    return this.restRequest<KVBucketInfo>(
      "GET",
      `/api/v1/kv/buckets/${enc(name)}`
    );
  }

  /**
   * Get a bucket handle for key-level operations.
   */
  bucket(name: string): BrowserKVBucketHandle {
    return new BrowserKVBucketHandle(name, this.config);
  }

  private async restRequest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const timeout = this.config.timeout ?? DEFAULT_TIMEOUTS.CLIENT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        [HEADERS.ENVIRONMENT]: this.config.environment,
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (this.config.auth?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.auth.apiKey}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `KV request failed: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throw new IronflowError(errorMessage, {
          code: `HTTP_${response.status}`,
          retryable: response.status >= 500,
        });
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (error instanceof IronflowError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new IronflowError(`KV request timeout after ${timeout}ms`, {
          code: "TIMEOUT",
          retryable: true,
        });
      }
      throw new IronflowError(`KV ${method} ${path} failed`, {
        code: "REQUEST_FAILED",
        retryable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
