/**
 * The offline-capable client (ADR 0053).
 *
 * Why this is a separate factory rather than a flag on the singleton:
 * `configure()` returns `void`, so TypeScript cannot refine `emit()`'s static
 * return type from a runtime option. Putting the queued-result type on the
 * shared `ironflow` singleton would force every existing caller to handle a
 * case that can only occur for apps that opted in — a package-wide breaking
 * change dressed up as an opt-in. A factory confines the new type to clients
 * that asked for it and leaves `ironflow` exactly as it was.
 *
 *   createClient({ offlineQueue: { identity } })
 *        │
 *        ├─ no IndexedDB (SSR, Node)  ──> queue disabled, writes go direct
 *        └─ IndexedDB available       ──> OfflineQueue over emit + append
 *
 * The underlying full client stays reachable as `.client`, so everything this
 * surface does not wrap (runs, projections, subscriptions, admin) is one
 * property away rather than re-declared here.
 */
import { IronflowError } from "@ironflow/core";
import { IronflowClient, REPLAY_QUEUED_WRITE } from "./client.js";
import type { AuthConfig, IronflowConfigOptions } from "./config.js";
import { newUuid } from "./queue/ids.js";
import { OfflineQueue } from "./queue/queue.js";
import type {
  DeadLetteredWrite,
  QueuedWriteKind,
  QueueStats,
  WriteLostReason,
  WriteStatus,
} from "./queue/types.js";
import type {
  AppendEventInput,
  AppendOptions,
  EmitOptions,
} from "@ironflow/core";

/**
 * Endpoint per write kind.
 *
 * The drainer resolves the path through this at send time and never reads one
 * out of storage, so a record injected into IndexedDB cannot aim an
 * authenticated POST at an arbitrary endpoint.
 */
const PATHS: Record<QueuedWriteKind, string> = {
  emit: "/ironflow.v1.PubSubService/Emit",
  "stream-append": "/ironflow.v1.EntityStreamService/AppendEvent",
};

/** Result of a write submitted through an offline client. */
export interface QueuedWriteResult {
  /**
   * Whether the write was persisted to the outbox rather than sent.
   *
   * False only when the queue is disabled because the environment has no
   * IndexedDB (SSR, Node) — the write went straight out and already landed.
   * Reporting `true` there would be a lie, and a UI would show a pending badge
   * for something that is already done.
   */
  queued: boolean;
  /**
   * Client-side handle. Pass to `queue.watch()` to learn when the write
   * actually lands — nothing attached to the returned promise survives a page
   * reload, so this is the only durable way to follow it.
   *
   * When `queued` is false this is the server's event id instead, since the
   * write never had a client-side identity.
   */
  localId: string;
  /** The dedup key the engine will see, fixed now so a retry reuses it. */
  idempotencyKey: string;
  /**
   * Whether delivery is still outstanding. Mirrors Firestore's
   * `hasPendingWrites` so a UI can grey out one row rather than the whole page.
   */
  pending: boolean;
}

export interface OfflineQueueConfig {
  /**
   * Stable identity for the signed-in principal, supplied by the app.
   *
   * Required, and deliberately not derived from the credential: hashing an
   * apiKey/token identifies the credential, so rotating it would make the same
   * user look like a different one and quarantine their own queue.
   */
  identity: string;
  /** Defaults to a name derived from `serverUrl` + `environment`. */
  dbName?: string;
  /** Max queued writes before `emit`/`append` throw `QueueFullError`. Default 500. */
  maxItems?: number;
  /** Max queued bytes. Default 5 MB. */
  maxBytes?: number;
  /** Writes older than this are dead-lettered instead of sent. Default 7 days. */
  maxRetentionMs?: number;
  /** Dead-letter store cap. Default 100. */
  maxDeadLettered?: number;
  /** Called once per write that will never be sent. */
  onWriteLost?: (
    write: { localId: string; kind: QueuedWriteKind; body: string },
    reason: WriteLostReason,
    message: string
  ) => void;
  /**
   * Supply fresh credentials after the server answers 401.
   *
   * The queue pauses rather than dead-lettering, releases the flush lock so
   * other tabs are not stuck behind a login prompt, calls this once, applies
   * the result via `setAuth()`, and resumes. Without it a token expiring
   * mid-drain — the normal case for an app that was offline for hours — would
   * simply stall the queue until something else kicks it.
   *
   * Only 401 routes here. A 403 is insufficient permissions, which no amount
   * of re-authentication fixes, so it is treated as permanent.
   *
   * Return the `identity` of whoever signed in, not just the credential — that
   * is what rebinds the queue when a different person uses the login prompt.
   * A return with no credential leaves the existing one in place rather than
   * clearing it.
   *
   * Bounded at five minutes. A promise that never settles (a dismissed modal)
   * would otherwise hold the drain loop open for the life of the page; on
   * timeout the queue simply backs off and tries again. Nothing is lost.
   */
  onAuthRequired?: () => Promise<AuthConfig & { identity?: string }>;
}

