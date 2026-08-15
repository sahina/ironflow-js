/**
 * The offline write queue (ADR 0052).
 *
 * Write-through outbox: every eligible write is persisted BEFORE anything is
 * attempted over the network, and a single drainer sends them in strict order.
 *
 *   enqueue ──> serialize ──> cap check ──> IndexedDB ──> {queued, localId}
 *                   │             │
 *              (throws)      (QueueFullError)          nothing was stored
 *
 *   drain (under the flush lock, one tab at a time):
 *
 *      head ─┬─ record from a newer SDK ──> state=blocked, STOP (never destroy)
 *            ├─ identity mismatch ────────> dead-letter, next
 *            ├─ older than retention ─────> dead-letter, next
 *            └─ send ─┬─ ok ──────────────> remove, notify watchers, next
 *                     ├─ 401 ─────────────> release lock, onAuthRequired, retry
 *                     ├─ retryable ───────> release lock, backoff, retry (head stays)
 *                     └─ other 4xx ───────> dead-letter, next
 *
 * There is no "am I online?" check anywhere. Writes travel by bare `fetch`, and
 * the SDK's transport is only the subscription channel, so a write-only app
 * never opens a connection whose state could be observed. A successful send IS
 * the online signal. Nothing listens for `online` or `visibilitychange`, so a
 * tab that regains the network waits out the armed backoff (up to 60s) unless
 * the app calls `flush()` itself.
 *
 * ponytail: five behaviours here are verified by hand, not by CI — reload
 * survival, two-tab exclusion, real quota exhaustion, Safari eviction, and FIFO
 * under write-through. jsdom has no IndexedDB and no Web Locks, so the suite
 * runs on fakes. The checklist is OFFLINE-QA.md; the upgrade path is real
 * browser mode, blocked on a workspace-wide vitest 2 -> 4 bump (TODOS.md).
 * A green test run does NOT cover those five.
 */
import { IronflowError, QueueFullError } from "@ironflow/core";
import { QueueDb, QueueQuotaError, type NewQueuedWrite } from "./db.js";
import { newUuid } from "./ids.js";
import { LOCK_BUSY, withFlushLock } from "./lock.js";
import {
  RECORD_VERSION,
  type QueuedWrite,
  type QueuedWriteKind,
  type QueueStats,
  type QueueState,
  type WriteLostReason,
  type WriteStatus,
} from "./types.js";

/** What the drainer gets back from a successful send. */
export interface SendOutcome {
  eventId?: string;
  entityVersion?: number;
}

export interface OfflineQueueOptions {
  /** IndexedDB database name; scoped by the caller to serverUrl + environment. */
  dbName: string;
  /**
   * Stable, app-supplied identity for the current principal.
   *
   * Not a hash of the credential: hashing identifies the credential, so
   * rotating a token would make the same user look like a different one.
   */
  identity: string;
  /** Sends one write to `path`. Injected so the queue never imports the client. */
  send: (path: string, write: QueuedWrite) => Promise<SendOutcome>;
  /** Endpoint for a write kind, or null if this SDK has none. */
  resolvePath: (kind: QueuedWriteKind) => string | null;
  /** The destination the client points at RIGHT NOW, read at send time. */
  currentDestination: () => { serverUrl: string; environment: string };
  maxItems?: number;
  maxBytes?: number;
  maxRetentionMs?: number;
  maxDeadLettered?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  stopGraceMs?: number;
  /** How long `onAuthRequired` may take before the attempt is abandoned. */
  authTimeoutMs?: number;
  /** Called once per write that will never be sent. */
  onWriteLost?: (write: QueuedWrite, reason: WriteLostReason, message: string) => void;
  /**
   * Called when the server rejects a write with 401.
   *
   * The queue pauses (it does not dead-letter) and resumes once this resolves.
   * 403 is deliberately NOT routed here: this codebase uses 403 for
   * insufficient permissions, which no amount of re-authentication fixes, so
   * pausing on it would wait forever.
   */
  onAuthRequired?: () => Promise<{ identity?: string } | void>;
  /** Injectable clock, for retention tests. */
  now?: () => number;
  /**
   * Injectable timer, so tests need not wait out real backoff.
   * May return a cancel function; flush() and stop() use it to drop a pending
   * retry instead of leaving an orphan timer running.
   */
  schedule?: (fn: () => void, ms: number) => (() => void) | void;
}

