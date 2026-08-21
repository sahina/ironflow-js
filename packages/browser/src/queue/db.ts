/**
 * IndexedDB persistence for the offline write queue (ADR 0053).
 *
 * Two object stores:
 *
 *   outbox      keyPath "seq", autoIncrement   index: localId
 *               Insertion order IS send order — autoIncrement gives a
 *               monotonic FIFO key for free, so "next to send" is just the
 *               first record by key.
 *
 *   deadletter  keyPath "write.localId"
 *               Writes that will never be sent, kept so an app can list,
 *               discard, or replay them. Without a surface they would be
 *               inaccessible data growing until quota pressure.
 *
 * Raw IndexedDB, no wrapper dependency: two stores and one upgrade handler do
 * not justify adding to a package with four runtime deps.
 */
import {
  RECORD_VERSION,
  type DeadLetteredWrite,
  type QueuedWrite,
} from "./types.js";

/** Bumped only for a real schema migration; see {@link QueueDb.open}. */
const DB_VERSION = 1;

const OUTBOX = "outbox";
const DEADLETTER = "deadletter";
const LOCAL_ID_INDEX = "byLocalId";

/** A write with its FIFO key not yet assigned by IndexedDB. */
export type NewQueuedWrite = Omit<QueuedWrite, "seq">;

/**
 * Thrown when the stored database was created by a NEWER SDK.
 *
 * IndexedDB refuses to open a database at a lower version than the one on disk,
 * which is exactly the signal we want: a rollback, or another tab on a newer
 * build. The queue disables delivery rather than touching data it cannot read.
 */
export class QueueVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueVersionError";
  }
}

/** Thrown when a write cannot be stored because the origin is out of quota. */
export class QueueQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueQuotaError";
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      // Firefox's legacy spelling.
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** Promisify an IDBRequest. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolve when a transaction commits, reject if it aborts or errors. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

export class QueueDb {
  private constructor(
    private readonly db: IDBDatabase,
    readonly name: string
  ) {}