export interface CreateClientOptions extends IronflowConfigOptions {
  offlineQueue: OfflineQueueConfig;
}

/** Queue controls exposed on an offline client. */
export interface QueueApi {
  /** Current snapshot. */
  stats(): QueueStats;
  /** Subscribe to queue-wide stats; fires immediately with the current value. */
  subscribe(cb: (stats: QueueStats) => void): () => void;
  /** Follow one write to its terminal state. */
  watch(localId: string, cb: (status: WriteStatus) => void): () => void;
  /** Drain now — for a "Retry now" button. Resets the backoff. */
  flush(): Promise<void>;
  /** Writes that will never be sent, oldest first. */
  deadLetter(): Promise<DeadLetteredWrite[]>;
  /** Forget a dead-lettered write. */
  discard(localId: string): Promise<boolean>;
  /** Put a dead-lettered write back on the queue, keeping its dedup key. */
  retry(localId: string): Promise<boolean>;
  /** False when the environment has no IndexedDB and writes go direct. */
  readonly enabled: boolean;
}

/**
 * A client whose `emit` and `streams.append` persist before they send.
 *
 * Note that neither returns `runIds`. A run id cannot exist before the server
 * creates the run, and the whole point here is to answer before contacting the
 * server. Subscribe for the outcome instead.
 */
export class OfflineClient {
  /** The full client. Everything not wrapped here lives on it. */
  readonly client: IronflowClient;

  private readonly offlineQueue: OfflineQueue | null;

  /** @internal Use {@link createClient}. */
  constructor(client: IronflowClient, queue: OfflineQueue | null) {
    this.client = client;
    this.offlineQueue = queue;
  }

  /**
   * Emit an event, persisting it first.
   *
   * Always write-through, even when the network is fine. Sending directly
   * whenever the queue happens to be empty would let a new write overtake
   * queued ones the moment it is not, which is the FIFO violation the design
   * exists to prevent.
   */
  async emit(
    eventName: string,
    data: unknown,
    options?: EmitOptions
  ): Promise<QueuedWriteResult> {
    // Fix the key HERE, before serialising, so the stored bytes already carry
    // it. If the body went out without one, every retry would create a fresh
    // event server-side and the queue's whole exactly-once story would be
    // fiction — the engine dedups on this field and nothing else.
    //
    // `||`, not `??`: an empty string is a key the engine will ignore, so
    // honouring it verbatim would report a dedup key that does not dedup.
    if (!this.offlineQueue) {
      const direct = directIdempotencyKey(options?.idempotencyKey);
      const result = await this.client.emit(eventName, data, {
        ...options,
        idempotencyKey: direct,
      });
      return {
        queued: false,
        localId: result.eventId ?? "",
        idempotencyKey: direct ?? "",
        pending: false,
      };
    }

    const key = options?.idempotencyKey || newUuid();

    const { localId, idempotencyKey } = await this.offlineQueue.enqueue({
      kind: "emit",
      body: {
        event: eventName,
        data,
        ...(options?.version ? { version: options.version } : {}),
        idempotency_key: key,
        metadata: options?.metadata,
        namespace: options?.namespace,
      },
      idempotencyKey: key,
    });

    return { queued: true, localId, idempotencyKey, pending: true };
  }