const DEFAULTS = {
  /** An order of magnitude above telemetry SDKs (Sentry 30, Segment 100): these are business writes. */
  maxItems: 500,
  maxBytes: 5 * 1024 * 1024,
  /** Workbox's model. A write queued nine days ago is usually harmful to deliver. */
  maxRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Ordering is irrelevant for writes that are already never going to be sent. */
  maxDeadLettered: 100,
  backoffInitialMs: 1_000,
  backoffMaxMs: 60_000,
  /** How long stop() lets an in-flight send finish before closing the DB. */
  stopGraceMs: 2_000,
  /**
   * How long to wait for `onAuthRequired` before giving up on this attempt.
   *
   * Generous, because the honest case is a human reading a login form. The
   * point is not to rush them — it is that an app callback which NEVER settles
   * (a dismissed modal whose promise is dropped, an auth server that hangs)
   * must not hold the drain loop open forever. See `reauthenticate`.
   */
  authTimeoutMs: 5 * 60 * 1000,
};

/**
 * Run an application callback without letting it break the queue.
 *
 * A subscriber that throws during `enqueue` would otherwise reject a call whose
 * write is ALREADY stored — the caller would reasonably retry, generating a new
 * idempotency key for a write that is still queued, and the engine would see two
 * distinct events.
 */
function safely<T>(fn: (value: T) => void, value: T): void {
  try {
    fn(value);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[ironflow] offline queue callback threw", error);
  }
}

/**
 * How many times a raced counter refresh re-reads before giving up.
 *
 * Bounded so a queue under continuous local mutation cannot spin re-reading
 * the whole store. Giving up is safe rather than final: the next announce asks
 * again, and draining to empty re-derives the counters from scratch.
 */
const MAX_REFRESH_RETRIES = 5;

/** How the drainer should react to a failed send. */
type Disposition = "retry" | "auth" | "poison";

/** Why a drain session stopped. Decided inside the lock, acted on outside it. */
type SessionEnd = "idle" | "blocked" | "retry" | "auth";

/**
 * Classify a send failure.
 *
 * Reuses `IronflowError.retryable`, which the shared `send()` already sets from
 * the HTTP status, rather than growing a second rule that drifts from the first.
 */
export function classifyFailure(error: unknown): Disposition {
  if (!(error instanceof IronflowError)) {
    // A thrown non-Ironflow error is a network/runtime fault: worth retrying.
    return "retry";
  }
  // Key off the HTTP status. `code` is `errorBody?.code ?? HTTP_<status>`, so a
  // proxy or a Connect handler that puts its own `code` in the body replaces it
  // — a 401 arriving as {"code":"unauthenticated"} would miss a string match and
  // be dead-lettered instead of pausing for re-auth. The code comparisons stay
  // as a fallback for errors built without a status.
  if (
    error.status === 401 ||
    error.code === "HTTP_401" ||
    error.code.toUpperCase() === "UNAUTHENTICATED"
  ) {
    return "auth";
  }
  return error.retryable ? "retry" : "poison";
}

export class OfflineQueue {
  private db: QueueDb | null = null;
  private opts: Required<
    Omit<OfflineQueueOptions, "onWriteLost" | "onAuthRequired">
  > &
    Pick<OfflineQueueOptions, "onWriteLost" | "onAuthRequired">;

  private state: QueueState = "idle";
  private pending = 0;
  private bytes = 0;
  private deadLettered = 0;
  private inFlight = 0;
  private sessionTotal = 0;
  private attempt = 0;

  private draining = false;
  private stopped = false;
  /** A backoff retry is already armed; don't stack a second timer on top. */
  private retryArmed = false;
  /** Cancels the armed retry. Without it, flush() would orphan the timer. */
  private cancelRetry: (() => void) | null = null;
  /** A counter refresh is already queued; collapse a burst into one re-read. */
  private refreshQueued = false;
  /** Counter mutations straddling an await right now. See {@link mutate}. */
  private counterMutations = 0;
  /** Bumped by every completed counter mutation, so a racing read can tell. */
  private counterEpoch = 0;
  /** Consecutive refreshes discarded for racing a local mutation. */
  private refreshRetries = 0;
  /**
   * A drain was requested while one was already running.
   *
   * Without this, a write enqueued in the window between the drainer reading an
   * empty head and returning idle is stranded: its `drain()` call is dropped as
   * a duplicate, and the idle path arms no timer to come back. Nothing would
   * send it until the next enqueue, an explicit flush, or a page reload.
   */
  private drainRequested = false;
  /** Cross-tab counter sync; null when BroadcastChannel is unavailable. */
  private channel: BroadcastChannel | null = null;

  private readonly statsSubs = new Set<(s: QueueStats) => void>();
  private readonly watchers = new Map<string, Set<(s: WriteStatus) => void>>();