  /**
   * Open (creating if needed) the queue database.
   *
   * @throws {QueueVersionError} when the stored database is newer than this SDK.
   */
  static async open(name: string): Promise<QueueDb> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is unavailable in this environment");
    }

    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(OUTBOX)) {
        const outbox = db.createObjectStore(OUTBOX, {
          keyPath: "seq",
          autoIncrement: true,
        });
        // Lets watch()/discard() find a record without scanning the queue.
        outbox.createIndex(LOCAL_ID_INDEX, "localId", { unique: true });
      }

      if (!db.objectStoreNames.contains(DEADLETTER)) {
        db.createObjectStore(DEADLETTER, { keyPath: "write.localId" });
      }
    };

    // A newer SDK cannot upgrade while an older tab holds the database open.
    // Without this the upgrade blocks indefinitely and that tab never notices.
    request.onblocked = () => {
      // eslint-disable-next-line no-console
      console.warn(
        `[ironflow] offline queue database "${name}" is blocked by another tab ` +
          `holding an older version open. Close other tabs to let it upgrade.`
      );
    };

    try {
      const db = await promisify(request);
      // Yield the connection when another context needs to upgrade, rather than
      // blocking it forever.
      db.onversionchange = () => db.close();
      return new QueueDb(db, name);
    } catch (error) {
      if (error instanceof DOMException && error.name === "VersionError") {
        throw new QueueVersionError(
          `Offline queue database "${name}" was written by a newer Ironflow SDK. ` +
            `Delivery is paused so the existing writes are not destroyed; upgrade to drain them.`
        );
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------------------------
  // Outbox
  // --------------------------------------------------------------------------

  /**
   * Append a write and return the FIFO key IndexedDB assigned it.
   *
   * @throws {QueueQuotaError} when the origin is out of storage.
   */
  async append(write: NewQueuedWrite): Promise<number> {
    try {
      const tx = this.db.transaction(OUTBOX, "readwrite");
      const key = promisify(tx.objectStore(OUTBOX).add(write));
      await txDone(tx);
      return (await key) as number;
    } catch (error) {
      if (isQuotaError(error)) {
        throw new QueueQuotaError(
          "Browser storage quota exceeded; the write was not queued"
        );
      }
      throw error;
    }
  }

  /**
   * The next write to send, or `undefined` when the outbox is empty.
   *
   * Strict FIFO: always the lowest key. A write that fails stays here, which is
   * what makes the queue blocking — item N+1 cannot pass item N.
   */
  async head(): Promise<QueuedWrite | undefined> {
    const tx = this.db.transaction(OUTBOX, "readonly");
    const cursor = await promisify(tx.objectStore(OUTBOX).openCursor());
    return cursor?.value as QueuedWrite | undefined;
  }

  async remove(seq: number): Promise<void> {
    const tx = this.db.transaction(OUTBOX, "readwrite");
    tx.objectStore(OUTBOX).delete(seq);
    await txDone(tx);
  }

  async findByLocalId(localId: string): Promise<QueuedWrite | undefined> {
    const tx = this.db.transaction(OUTBOX, "readonly");
    const found = await promisify(
      tx.objectStore(OUTBOX).index(LOCAL_ID_INDEX).get(localId)
    );
    return found as QueuedWrite | undefined;
  }

  /**
   * Item count and total bytes, for the caps and the pending badge.
   *
   * Read once at open; the queue keeps counters in memory afterwards rather
   * than paying a store scan per write.
   */
  async usage(): Promise<{ count: number; bytes: number }> {
    const tx = this.db.transaction(OUTBOX, "readonly");
    const all = (await promisify(
      tx.objectStore(OUTBOX).getAll()
    )) as QueuedWrite[];
    return {
      count: all.length,
      bytes: all.reduce((sum, w) => sum + w.bytes, 0),
    };
  }

  /**
   * Whether the outbox holds records this SDK does not understand.
   *
   * Such records are left untouched and stop delivery entirely: skipping past
   * them would break FIFO, and dead-lettering them would destroy valid data
   * written by a newer build.
   */
  async hasFutureRecords(): Promise<boolean> {
    const tx = this.db.transaction(OUTBOX, "readonly");
    const all = (await promisify(
      tx.objectStore(OUTBOX).getAll()
    )) as QueuedWrite[];
    return all.some((w) => w.v > RECORD_VERSION);
  }

  // --------------------------------------------------------------------------
  // Dead letter
  // --------------------------------------------------------------------------

  /** Move a write out of the outbox and into the dead-letter store atomically. */
  async deadLetter(entry: DeadLetteredWrite): Promise<void> {
    const tx = this.db.transaction([OUTBOX, DEADLETTER], "readwrite");
    tx.objectStore(OUTBOX).delete(entry.write.seq);
    tx.objectStore(DEADLETTER).put(entry);
    await txDone(tx);
  }

  async listDeadLettered(): Promise<DeadLetteredWrite[]> {
    const tx = this.db.transaction(DEADLETTER, "readonly");
    const all = (await promisify(
      tx.objectStore(DEADLETTER).getAll()
    )) as DeadLetteredWrite[];
    return all.sort((a, b) => a.deadLetteredAt - b.deadLetteredAt);
  }

  async countDeadLettered(): Promise<number> {
    const tx = this.db.transaction(DEADLETTER, "readonly");
    return promisify(tx.objectStore(DEADLETTER).count());
  }

  async discardDeadLettered(localId: string): Promise<boolean> {
    const tx = this.db.transaction(DEADLETTER, "readwrite");
    const store = tx.objectStore(DEADLETTER);
    const existing = await promisify(store.get(localId));
    if (existing === undefined) {
      await txDone(tx);
      return false;
    }
    store.delete(localId);
    await txDone(tx);
    return true;
  }

  /**
   * Move a dead-lettered write back onto the outbox in ONE transaction.
   *
   * Two transactions would leave both copies alive if the second failed, and the
   * surviving dead letter could then be retried again — a duplicate that the
   * engine only dedupes because the idempotency key is preserved.
   */
  async requeueDeadLettered(
    localId: string,
    enqueuedAt: number
  ): Promise<QueuedWrite | undefined> {
    const tx = this.db.transaction([OUTBOX, DEADLETTER], "readwrite");
    const store = tx.objectStore(DEADLETTER);
    const entry = (await promisify(store.get(localId))) as
      | DeadLetteredWrite
      | undefined;

    if (!entry) {
      await txDone(tx);
      return undefined;
    }

    const { seq: _seq, ...rest } = entry.write;
    tx.objectStore(OUTBOX).add({ ...rest, enqueuedAt });
    store.delete(localId);
    await txDone(tx);

    return entry.write;
  }

  /**
   * Where one write currently lives, read from BOTH stores in ONE transaction.
   *
   * Two separate reads can interleave with `deadLetter()`, which moves a record
   * between the stores atomically: read the dead-letter store (miss), the move
   * commits, read the outbox (miss) — and the write reports as delivered when
   * it was actually lost. A single readonly transaction spanning both stores
   * cannot observe that intermediate state.
   *
   * Both requests are issued before the first await on purpose. Awaiting one
   * before opening the other would let the transaction auto-close, putting the
   * second read back in a transaction of its own and reinstating the race.
   */
  async statusOf(
    localId: string
  ): Promise<
    | { kind: "queued" }
    | { kind: "dead"; entry: DeadLetteredWrite }
    | { kind: "absent" }
  > {
    const tx = this.db.transaction([OUTBOX, DEADLETTER], "readonly");
    const deadReq = promisify(tx.objectStore(DEADLETTER).get(localId));
    const queuedReq = promisify(
      tx.objectStore(OUTBOX).index(LOCAL_ID_INDEX).get(localId)
    );

    const [dead, queued] = await Promise.all([deadReq, queuedReq]);
    if (dead) return { kind: "dead", entry: dead as DeadLetteredWrite };
    if (queued) return { kind: "queued" };
    return { kind: "absent" };
  }

  async getDeadLettered(localId: string): Promise<DeadLetteredWrite | undefined> {
    const tx = this.db.transaction(DEADLETTER, "readonly");
    return (await promisify(tx.objectStore(DEADLETTER).get(localId))) as
      | DeadLetteredWrite
      | undefined;
  }

  /**
   * Trim the dead-letter store to its cap, oldest first.
   *
   * Drop-oldest is fine here, unlike the outbox: ordering does not matter for
   * writes that are already never going to be sent.
   */
  async trimDeadLettered(max: number): Promise<void> {
    const all = await this.listDeadLettered();
    if (all.length <= max) return;

    // Never evict a record written by a NEWER SDK: this build cannot read it,
    // so deleting it destroys data that a rollback would have delivered fine.
    // The cap is still measured against the WHOLE store — counting only the
    // evictable subset would keep `max` evictable records plus every future
    // one, which is no upper bound at all once a future record exists.
    const evictable = all.filter((e) => e.write.v <= RECORD_VERSION);
    const excess = evictable.slice(0, Math.min(all.length - max, evictable.length));
    if (all.length - excess.length > max) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ironflow] dead-letter store holds ${all.length - excess.length} records, ` +
          `above the cap of ${max}: the excess was written by a newer SDK and ` +
          `cannot be evicted. Upgrade to drain it.`
      );
    }
    if (excess.length === 0) return;

    const tx = this.db.transaction(DEADLETTER, "readwrite");
    const store = tx.objectStore(DEADLETTER);
    for (const entry of excess) {
      store.delete(entry.write.localId);
    }
    await txDone(tx);
  }
}
