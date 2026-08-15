/**
 * Cross-tab flush coordination for the offline write queue (ADR 0052).
 *
 * IndexedDB is shared per-origin, so every open tab sees the same outbox. Two
 * tabs draining at once stay *correct* — the engine deduplicates by idempotency
 * key — but strict FIFO does not survive it, and FIFO is the property the whole
 * design is built around. One drainer at a time is the fix.
 *
 * The Web Locks API does this natively and, crucially, releases the lock when a
 * tab crashes. A hand-rolled lease row in IndexedDB would need its own expiry
 * logic and would get it wrong.
 *
 * Everything routes through `withFlushLock` so the no-locks fallback is a real
 * code path rather than a dead branch: `navigator.locks` is Safari 16+, and the
 * package supports 13.1+. The test environment deliberately leaves the global
 * undefined, so the default test run exercises the fallback.
 */

/**
 * Returned when another context already holds the lock.
 *
 * A busy lock is not an error — it means another tab is draining, which is
 * exactly what we wanted. The caller skips this cycle and tries later.
 */
export const LOCK_BUSY = Symbol("ironflow.queue.lock-busy");

type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" },
    callback: (lock: unknown) => Promise<unknown>
  ): Promise<unknown>;
};

function lockManager(): LockManagerLike | undefined {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)
    ?.locks;
  return typeof locks?.request === "function" ? locks : undefined;
}

/** Whether this environment can coordinate drains across tabs. */
export function hasWebLocks(): boolean {
  return lockManager() !== undefined;
}

/**
 * Run `fn` while holding the named lock, or return {@link LOCK_BUSY} if another
 * context holds it.
 *
 * `ifAvailable` rather than waiting: a queued drain that fires the moment the
 * other tab finishes would just re-drain an empty queue. Skipping and retrying
 * on the next cycle is both simpler and cheaper.
 *
 * The lock is held only for the duration of `fn`. That is what lets the drainer
 * release it while paused on re-authentication — it returns from `fn` instead of
 * awaiting inside it. Holding a lock across an unresolved `onAuthRequired` (a
 * user who walked away from a login prompt) would block every other tab
 * indefinitely.
 */
export async function withFlushLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T | typeof LOCK_BUSY> {
  const locks = lockManager();

  // No Web Locks (Safari < 16, SSR, older engines): this tab is the only
  // drainer it can know about. Single-tab correctness is preserved; concurrent
  // tabs fall back to dedup-keeps-it-correct, order-may-interleave.
  if (!locks) {
    return fn();
  }

  let result: T | typeof LOCK_BUSY = LOCK_BUSY;

  await locks.request(name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
    // A null lock means `ifAvailable` declined it — someone else is draining.
    if (lock === null) return;
    result = await fn();
  });

  return result;
}