  constructor(options: OfflineQueueOptions) {
    // Object spread copies own keys even when the value is undefined, so a
    // caller passing `maxItems: undefined` overwrites the default with
    // undefined rather than falling back to it. `createClient` forwards every
    // optional cap unconditionally, so that is the NORMAL path, not an edge
    // case — left unfiltered it silently disables all four limits: the cap
    // comparisons become `n > undefined` (always false, so the queue never
    // fills), retention becomes `age > undefined` (nothing ever expires), and
    // trimDeadLettered slices to NaN (the dead-letter store grows forever).
    const provided = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    ) as Partial<OfflineQueueOptions>;

    this.opts = {
      ...DEFAULTS,
      now: () => Date.now(),
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      ...provided,
    } as typeof this.opts;
  }

  /** Open the database and hydrate the in-memory counters. */
  async start(): Promise<void> {
    this.db = await QueueDb.open(this.opts.dbName);

    await this.refreshCounters();

    // Counters live in memory from here. Counting the store on every change
    // would double the I/O that write-through already pays.
    if (await this.db.hasFutureRecords()) {
      this.setState("blocked");
    }

    this.openChannel();
    this.emitStats();
    void this.drain();
  }

  /**
   * Keep sibling tabs' counters honest.
   *
   * The flush lock stops two tabs draining at once, but it does nothing for
   * their *counters*: an in-memory `pending` in tab A cannot see tab B enqueue
   * or drain, so B's badge silently goes stale. A `BroadcastChannel` ping tells
   * the others to re-read, which keeps the cheap in-memory counters without
   * making them per-tab fiction.
   */
  private openChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;

    this.channel = new BroadcastChannel(`ironflow-queue:${this.opts.dbName}`);
    this.channel.onmessage = () => {
      // Re-read only. Never re-broadcast, or two tabs ping-pong forever.
      //
      // Coalesced across the WHOLE cycle, not just the microtask that starts
      // it. The flag used to be cleared on the first line inside the microtask,
      // before any of the awaits below had run — so every announce started its
      // own pass. A sibling draining N writes announces once per write, and a
      // pass costs a full-store read plus two indexed reads per live watcher,
      // which made a burst O(N*M) rather than the O(1)-per-burst claimed here.
      this.requestRefresh();
    };
  }

  /**
   * Ask for a counter re-read, coalescing a burst into a single pass.
   *
   * Also the retry path for a read discarded by {@link counterRaced} — nothing
   * else re-runs a refresh, so dropping one silently lets this tab under-count
   * a sibling's writes for good and over-admit against its own cap.
   */
  private requestRefresh(): void {
    if (this.stopped || !this.db) return;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      void this.refreshCounters()
        .then(() => this.emitStats())
        .then(() => this.reconcileWatchers())
        .catch((error) => {
          // The chain is fire-and-forget, so a rejection escaping it is an
          // unhandled rejection. stop() closing the database between two of
          // these awaits is the ordinary way that happens, not a defensive
          // case — reconcileWatchers reads storage once per live watcher.
          // eslint-disable-next-line no-console
          console.error("[ironflow] offline queue refresh failed", error);
        })
        .finally(() => {
          this.refreshQueued = false;
          // In `finally` so it still runs when the pass above failed:
          // nothing arms a retry on the blocked path, so a tab that dropped
          // the one announcement carrying "the future record is gone" would
          // wait for an enqueue or a "Retry now" click to notice.
          if (this.state === "blocked") void this.drain();
        });
    });
  }

  /**
   * Re-resolve every live watcher against storage.
   *
   * `notifyWatcher` runs on the drain path, so it only ever fires in the tab
   * that did the draining. Without this, a write enqueued in tab A and
   * delivered by tab B leaves A's watcher on its provisional "pending" forever
   * and leaks its entry for the life of the page — and multi-tab is exactly
   * what the channel was added for.
   *
   * Inherits `resolveStatus`'s v1 limit: a localId in neither store reads as
   * "sent", which is wrong for an evicted dead letter or an origin Safari
   * cleared. Documented under Limits in the browser SDK reference.
   *
   * ponytail: two indexed reads per live watcher per refresh. Fine for a UI
   * watching a handful of rows; if an app ever watches hundreds while a
   * sibling drains a backlog, carry the drained localIds in the broadcast
   * message instead of re-reading storage.
   */
  private async reconcileWatchers(): Promise<void> {
    for (const localId of [...this.watchers.keys()]) {
      const status = await this.resolveStatus(localId);
      if (status.status === "pending") continue;
      this.notifyWatcher(localId, status);
    }
  }

  /** Announce that this tab changed the stored state. */
  private announce(): void {
    this.channel?.postMessage("changed");
  }

  private async refreshCounters(): Promise<void> {
    if (!this.db) return;
    const mark = this.counterMark();
    const usage = await this.db.usage();
    const deadLettered = await this.db.countDeadLettered();
    // Discard a read that raced a local counter change. This assignment is
    // wholesale, and enqueue reserves against the cap BEFORE its await while
    // the drain and dead-letter paths decrement AFTER theirs — so a read
    // straddling one of those windows commits a value that predates the change
    // the local counter already carries, leaving it permanently off by one. In
    // the permissive direction, which lets the cap admit writes past its limit.
    if (this.counterRaced(mark)) {
      // Re-read instead of dropping it. Nothing else re-runs a refresh, so a
      // discarded read leaves this tab permanently blind to whatever a sibling
      // stored — and blind in the permissive direction, so its cap then admits
      // writes past the limit.
      //
      // Re-armed on a macrotask, not a microtask: the mutation that lost us
      // this read is parked on an IndexedDB callback, and a microtask would
      // burn every attempt before that callback can run. A real timer rather
      // than `opts.schedule`, which is the injectable *backoff* clock — tests
      // hold it deliberately, and delivery must not depend on them releasing it.
      if (this.refreshRetries < MAX_REFRESH_RETRIES) {
        this.refreshRetries += 1;
        setTimeout(() => this.requestRefresh(), 0);
      }
      return;
    }

    this.refreshRetries = 0;
    this.pending = usage.count;
    this.bytes = usage.bytes;
    this.deadLettered = deadLettered;
  }

  /** Snapshot taken before a store read whose result will overwrite a counter. */
  private counterMark(): { epoch: number; live: boolean } {
    return { epoch: this.counterEpoch, live: this.counterMutations > 0 };
  }

  /**
   * Whether a counter mutation overlapped the read this mark was taken for —
   * in flight at either end, or begun and finished in between.
   */
  private counterRaced(mark: { epoch: number; live: boolean }): boolean {
    return (
      mark.live || this.counterMutations > 0 || this.counterEpoch !== mark.epoch
    );
  }

  /**
   * Mark a section whose store mutation and in-memory counter update straddle
   * an await, so a concurrent {@link refreshCounters} knows to discard its read.
   */
  private async mutate<T>(op: () => Promise<T>): Promise<T> {
    this.counterMutations += 1;
    try {
      return await op();
    } finally {
      this.counterMutations -= 1;
      this.counterEpoch += 1;
    }
  }

  /**
   * Stop draining and close the database. Safe to call mid-flight.
   *
   * Gives an in-flight send a bounded grace period to finish, rather than
   * abandoning a write whose fate would then be unknown. Bounded because a send
   * can be stuck behind the client's own request timeout, and a `close()` that
   * blocks for 30s is its own bug — after the grace period the database closes
   * and the drain loop's next store call fails harmlessly.
   */
  async stop(stopGraceMs = this.opts.stopGraceMs): Promise<void> {
    this.stopped = true;
    // Otherwise a pending 60s backoff keeps this queue and its closures alive
    // long after close().
    this.clearRetry();

    const deadline = Date.now() + stopGraceMs;
    while (this.draining && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 0));
    }

    this.channel?.close();
    this.channel = null;
    this.db?.close();
    this.db = null;
  }

  // --------------------------------------------------------------------------
  // Enqueue
  // --------------------------------------------------------------------------

  /**
   * Persist a write and return its handles.
   *
   * Serialisation happens before the IndexedDB transaction: structured clone
   * accepts values `JSON.stringify` later rejects (cycles, `BigInt`), and
   * reporting "saved" for a write that can never be transmitted is worse than
   * failing now. It also gives an exact byte size for the cap.
   *
   * @throws {QueueFullError} at the item cap, byte cap, or storage quota.
   */
  async enqueue(input: {
    kind: QueuedWriteKind;
    body: unknown;
    idempotencyKey?: string;
  }): Promise<{ localId: string; idempotencyKey: string }> {
    const db = this.requireDb();

    // JSON.stringify THROWS for cycles and BigInt and RETURNS undefined for
    // `undefined` — the original guard only covered the second, so the common
    // cases surfaced as a bare TypeError instead of the documented coded error.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(input.body);
    } catch (error) {
      throw new IronflowError(
        `Write is not JSON-serializable and cannot be queued: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: "QUEUE_UNSERIALIZABLE", retryable: false }
      );
    }
    if (serialized === undefined) {
      throw new IronflowError(
        "Write is not JSON-serializable and cannot be queued",
        { code: "QUEUE_UNSERIALIZABLE", retryable: false }
      );
    }
    // Real bytes, not UTF-16 code units: a CJK or emoji body undercounts by up
    // to 3x with .length, which would let the byte cap admit far more than it
    // promises — on a mechanism whose whole job is staying inside a quota.
    const bytes = new TextEncoder().encode(serialized).length;

    if (this.pending + 1 > this.opts.maxItems) {
      throw new QueueFullError(
        `Offline write queue is full (${this.opts.maxItems} writes pending)`
      );
    }
    if (this.bytes + bytes > this.opts.maxBytes) {
      throw new QueueFullError(
        `Offline write queue is full (${this.opts.maxBytes} bytes)`
      );
    }

    const destination = this.opts.currentDestination();
    const record: NewQueuedWrite = {
      v: RECORD_VERSION,
      localId: newUuid(),
      idempotencyKey: input.idempotencyKey ?? newUuid(),
      kind: input.kind,
      serverUrl: destination.serverUrl,
      environment: destination.environment,
      body: serialized,
      bytes,
      enqueuedAt: this.opts.now(),
      identity: this.opts.identity,
    };

    // Reserve before awaiting: two concurrent enqueues would otherwise both
    // read the same pre-append counters and both pass a cap that only had room
    // for one. Rolled back if the write does not land.
    this.pending += 1;
    this.bytes += bytes;

    try {
      await this.mutate(() => db.append(record));
    } catch (error) {
      this.pending -= 1;
      this.bytes -= bytes;
      this.emitStats();
      if (error instanceof QueueQuotaError) {
        throw new QueueFullError(error.message);
      }
      throw error;
    }

    this.emitStats();
    this.announce();

    void this.drain();

    return { localId: record.localId, idempotencyKey: record.idempotencyKey };
  }

  // --------------------------------------------------------------------------
  // Drain
  // --------------------------------------------------------------------------

  /**
   * Ask the drainer to run. Idempotent; concurrent calls collapse into one.
   *
   * The loop exists so a pause for re-authentication can resume *without*
   * holding the flush lock: `drainSession` returns, the lock is released,
   * credentials are refreshed, and only then do we go round again. Recursing
   * from inside the session would keep the lock across a login prompt, which is
   * exactly what other tabs must not be stuck behind.
   */
  async drain(): Promise<void> {
    if (this.stopped || !this.db) return;
    // Deliberately NOT short-circuited on `blocked`. A cross-version window is
    // transient — the sibling tab on the newer build drains its own records
    // away — but an early return here made the state terminal for the life of
    // the page: nothing re-checked, so even flush() (a "Retry now" button) did
    // nothing. drainSession re-reads the head every time and re-blocks if the
    // unreadable record is still there, which costs one cursor read.
    // Already draining: record the request rather than dropping it, so a write
    // that lands while this session is winding down still gets sent.
    if (this.draining) {
      this.drainRequested = true;
      return;
    }

    this.draining = true;
    try {
      // At most one re-auth per drain: if fresh credentials still get a 401,
      // looping would hammer the login path forever.
      let mayReauthenticate = true;
      // Set here, not only inside drainSession: a tab that keeps losing the
      // flush lock never enters the session and would report "20 of 0".
      this.sessionTotal = this.pending;

      for (;;) {
        this.drainRequested = false;

        const outcome = await withFlushLock(
          `ironflow-queue-flush:${this.opts.dbName}`,
          () => this.drainSession()
        );

        if (outcome === LOCK_BUSY) {
          // Another tab is draining. Not an error — check back later. Report it
          // as paused rather than idle: a stuck lock holder would otherwise let
          // pending grow to the cap while stats() still said "idle".
          this.setState("paused");
          this.scheduleRetry();
          return;
        }

        if (outcome === "auth" && mayReauthenticate) {
          mayReauthenticate = false;
          if (await this.reauthenticate()) {
            this.attempt = 0;
            continue;
          }
          this.scheduleRetry();
          return;
        }

        if (outcome === "auth" || outcome === "retry") {
          this.scheduleRetry();
          return;
        }

        // Idle, but something was enqueued while we were finishing — go again
        // rather than leaving it stranded with no timer armed.
        if (outcome === "idle" && this.drainRequested) continue;

        return; // idle or blocked
      }
    } catch (error) {
      // Storage itself failed (a closed database, a blocked upgrade, private
      // mode). Never let this escape: every call site is `void drain()`, so an
      // uncaught rejection here is both an unhandled rejection and a queue that
      // reports "idle" while writes sit pending with nothing armed to retry.
      this.setState("paused");
      this.emitStats();
      this.scheduleRetry();
    } finally {
      this.draining = false;
    }
  }

  /** Explicit flush, for a "Retry now" button or a test. */
  async flush(): Promise<void> {
    // Reset the backoff so an explicit "Retry now" is immediate rather than
    // inheriting however long the automatic schedule had grown to. Cancel the
    // armed timer too: just dropping the flag would leave it running and let a
    // second chain start alongside it, defeating the backoff entirely.
    this.clearRetry();
    this.attempt = 0;
    await this.drain();
  }

  /**
   * Drain until the queue empties or something stops us.
   *
   * Returning is how the flush lock is released: a pause for re-authentication
   * exits this function rather than awaiting inside it, so other tabs are not
   * blocked behind a login prompt the user may never answer.
   */
  private async drainSession(): Promise<SessionEnd> {
    const db = this.requireDb();
    this.sessionTotal = this.pending;

    for (;;) {
      if (this.stopped) return "retry";

      const mark = this.counterMark();
      const head = await db.head();
      if (!head) {
        // The one moment the counters can be re-derived rather than adjusted:
        // the store was empty, so any accumulated drift dies here. It can
        // accumulate — refreshCounters DISCARDS a read that raced a local
        // mutation and nothing re-runs it, so a tab that missed a sibling's
        // write would otherwise decrement past zero and hand its cap free room.
        // Same race guard as that read: "empty" is a snapshot, and an enqueue
        // reserves against the cap before its record lands.
        if (!this.counterRaced(mark)) {
          this.pending = 0;
          this.bytes = 0;
        }
        this.sessionTotal = 0;
        this.attempt = 0;
        this.setState("idle");
        return "idle";
      }

      // A record from a newer SDK. Leave it strictly alone and stop: skipping
      // it would break FIFO, and dead-lettering it would destroy valid data.
      if (head.v > RECORD_VERSION) {
        this.setState("blocked");
        return "blocked";
      }

      if (head.identity !== this.opts.identity) {
        await this.retire(
          head,
          "identity-mismatch",
          "Queued under a different queueIdentity; not sent as the current user"
        );
        continue;
      }

      if (this.opts.now() - head.enqueuedAt > this.opts.maxRetentionMs) {
        await this.retire(
          head,
          "expired",
          `Not delivered within ${this.opts.maxRetentionMs}ms of being queued`
        );
        continue;
      }

      const destination = this.opts.currentDestination();
      if (
        head.serverUrl !== destination.serverUrl ||
        head.environment !== destination.environment
      ) {
        await this.retire(
          head,
          "destination-mismatch",
          `Queued for ${head.serverUrl}/${head.environment}, client now points at ` +
            `${destination.serverUrl}/${destination.environment}`
        );
        continue;
      }

      const path = this.opts.resolvePath(head.kind);
      if (path === null) {
        await this.retire(
          head,
          "unknown-kind",
          `No endpoint for queued write kind "${head.kind}"`
        );
        continue;
      }

      this.setState("flushing");
      this.inFlight = 1;
      this.emitStats();

      try {
        const result = await this.opts.send(path, head);
        await this.mutate(async () => {
          await db.remove(head.seq);
          this.pending -= 1;
          this.bytes -= head.bytes;
        });
        this.inFlight = 0;
        this.attempt = 0;
        this.notifyWatcher(head.localId, { status: "sent", ...result });
        this.emitStats();
        this.announce();
        continue;
      } catch (error) {
        this.inFlight = 0;

        switch (classifyFailure(error)) {
          case "auth":
            this.setState("paused");
            this.emitStats();
            // Returning releases the flush lock; drain() refreshes and resumes.
            return "auth";

          case "retry":
            this.setState("paused");
            this.emitStats();
            return "retry";

          case "poison":
            await this.retire(
              head,
              "rejected",
              error instanceof Error ? error.message : String(error)
            );
            continue;
        }
      }
    }
  }

  /** Move a write to the dead-letter store and tell everyone who cares. */
  private async retire(
    write: QueuedWrite,
    reason: WriteLostReason,
    message: string
  ): Promise<void> {
    const db = this.requireDb();

    await this.mutate(async () => {
      await db.deadLetter({
        write,
        reason,
        message,
        deadLetteredAt: this.opts.now(),
      });
      // Only scan when the cap could actually be exceeded: trimming reads the
      // whole dead-letter store, and retiring runs back-to-back on the
      // identity-mismatch and expiry paths.
      if (this.deadLettered + 1 > this.opts.maxDeadLettered) {
        await db.trimDeadLettered(this.opts.maxDeadLettered);
      }

      this.pending -= 1;
      this.bytes -= write.bytes;
      this.deadLettered = await db.countDeadLettered();
    });

    this.notifyWatcher(write.localId, { status: "lost", reason, message });
    if (this.opts.onWriteLost) {
      safely(() => this.opts.onWriteLost!(write, reason, message), undefined);
    }
    this.emitStats();
    this.announce();
  }

  /**
   * Obtain fresh credentials.
   *
   * If the caller reports a DIFFERENT principal — the natural outcome when
   * `onAuthRequired` shows a login prompt on a shared machine and someone else
   * signs in — the queue rebinds to that identity. The pending records then fail
   * the identity check and are quarantined instead of being transmitted under
   * the new user's credentials.
   *
   * Bounded by `authTimeoutMs`. `drain()` awaits this while `draining` is true,
   * so a callback that never settles never reaches the `finally` that clears
   * the flag — and every later `drain()` and `flush()` then short-circuits on
   * it. Delivery would stop for the life of the page with no in-app recovery,
   * while `pending` climbed to `maxItems` and started throwing `QueueFullError`
   * at the app. A dropped promise is the normal shape of a dismissed login
   * modal, so this is an ordinary path, not a defensive one.
   *
   * Timing out returns false, which is the existing "no credentials obtained"
   * branch: the caller backs off and tries again. Nothing is dead-lettered — a
   * later login still delivers these writes.
   *
   * @returns whether fresh credentials were obtained.
   */
  private async reauthenticate(): Promise<boolean> {
    // Nothing can refresh the credential; back off and try again rather than
    // dead-lettering writes that a later login would deliver fine.
    if (!this.opts.onAuthRequired) return false;

    // Held on an object rather than a bare `let`: the assignment happens inside
    // a callback, which control-flow analysis cannot see, so a plain variable
    // narrows to `undefined` and the cancel below stops typechecking.
    const timeout: { cancel?: () => void } = {};
    try {
      const result = await Promise.race([
        this.opts.onAuthRequired(),
        new Promise<never>((_resolve, reject) => {
          const cancel = this.opts.schedule(
            () => reject(new Error("onAuthRequired did not settle in time")),
            this.opts.authTimeoutMs
          );
          if (typeof cancel === "function") timeout.cancel = cancel;
        }),
      ]);
      if (result && result.identity && result.identity !== this.opts.identity) {
        this.opts.identity = result.identity;
      }
      return true;
    } catch {
      return false;
    } finally {
      // The callback usually wins the race, and an armed 5-minute timer would
      // otherwise keep this queue and its closures alive long past close().
      timeout.cancel?.();
    }
  }

  /**
   * Exponential backoff with full jitter.
   *
   * Jitter matters more than usual here: every tab that came back online at the
   * same moment would otherwise retry in lockstep and manufacture the 429 the
   * queue is trying to survive.
   */
  private scheduleRetry(): void {
    if (this.stopped || this.retryArmed) return;

    const ceiling = Math.min(
      this.opts.backoffMaxMs,
      this.opts.backoffInitialMs * 2 ** this.attempt
    );
    this.attempt += 1;
    const delay = Math.random() * ceiling;

    this.retryArmed = true;
    const cancel = this.opts.schedule(() => {
      this.retryArmed = false;
      this.cancelRetry = null;
      void this.drain();
    }, delay);
    this.cancelRetry = typeof cancel === "function" ? cancel : null;
  }

  /** Drop a pending retry so a new one does not run alongside it. */
  private clearRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.retryArmed = false;
  }

  // --------------------------------------------------------------------------
  // Dead letter surface
  // --------------------------------------------------------------------------

  /** Every write that will never be sent, oldest first. */
  async deadLetter() {
    return this.requireDb().listDeadLettered();
  }

  /** Forget a dead-lettered write. Returns false if it was already gone. */
  async discard(localId: string): Promise<boolean> {
    const db = this.requireDb();
    const removed = await this.mutate(async () => {
      const gone = await db.discardDeadLettered(localId);
      if (gone) this.deadLettered = await db.countDeadLettered();
      return gone;
    });
    if (removed) {
      this.emitStats();
      this.announce();
    }
    return removed;
  }

  /**
   * Put a dead-lettered write back on the queue.
   *
   * It goes to the BACK, with a fresh `seq` — re-inserting at its original
   * position would mean rewriting keys, and everything that was behind it has
   * already been delivered. The idempotency key is preserved so a replay of a
   * write that did land is deduplicated by the engine.
   */
  async retry(localId: string): Promise<boolean> {
    const db = this.requireDb();

    // Refuse a record a NEWER build dead-lettered. `trimDeadLettered`
    // deliberately keeps these alive because this build cannot read them —
    // requeueing one would move it to the head of our own outbox, where it
    // blocks delivery of everything behind it until the newer build returns.
    const entry = await db.getDeadLettered(localId);
    if (!entry) return false;
    if (entry.write.v > RECORD_VERSION) return false;

    const write = await this.mutate(async () => {
      const requeued = await db.requeueDeadLettered(localId, this.opts.now());
      if (!requeued) return undefined;

      this.pending += 1;
      this.bytes += requeued.bytes;
      this.deadLettered = await db.countDeadLettered();
      return requeued;
    });
    if (!write) return false;

    this.emitStats();
    this.announce();

    void this.drain();
    return true;
  }

  // --------------------------------------------------------------------------
  // Observability
  // --------------------------------------------------------------------------

  stats(): QueueStats {
    return {
      pending: this.pending,
      inFlight: this.inFlight,
      total: this.sessionTotal,
      deadLettered: this.deadLettered,
      state: this.state,
    };
  }

  /** Subscribe to queue-wide stats. Returns an unsubscribe function. */
  subscribe(cb: (stats: QueueStats) => void): () => void {
    this.statsSubs.add(cb);
    // Isolated like every other emission: a subscriber that throws on its very
    // first snapshot must not take down whatever was registering it.
    safely(cb, this.stats());
    return () => this.statsSubs.delete(cb);
  }

  /**
   * Watch one write by its `localId`.
   *
   * The `pending: true` on an enqueue result is a one-shot value; without this
   * there is no way to learn that a specific row landed. Firestore's
   * `hasPendingWrites` is a live flag, and copying the shape without the
   * liveness would have been a dead end.
   */
  watch(localId: string, cb: (status: WriteStatus) => void): () => void {
    let set = this.watchers.get(localId);
    if (!set) {
      set = new Set();
      this.watchers.set(localId, set);
    }
    set.add(cb);

    // Immediate provisional value, so a UI has something to render this tick.
    safely(cb, { status: "pending" } as WriteStatus);

    // Then reconcile against storage. After a reload — the exact case the docs
    // point people here for — the write may already have landed or been
    // dead-lettered, and a bare "pending" would leave that row spinning forever.
    // Skipped if a live notification beat us to it: notifyWatcher drops the
    // watcher on a terminal status, so an absent entry means it already fired
    // (and its value is richer than anything storage can reconstruct, since the
    // delivered record is gone by then).
    //
    // Delivered through notifyWatcher so EVERY callback on this localId hears
    // the terminal status. Firing only `cb` while deleting the whole map entry
    // left a sibling registered in the same tick — two components watching one
    // write after a reload — failing the guard below and spinning forever.
    void this.resolveStatus(localId).then((status) => {
      if (status.status === "pending") return;
      if (!this.watchers.get(localId)?.has(cb)) return;
      this.notifyWatcher(localId, status);
    });

    return () => {
      set!.delete(cb);
      // Identity-checked: notifyWatcher deletes the entry on a terminal status,
      // so a later watch() on the same localId holds a DIFFERENT Set. Deleting
      // by key alone would evict that live subscriber.
      if (set!.size === 0 && this.watchers.get(localId) === set) {
        this.watchers.delete(localId);
      }
    };
  }

  /**
   * Current status of one write, derived from what is actually stored.
   *
   * One transaction over both stores, not two reads: `deadLetter()` moves a
   * record between them atomically, so separate reads can miss it in both and
   * report a LOST write as delivered — the worst answer this surface can give.
   */
  private async resolveStatus(localId: string): Promise<WriteStatus> {
    if (!this.db) return { status: "pending" };

    const found = await this.db.statusOf(localId);
    if (found.kind === "dead") {
      return {
        status: "lost",
        reason: found.entry.reason,
        message: found.entry.message,
      };
    }
    if (found.kind === "queued") return { status: "pending" };

    // In neither store: it was delivered and removed.
    return { status: "sent" };
  }

  private notifyWatcher(localId: string, status: WriteStatus): void {
    const subs = this.watchers.get(localId);
    if (!subs) return;
    for (const cb of subs) safely(cb, status);
    // Terminal state — nothing further will ever be reported for this write.
    this.watchers.delete(localId);
  }

  private setState(next: QueueState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitStats();
  }

  private emitStats(): void {
    const snapshot = this.stats();
    for (const cb of this.statsSubs) safely(cb, snapshot);
  }

  private requireDb(): QueueDb {
    if (!this.db) {
      throw new IronflowError("Offline queue is not started", {
        code: "QUEUE_NOT_STARTED",
        retryable: false,
      });
    }
    return this.db;
  }
}
