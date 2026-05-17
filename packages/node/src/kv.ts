/**
 * Ironflow Node.js KV Client
 *
 * Key-Value store operations for the Ironflow server.
 */

import type {
  KVBucketConfig,
  KVBucketInfo,
  KVEntry,
  KVPutResult,
  KVListKeysResult,
  KVListBucketsResult,
} from "@ironflow/core";
import {
  IronflowError,
  UnauthenticatedError,
  EnterpriseRequiredError,
  UnauthorizedError,
} from "@ironflow/core";
import type { OnErrorHandler, ErrorContext } from "./types.js";

/**
 * Configuration for the KV client (inherited from parent client).
 */
export interface KVClientConfig {
  serverUrl: string;
  apiKey?: string;
  timeout: number;
  onError?: OnErrorHandler;
}

/**
 * KV bucket handle for key-level operations.
 */
export class KVBucketHandle {
  constructor(
    private readonly bucketName: string,
    private readonly config: KVClientConfig
  ) {}

  /**
   * Get a value by key.
   */
  async get(key: string): Promise<KVEntry> {
    return this.restRequest<KVEntry>(
      "GET",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      undefined,
      undefined,
      "kv.bucket.get"
    );
  }

  /**
   * Put a value unconditionally.
   */
  async put(key: string, value: unknown): Promise<KVPutResult> {
    return this.restRequest<KVPutResult>(
      "PUT",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      value,
      undefined,
      "kv.bucket.put"
    );
  }

  /**
   * Create a value only if the key doesn't exist (if-not-exists).
   * Throws on conflict (HTTP 412).
   */
  async create(key: string, value: unknown): Promise<KVPutResult> {
    return this.restRequest<KVPutResult>(
      "PUT",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      value,
      { "If-None-Match": "*" },
      "kv.bucket.create"
    );
  }

  /**
   * Update a value only if the revision matches (compare-and-swap).
   * Throws on mismatch (HTTP 412).
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
      { "If-Match": String(revision) },
      "kv.bucket.update"
    );
  }

  /**
   * Delete a key (soft delete / tombstone).
   */
  async delete(key: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}`,
      undefined,
      undefined,
      "kv.bucket.delete"
    );
  }

  /**
   * Purge a key and all its history.
   */
  async purge(key: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(this.bucketName)}/keys/${key}?purge=true`,
      undefined,
      undefined,
      "kv.bucket.purge"
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
    const result = await this.restRequest<KVListKeysResult>("GET", path, undefined, undefined, "kv.bucket.listKeys");
    return result.keys;
  }

  private async callOnError(error: Error, context: ErrorContext): Promise<void> {
    if (!this.config.onError) return;
    try {
      await this.config.onError(error, context);
    } catch (callbackError) {
      console.error("[ironflow] onError callback threw:", callbackError);
    }
  }

  private async restRequest<T>(
    httpMethod: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    clientMethod?: string
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers["Content-Type"] =
        typeof body === "string" || body instanceof Uint8Array
          ? "application/octet-stream"
          : "application/json";
    }

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: httpMethod,
        headers,
        body:
          body !== undefined
            ? typeof body === "string" || body instanceof Uint8Array
              ? body
              : JSON.stringify(body)
            : undefined,
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `KV request failed with status ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throwTypedError(response.status, errorMessage);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (clientMethod) {
        await this.callOnError(error as Error, { method: clientMethod, endpoint: path, statusCode: status });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * KV client for bucket management and key operations.
 */
export class KVClient {
  constructor(private readonly config: KVClientConfig) {}

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
      body,
      "kv.createBucket"
    );
  }

  /**
   * Delete a bucket.
   */
  async deleteBucket(name: string): Promise<void> {
    await this.restRequest<void>(
      "DELETE",
      `/api/v1/kv/buckets/${enc(name)}`,
      undefined,
      "kv.deleteBucket"
    );
  }

  /**
   * List all buckets.
   */
  async listBuckets(): Promise<KVBucketInfo[]> {
    const result = await this.restRequest<KVListBucketsResult>(
      "GET",
      "/api/v1/kv/buckets",
      undefined,
      "kv.listBuckets"
    );
    return result.buckets;
  }

  /**
   * Get bucket info.
   */
  async getBucketInfo(name: string): Promise<KVBucketInfo> {
    return this.restRequest<KVBucketInfo>(
      "GET",
      `/api/v1/kv/buckets/${enc(name)}`,
      undefined,
      "kv.getBucketInfo"
    );
  }

  /**
   * Get a bucket handle for key-level operations.
   */
  bucket(name: string): KVBucketHandle {
    return new KVBucketHandle(name, this.config);
  }

  private async callOnError(error: Error, context: ErrorContext): Promise<void> {
    if (!this.config.onError) return;
    try {
      await this.config.onError(error, context);
    } catch (callbackError) {
      console.error("[ironflow] onError callback threw:", callbackError);
    }
  }

  private async restRequest<T>(
    httpMethod: string,
    path: string,
    body?: unknown,
    clientMethod?: string
  ): Promise<T> {
    const url = `${this.config.serverUrl}${path}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    let status: number | undefined;
    try {
      const response = await fetch(url, {
        method: httpMethod,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      status = response.status;

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `KV request failed with status ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error) errorMessage = errorJson.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throwTypedError(response.status, errorMessage);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (clientMethod) {
        await this.callOnError(error as Error, { method: clientMethod, endpoint: path, statusCode: status });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function throwTypedError(status: number, message: string): never {
  switch (status) {
    case 401:
      throw new UnauthenticatedError(message);
    case 402:
      throw new EnterpriseRequiredError(message);
    case 403:
      throw new UnauthorizedError(message);
    default:
      throw new IronflowError(message, { code: `HTTP_${status}` });
  }
}