  readonly streams = {
    /**
     * Append to an entity stream, persisting first.
     *
     * `expectedVersion` is refused outright. A version read before the write
     * was queued is stale by definition, so the append is guaranteed to lose
     * its optimistic-concurrency check — the server answers `CodeAborted`/409,
     * which this queue treats as permanent and dead-letters. Failing loudly at
     * call time beats discovering it in the dead-letter store later.
     * Merge-on-conflict is a separate feature.
     */
    append: async (
      entityId: string,
      input: AppendEventInput,
      options?: AppendOptions
    ): Promise<QueuedWriteResult> => {
      if (
        options?.expectedVersion !== undefined &&
        options.expectedVersion !== -1
      ) {
        throw new IronflowError(
          "streams.append cannot be queued with expectedVersion set: the version " +
            "is stale by the time the write is sent, so the append would always " +
            "conflict. Use expectedVersion: -1, or write through client.streams.append.",
          { code: "QUEUE_EXPECTED_VERSION_UNSUPPORTED", retryable: false }
        );
      }

      // Same reasoning as emit(): the key has to be in the stored bytes, not
      // just alongside them, or a retry duplicates the event — and the direct
      // path gets one too, so the reported key is always the one the engine saw.
      if (!this.offlineQueue) {
        const direct = directIdempotencyKey(options?.idempotencyKey);
        const result = await this.client.streams.append(entityId, input, {
          ...options,
          idempotencyKey: direct,
        });
        return {
          queued: false,
          localId: result.eventId,
          idempotencyKey: direct ?? "",
          pending: false,
        };
      }

      const key = options?.idempotencyKey || newUuid();

      const body: Record<string, unknown> = {
        entity_id: entityId,
        entity_type: input.entityType,
        event_name: input.name,
        data: input.data,
        expected_version: -1,
        idempotency_key: key,
        version: options?.version ?? 1,
      };
      if (options?.metadata !== undefined) {
        body.metadata = options.metadata;
      }

      const { localId, idempotencyKey } = await this.offlineQueue.enqueue({
        kind: "stream-append",
        body,
        idempotencyKey: key,
      });

      return { queued: true, localId, idempotencyKey, pending: true };
    },
  };

  /** Stable across reads, so `useEffect(..., [app.queue])` does not thrash. */
  private queueApi: QueueApi | null = null;

  get queue(): QueueApi {
    if (this.queueApi) return this.queueApi;
    const q = this.offlineQueue;

    if (!q) {
      // No IndexedDB: the surface still exists so callers need no branching,
      // it just reports an empty, disabled queue.
      const empty: QueueStats = {
        pending: 0,
        inFlight: 0,
        total: 0,
        deadLettered: 0,
        state: "idle",
      };
      return (this.queueApi = {
        enabled: false,
        stats: () => empty,
        subscribe: (cb) => {
          cb(empty);
          return () => {};
        },
        watch: (_id, cb) => {
          cb({ status: "sent" });
          return () => {};
        },
        flush: async () => {},
        deadLetter: async () => [],
        discard: async () => false,
        retry: async () => false,
      });
    }

    return (this.queueApi = {
      enabled: true,
      stats: () => q.stats(),
      subscribe: (cb) => q.subscribe(cb),
      watch: (id, cb) => q.watch(id, cb),
      flush: () => q.flush(),
      deadLetter: () => q.deadLetter(),
      discard: (id) => q.discard(id),
      retry: (id) => q.retry(id),
    });
  }

  /**
   * Stop draining and release the database.
   *
   * Drain-then-swap: an in-flight write is allowed to finish rather than being
   * abandoned with its fate unknown.
   */
  async close(): Promise<void> {
    await this.offlineQueue?.stop();
    this.client.disconnect();
  }
}

