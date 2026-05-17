import { IronflowError } from "@ironflow/core";
import type { KVClient } from "./kv.js";

/** Default TTL for command dedup entries: 7 days. Pass to CommandDedupOptions.ttlSeconds. */
export const DEFAULT_COMMAND_DEDUP_TTL_SECONDS = 604800;

export interface CommandDedupOptions {
  /** TTL in seconds. Default: 604800 (7 days). Pass 0 for no expiry. */
  ttlSeconds?: number;
}

function isHTTPCode(err: unknown, code: string): boolean {
  return err instanceof IronflowError && err.code === code;
}

function encodeKey(commandId: string): string {
  return encodeURIComponent(commandId);
}

function encodeValue<T>(value: T): string {
  return JSON.stringify(value);
}

function decodeKVValue<T>(base64: string): T {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as T;
}

/**
 * Atomic command-level idempotency backed by NATS KV.
 *
 * Uses the claim-first pattern: TryClaim atomically reserves the commandId
 * before any handler work is done. The winner returns null and proceeds.
 * Losers receive the prior entry immediately without re-running the handler.
 *
 * Typical usage:
 * ```typescript
 * const prior = await dedup.tryClaim(commandId, { orderId, claimedAt: new Date().toISOString() });
 * if (prior !== null) return prior; // duplicate — return cached result
 * try {
 *   const result = await runHandler();
 *   await dedup.finalize(commandId, result);
 *   return result;
 * } catch (err) {
 *   await dedup.release(commandId).catch(() => {});
 *   throw err;
 * }
 * ```
 */
export class CommandDedup<T> {
  private bucketReady: Promise<void> | null = null;
  private readonly ttlSeconds: number;

  constructor(
    private readonly kvClient: KVClient,
    private readonly bucketName: string,
    ttlSeconds?: number,
  ) {
    this.ttlSeconds = ttlSeconds ?? DEFAULT_COMMAND_DEDUP_TTL_SECONDS;
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        try {
          await this.kvClient.createBucket({
            name: this.bucketName,
            ttlSeconds: this.ttlSeconds,
          });
        } catch (e) {
          if (!isHTTPCode(e, "HTTP_409")) {
            this.bucketReady = null; // reset so the next call retries
            throw e;
          }
          // 409 = bucket already exists — fine
        }
      })();
    }
    return this.bucketReady;
  }

  /**
   * Atomically claim commandId. Returns null if this caller wins the race
   * (proceed to run the handler). Returns the prior T if another caller
   * already claimed this commandId (return it as the deduplicated response).
   *
   * The returned T may be the initial claim if the winner has not yet called
   * finalize(). Design T with optional fields for data only available after
   * finalize (e.g. `entityVersion?: number`).
   */
  async tryClaim(commandId: string, claim: T): Promise<T | null> {
    await this.ensureBucket();
    const key = encodeKey(commandId);
    const bucket = this.kvClient.bucket(this.bucketName);
    try {
      await bucket.create(key, encodeValue(claim));
      return null; // winner
    } catch (e) {
      if (!isHTTPCode(e, "HTTP_412")) throw e;
      // loser — read winner's entry
      try {
        const entry = await bucket.get(key);
        if (entry?.value == null) return null;
        return decodeKVValue<T>(entry.value as string);
      } catch (readErr) {
        if (isHTTPCode(readErr, "HTTP_404")) return null; // concurrent delete race
        throw readErr;
      }
    }
  }

  /**
   * Finalize the claim with the handler's result. Subsequent callers that
   * tryClaim the same commandId will receive this value.
   */
  async finalize(commandId: string, result: T): Promise<void> {
    await this.ensureBucket();
    await this.kvClient.bucket(this.bucketName).put(encodeKey(commandId), encodeValue(result));
  }

  /**
   * Release the claim so retries can proceed after a handler failure.
   * Swallows 404 (already released — idempotent).
   *
   * IMPORTANT: Only call release() in a catch block before finalize() succeeds.
   * Calling release() after finalize() deletes the finalized result and allows
   * replay of the command.
   */
  async release(commandId: string): Promise<void> {
    await this.ensureBucket();
    try {
      await this.kvClient.bucket(this.bucketName).delete(encodeKey(commandId));
    } catch (e) {
      if (isHTTPCode(e, "HTTP_404")) return; // already released
      throw e;
    }
  }
}
