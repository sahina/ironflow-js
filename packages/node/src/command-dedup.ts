import { IronflowError } from "@ironflow/core";
import type { KVEntry } from "@ironflow/core";
import type { KVClient } from "./kv.js";

/** Default TTL for command dedup entries: 7 days. Pass to CommandDedupOptions.ttlSeconds. */
export const DEFAULT_COMMAND_DEDUP_TTL_SECONDS = 604800;

/** Bound on create-write / read-back rounds when the winner keeps releasing between them. */
const CLAIM_ATTEMPTS = 3;

export interface CommandDedupOptions {
  /** TTL in seconds. Default: 604800 (7 days). Pass 0 for no expiry. */
  ttlSeconds?: number;
}

// Match the HTTP status, not the code: the KV write throttle's 507 also answers
// failed_precondition, and it is not a lost claim race.
function isHTTPStatus(err: unknown, status: number): boolean {
  return err instanceof IronflowError && err.status === status;
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
 * Later callers receive the prior entry, which may still be pending. Reconcile
 * pending claims against idempotent effects before reporting completion.
 *
 * Typical usage:
 * ```typescript
 * type Entry<T> = { status: 'claimed' } | { status: 'done'; result: T };
 * const dedup = client.commandDedup<Entry<OrderResult>>('order-commands');
 *
 * const prior = await dedup.tryClaim(commandId, { status: 'claimed' });
 * if (prior !== null) {
 *   if (prior.status === 'done') return prior.result;
 *   throw new Error('Command is pending; reconcile its effects before retrying');
 * }
 *
 * let result: OrderResult;
 * try {
 *   result = await runHandler(); // Effects must support idempotent retries.
 * } catch (err) {
 *   await dedup.release(commandId).catch(() => {}); // Only the claim winner reaches here.
 *   throw err;
 * }
 * await dedup.finalize(commandId, { status: 'done', result });
 * return result;
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
          if (!isHTTPStatus(e, 409)) {
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
   * already claimed this commandId. A prior claim is not necessarily a result.
   *
   * If the winner releases between the create and the read-back (404), the claim is
   * tried again, up to 3 times. After 3 lost rounds this throws an IronflowError with
   * code `COMMAND_DEDUP_RACE`.
   *
   * If the create fails with an error other than 412, the claim state is unknown: the
   * write may have committed, and it is not retried. Pass `isOwner` so a later retry
   * can recognize its own orphaned claim: put a token that stays the same across
   * retries in the claim and compare it. `isOwner` runs only on a prior entry. It must
   * return false for a finalized result (keep the token out of the result, or check a
   * status field), or a finished command replays. Run one retry lineage at a time: two
   * concurrent callers sharing a token both win.
   *
   * The returned T may be the initial claim if the winner has not yet called
   * finalize(). Design T with optional fields for data only available after
   * finalize (e.g. `entityVersion?: number`).
   */
  async tryClaim(commandId: string, claim: T, isOwner?: (prior: T) => boolean): Promise<T | null> {
    await this.ensureBucket();
    const key = encodeKey(commandId);
    const bucket = this.kvClient.bucket(this.bucketName);
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      try {
        await bucket.create(key, encodeValue(claim));
        return null; // winner
      } catch (e) {
        if (!isHTTPStatus(e, 412)) throw e;
      }
      // loser — read winner's entry
      let entry: KVEntry;
      try {
        entry = await bucket.get(key);
      } catch (readErr) {
        if (isHTTPStatus(readErr, 404)) continue; // winner released between our write and read: claim again
        throw readErr;
      }
      if (entry.value == null) continue;
      const prior = decodeKVValue<T>(entry.value as string);
      return isOwner?.(prior) ? null : prior;
    }
    throw new IronflowError(
      `command dedup: claim for "${commandId}" lost the race ${CLAIM_ATTEMPTS} times`,
      { code: "COMMAND_DEDUP_RACE" },
    );
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
      if (isHTTPStatus(e, 404)) return; // already released
      throw e;
    }
  }
}