/**
 * The dedup key to report and send on the direct (queue-disabled) path.
 *
 * An empty string counts as absent. The engine skips dedup entirely for an
 * empty key, so passing one straight through would make
 * `QueuedWriteResult.idempotencyKey` — documented as "the dedup key the engine
 * will see" — false exactly where a caller might trust it to retry safely.
 *
 * Generation is allowed to FAIL rather than throw. This path exists for
 * environments missing browser APIs (SSR, Node, a locked-down WebView), and
 * `newUuid()` throws without Web Crypto — so generating unconditionally would
 * turn the documented degradation path into a crash on the very environments it
 * exists to tolerate. Reporting no key there is honest: the engine saw none.
 */
function directIdempotencyKey(supplied?: string): string | undefined {
  if (supplied) return supplied;
  try {
    return newUuid();
  } catch {
    return undefined;
  }
}

/** Default database name; scoped so staging writes can never flush into prod. */
export function queueDbName(serverUrl: string, environment: string): string {
  return `ironflow-queue:${serverUrl}:${environment}`;
}

/**
 * Create a client that persists writes before sending them.
 *
 * Async because the outbox has to be opened and its counters hydrated before
 * the first `emit` can be honestly answered.
 *
 * Degrades rather than throwing when the environment has no IndexedDB (SSR, a
 * Node import, a locked-down browser): the queue disables itself, writes go
 * straight out, and the app keeps working. Throwing here would crash a server
 * render for anyone who put the option in shared config.
 */
export async function createClient(
  options: CreateClientOptions
): Promise<OfflineClient> {
  const { offlineQueue: queueConfig, ...clientOptions } = options;

  const client = new IronflowClient();
  client.configure(clientOptions);
  const config = client.getConfig();

  if (typeof indexedDB === "undefined") {
    // Through the client's logger, so an app that quieted SDK logging is not
    // shouted at on every SSR render — the case this branch exists to tolerate.
    client.getLogger().warn(
      "IndexedDB is unavailable; the offline write queue is disabled and writes will be sent directly."
    );
    return new OfflineClient(client, null);
  }

  const queue = new OfflineQueue({
    dbName:
      queueConfig.dbName ?? queueDbName(config.serverUrl, config.environment),
    identity: queueConfig.identity,
    maxItems: queueConfig.maxItems,
    maxBytes: queueConfig.maxBytes,
    maxRetentionMs: queueConfig.maxRetentionMs,
    maxDeadLettered: queueConfig.maxDeadLettered,
    onWriteLost: queueConfig.onWriteLost
      ? (write, reason, message) =>
          queueConfig.onWriteLost!(
            { localId: write.localId, kind: write.kind, body: write.body },
            reason,
            message
          )
      : undefined,
    onAuthRequired: queueConfig.onAuthRequired
      ? async () => {
          // Applied through setAuth(), never configure(): configure() is a full
          // teardown and would destroy the transport, the subscriptions and the
          // drainer that is mid-recovery.
          const { identity, ...auth } = await queueConfig.onAuthRequired!();
          // Only when a credential actually came back. Both `AuthConfig` fields
          // are optional, so returning `{ identity }` alone typechecks — and
          // `setAuth({})` would then clear the credential on the SHARED client,
          // taking subscriptions and every non-queue call down with it, and
          // guaranteeing the next attempt 401s again.
          if (auth.apiKey || auth.token) {
            client.setAuth(auth);
          }
          // Returning the identity lets the queue rebind. If a DIFFERENT user
          // signed in at the prompt, the pending writes then fail the identity
          // check and are quarantined instead of being sent as that new user.
          return { identity };
        }
      : undefined,
    resolvePath: (kind) => PATHS[kind] ?? null,
    // Read live, not captured: the guard exists to catch a client that was
    // reconfigured to another server or environment while writes were queued.
    currentDestination: () => {
      const live = client.getConfig();
      return { serverUrl: live.serverUrl, environment: live.environment };
    },
    send: (path, write) => client[REPLAY_QUEUED_WRITE](path, write.body),
  });

  try {
    await queue.start();
  } catch (error) {
    // A database written by a newer SDK, or storage that refuses to open. The
    // app is more useful with direct writes than with a hard failure at import.
    client.getLogger().warn(
      `offline write queue could not start; writes will be sent directly. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new OfflineClient(client, null);
  }

  return new OfflineClient(client, queue);
}
