/**
 * Shared types for the offline write queue (ADR 0052).
 */

/** The record schema version this SDK writes and understands. */
export const RECORD_VERSION = 1;

/**
 * Why a write will never be sent.
 *
 * To an application all three mean the same thing — this write is not happening,
 * tell the user — which is why they arrive on one `onWriteLost` callback rather
 * than several.
 *
 * Hitting the item/byte cap is NOT in this list: `enqueue()` throws
 * `QueueFullError` synchronously and stores nothing, so there is no queued write
 * to report lost. Callers learn about a full queue from the throw.
 */
export type WriteLostReason =
  /** Sat in the outbox past `maxRetentionTime` without being delivered. */
  | "expired"
  /** Server refused it permanently (a 4xx that is not 401). */
  | "rejected"
  /** Written under a different `queueIdentity`; quarantined, never deleted. */
  | "identity-mismatch"
  /**
   * Enqueued against a different server or environment than the client now
   * points at. Quarantined rather than sent: a staging write must never land in
   * production just because `configure()` was called while it was queued.
   */
  | "destination-mismatch"
  /** Record names a `kind` this SDK has no endpoint for. */
  | "unknown-kind";

/** Which endpoint family a queued write belongs to. */
export type QueuedWriteKind = "emit" | "stream-append";

/**
 * One write, serialised to the exact bytes that will be POSTed.
 *
 * Serialising at enqueue rather than at send is deliberate. IndexedDB's
 * structured clone accepts values `JSON.stringify` later rejects or mangles
 * (cycles, `BigInt`), so storing the live object risks telling the caller
 * "saved" for a write that can never be transmitted. It also yields an exact
 * byte size for the cap.
 */
export interface QueuedWrite {
  /**
   * Record schema version.
   *
   * A value greater than {@link RECORD_VERSION} means a NEWER SDK wrote this —
   * after a rollback, or from another tab running a newer build. Such records
   * are left strictly untouched and block this client from draining, because
   * destroying data we simply do not understand yet is unrecoverable.
   */
  v: number;
  /** FIFO key. Assigned by IndexedDB's autoIncrement; insertion order is send order. */
  seq: number;
  /** Client-side handle, returned to the caller and used by `queue.watch()`. */
  localId: string;
  /**
   * Engine dedup key, generated at ENQUEUE.
   *
   * Generating it here rather than at send is what makes a retry after a page
   * reload safe: the same key reaches the engine, which returns the original
   * event instead of creating a second one.
   */
  idempotencyKey: string;
  /**
   * Which endpoint to POST to.
   *
   * The path is DERIVED from this at send time, never read from the record.
   * Replaying a stored path would make the outbox a durable write primitive:
   * anything that can write to IndexedDB once (XSS, a user editing storage)
   * could aim an authenticated POST at an arbitrary endpoint, and it would fire
   * later under freshly refreshed credentials.
   */
  kind: QueuedWriteKind;
  /** Server this write was enqueued against; verified before sending. */
  serverUrl: string;
  /** Environment this write was enqueued against; verified before sending. */
  environment: string;
  /** Exact JSON request body. */
  body: string;
  /** `body` length in bytes, for the size cap. */
  bytes: number;
  /** ms since epoch at enqueue; drives `maxRetentionTime`. */
  enqueuedAt: number;
  /**
   * The `queueIdentity` in effect when this was enqueued.
   *
   * Compared at flush so one user's queue never drains as the next user on a
   * shared machine. An explicit app-supplied string rather than a hash of the
   * credential: hashing identifies the *credential*, so a token rotation would
   * make the same user look like a different one.
   */
  identity: string;
}

/** A write that will not be retried, kept so it can be inspected or replayed. */
export interface DeadLetteredWrite {
  write: QueuedWrite;
  reason: WriteLostReason;
  /** Human-readable cause, e.g. the server's error message. */
  message: string;
  deadLetteredAt: number;
}

/** Lifecycle of the drainer. */
export type QueueState =
  /** Nothing to send. */
  | "idle"
  /** Actively draining. */
  | "flushing"
  /** Waiting on re-authentication, or backing off after a retryable failure. */
  | "paused"
  /**
   * Refusing to drain because the outbox holds records from a newer SDK.
   * Enqueue still works; delivery waits for a build that understands them.
   */
  | "blocked";

/** Snapshot delivered to `queue.subscribe()`. */
export interface QueueStats {
  /** Writes waiting to be sent. */
  pending: number;
  /** 1 while a write is in flight, else 0. Kept numeric for easy display. */
  inFlight: number;
  /**
   * Writes in the current drain session, so a UI can show "34 of 500".
   *
   * A full 500-item queue drains in 500 sequential round trips (~50s at 100ms
   * RTT) — the accepted cost of strict FIFO. A progress number is the
   * difference between that feeling slow and feeling broken.
   */
  total: number;
  deadLettered: number;
  state: QueueState;
}

/** Per-item status from `queue.watch(localId)`. */
export type WriteStatus =
  | { status: "pending" }
  | { status: "sent"; eventId?: string; entityVersion?: number }
  | { status: "lost"; reason: WriteLostReason; message: string };
