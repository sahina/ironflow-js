// sdk/js/node/src/projection-runner.ts

/**
 * Projection Runner
 *
 * Processes events for a single projection using two strategies:
 *
 * 1. **Streaming (preferred):** Opens a persistent ConnectRPC server-stream
 *    that receives events in real-time as they arrive. Uses micro-batching
 *    (100ms window or batch_size events, whichever comes first) to amortize
 *    state saves.
 *
 * 2. **Polling (fallback):** If streaming is unavailable (older server), falls
 *    back to HTTP polling with exponential backoff (1s → 2s → 4s, max 10s).
 *
 * Both modes use the same handler execution and state persistence logic.
 *
 * The runner reads only while it holds the projection lease (ADR 0120). Other
 * replicas wait as hot standbys. One lease loop serves both modes.
 */

import type {
  IronflowProjection,
  ProjectionContext,
  Logger,
  ManagedProjectionHandler,
  ExternalProjectionHandler,
} from "@ironflow/core";
import {
  calculateBackoff,
  UnauthenticatedError,
  UnauthorizedError,
  throwIfAuthError,
} from "@ironflow/core";

export interface ProjectionRunnerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projection: IronflowProjection<any, any>;
  baseUrl: string;
  headers: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
  /** Resolves when the runners this one replaces have stopped; intake starts after it (#2770). */
  after?: Promise<void>;
}

/** Event shape returned by PollProjectionEvents / StreamProjectionEvents */
interface PollEvent {
  id: string;
  name: string;
  data: unknown;
  /** A payload that is not a JSON object arrives here instead of in `data`. */
  dataValue?: unknown;
  seq: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/** One event shape for both transports. protojson sends the int64 seq as a JSON string (#2821). */
function normalizeEvent(event: PollEvent): PollEvent {
  return {
    id: event.id || "",
    name: event.name || "",
    data: event.dataValue ?? event.data,
    seq: typeof event.seq === "string" ? parseInt(event.seq, 10) : (event.seq || 0),
    timestamp: event.timestamp,
    metadata: event.metadata,
  };
}

/** Response shape from PollProjectionEvents */
interface PollResponse {
  events: PollEvent[];
  currentState?: unknown;
  /** A global state that is not a JSON object arrives here instead of in `currentState` (#1963). */
  currentStateValue?: unknown;
}

/** The runner lease (ADR 0120). The epoch is an int64, so JSON carries it as a string: send it back unchanged. */
interface ProjectionLease {
  token: string;
  epoch: string | number;
}

/** Runner timings. Tests shorten them; index.ts does not export this object. */
export const runnerTimings = {
  /** Micro-batch flush window. */
  flushIntervalMs: 100,
  /** Lease timings (ADR 0120 section 7). The TTL comes from the server. */
  standbyRetryMs: 5000, // with ±20 % jitter
  renewRetryMs: 1000,
  fallbackTtlMs: 30_000, // only when a grant has no ttl, as in the Go and Python runners
  stopTimeoutMs: 5000, // bounds the lease calls of a stop: a late Acquire and the Release
};

/** Streaming reconnect ladder: 2s, 4s, 8s … capped, so a dead engine is not a log firehose. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
/** Repeated failures log at error from this attempt; the first are often transient. */
const FAIL_LOG_ESCALATE_AT = 3;

/** Milliseconds of a protobuf Duration in JSON ("30s", "0.300s"); 0 when it is absent. */
function durationMs(d?: string): number {
  return d ? parseFloat(d) * 1000 || 0 : 0;
}

/** Reusable encoder — TextEncoder is stateless, no need to instantiate per call */
const textEncoder = new TextEncoder();

/**
 * Encode a JSON string as a ConnectRPC envelope.
 * Format: 0x00 (flags: uncompressed) + uint32 big-endian length + payload bytes.
 * Required for streaming RPCs; unary RPCs use plain JSON bodies.
 */
function encodeConnectEnvelope(json: string): Uint8Array {
  const payload = textEncoder.encode(json);
  const envelope = new Uint8Array(5 + payload.length);
  envelope[0] = 0x00; // flags: uncompressed
  const view = new DataView(envelope.buffer);
  view.setUint32(1, payload.length, false); // big-endian length
  envelope.set(payload, 5);
  return envelope;
}

interface ConnectErrorBody {
  code?: string;
  message?: string;
}

/** Classify a Connect error by code, as the Go and Python runners do. Always throws. */
function throwConnectError(err: ConnectErrorBody, what: string): never {
  const detail = `${what}: ${err.code}: ${err.message ?? ""}`;
  // Aborted is the one lease error (ADR 0120 section 3). It must not reach the poll fallback.
  if (err.code === "aborted") {
    throw new ProjectionLeaseLostError(detail);
  }
  if (err.code === "unimplemented" || err.code === "not_found") {
    throw new StreamingUnsupportedError(detail);
  }
  throwIfAuthError(err.code === "unauthenticated" ? 401 : err.code === "permission_denied" ? 403 : 0, what);
  throw new Error(detail);
}

/** The Connect error in a failed unary response, or {} when the body is not one. Reads a clone. */
async function connectErrorOf(resp: Response): Promise<ConnectErrorBody> {
  try {
    return ((await resp.clone().json()) as ConnectErrorBody | null) ?? {};
  } catch {
    return {};
  }
}

/** Connect sends aborted as HTTP 409. already_exists is also 409, so the body decides. */
async function throwIfLeaseLost(resp: Response, what: string): Promise<void> {
  if (resp.status !== 409) return;
  const err = await connectErrorOf(resp);
  if (err.code === "aborted") throwConnectError(err, what);
}

export class ProjectionRunner {
  private config: ProjectionRunnerConfig;
  private stopAbort = new AbortController();
  private intakeSignal: AbortSignal;
  private runPromise: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;
  private backoffMs = 1000;

  // Micro-batch state for streaming mode
  private pendingEvents: PollEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes flushPending calls to prevent concurrent state mutations
  private flushChain: Promise<void> = Promise.resolve();
  // In-memory state for managed projections (accumulated across micro-batches)
  private managedState: unknown = null;
  private managedStateInitialized = false;
  /** Aborts the current stream fetch; a failed flush uses it to force a reconnect (#2404). */
  private streamAbort: AbortController | null = null;
  /** Set by a failed flush; later flushes are dropped until the reconnect, which replays from the saved cursor. */
  private flushFailed = false;
  /** A batch with events succeeded on the current stream. */
  private progressed = false;

  // Lease state (ADR 0120). Per instance: worker and worker-streaming each bundle this module.
  /** The held lease, or null in standby or when unguarded. */
  private lease: ProjectionLease | null = null;
  /** The server has no lease RPCs (an older server). */
  private unguarded = false;
  /** Aborted when the server fences the held lease. Each grant gets a new one. */
  private leaseLost = new AbortController();
  /** The grant that the renew timer serves; null when no renew runs. */
  private renewGrant: AbortController | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ProjectionRunnerConfig) {
    this.config = config;
    this.intakeSignal = config.signal
      ? AbortSignal.any([config.signal, this.stopAbort.signal])
      : this.stopAbort.signal;
    this.intakeSignal.addEventListener("abort", () => this.streamAbort?.abort(), { once: true });
  }

  async register(): Promise<void> {
    const { projection, baseUrl, headers } = this.config;
    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/RegisterProjection`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projection.config.name,
          events: projection.config.events,
          mode: projection.config.mode,
          version: 1,
          partitionKey: projection.config.partitionKey || "",
        }),
        signal: this.intakeSignal,
      }
    );
    if (!resp.ok) {
      throwIfAuthError(
        resp.status,
        `Failed to register projection ${projection.config.name}`
      );
      const err = resp.status === 400 ? await connectErrorOf(resp) : {};
      if (err.code === "invalid_argument") {
        throw new ProjectionConfigError(`Failed to register projection: ${err.code}: ${err.message ?? ""}`);
      }
      throw new Error(`Failed to register projection: ${resp.status}`);
    }
  }

  /**
   * Retry with backoff until it works, as the Python runner does. Returns false
   * when intake stopped first or on a config error. An auth error stops the
   * runner, and a lost lease ends the retry.
   */
  private async retryUntilStopped(what: string, attempt: () => Promise<void>): Promise<boolean> {
    for (let failures = 1; !this.intakeSignal.aborted; failures++) {
      this.checkLease();
      try {
        await attempt();
        return true;
      } catch (err) {
        if (this.intakeSignal.aborted) return false;
        if (err instanceof UnauthenticatedError || err instanceof UnauthorizedError) throw err;
        const name = this.config.projection.config.name;
        if (err instanceof ProjectionConfigError) {
          this.config.logger.error(`Projection ${name} ${what} failed, stopping: ${err.message}`);
          return false;
        }
        const log = failures < FAIL_LOG_ESCALATE_AT ? this.config.logger.warn : this.config.logger.error;
        log.call(this.config.logger, `Projection ${name} ${what} failed (attempt ${failures}): ${err}`);
        await this.sleep(calculateBackoff(failures, RECONNECT_BASE_MS, RECONNECT_MAX_MS));
      }
    }
    return false;
  }

  /**
   * Start in streaming mode (preferred). Opens a ConnectRPC server-stream
   * that delivers events in real-time. Throws StreamingUnsupportedError when
   * the server returns Unimplemented, so the caller can call start() to poll.
   */
  startStreaming(): Promise<void> {
    if (this.intakeSignal.aborted) return Promise.resolve();
    this.runPromise = this.runStreaming(false);
    return this.runPromise;
  }

  /**
   * Streams, and polls when the server cannot stream. One lease and one
   * register serve both modes, as in the Go and Python runners.
   */
  run(): Promise<void> {
    if (this.intakeSignal.aborted) return Promise.resolve();
    this.runPromise = this.runStreaming(true);
    return this.runPromise;
  }

  private async runStreaming(pollFallback: boolean): Promise<void> {
    const { projection, logger } = this.config;
    await this.config.after;
    this.resetManagedState();
    if (!(await this.retryUntilStopped("register", () => this.register()))) return;
    logger.info(`Projection runner started (streaming): ${projection.config.name}`);
    let polling = false;
    await this.runLeased(async () => {
      if (!polling) {
        try {
          // Resume from the saved state; streaming without it would save over it. Read it after
          // the grant: a state read before the standby wait is stale.
          if (await this.retryUntilStopped("state load", () => this.loadExistingState())) {
            await this.streamLoop();
          }
          return;
        } catch (err) {
          if (!pollFallback || !(err instanceof StreamingUnsupportedError) || this.lost(err)) throw err;
          logger.info(`Streaming not available for ${projection.config.name}, falling back to polling: ${err}`);
          polling = true;
        }
      }
      await this.pollLoop();
    });
  }

  /**
   * Runs a transport while the runner holds the lease, and stands by again each
   * time the lease is lost (ADR 0120). One lease loop serves both transports.
   */
  private async runLeased(transport: () => Promise<void>): Promise<void> {
    const { projection, logger } = this.config;
    try {
      while (await this.acquireLease()) {
        try {
          await transport();
          return;
        } catch (err) {
          if (!this.lost(err)) throw err;
          logger.info(
            `Projection ${projection.config.name}: lease lost (epoch ${this.lease?.epoch}), standing by: ${err}`
          );
          await this.dropGrant();
        }
      }
    } finally {
      this.stopRenew();
      // stop() releases after its final save: a Release first would fence that save.
      if (!this.intakeSignal.aborted) await this.releaseLease();
    }
  }

  /**
   * Waits as a hot standby until the server grants the lease, then starts the
   * renew. Returns false when intake stopped first. An unguarded runner
   * returns at once.
   */
  private async acquireLease(): Promise<boolean> {
    if (this.unguarded) return !this.intakeSignal.aborted;
    // A stop does not abort the Acquire at once: a grant that the server made must reach
    // finishStop(), which releases it. A stop aborts it after stopTimeoutMs.
    const bound = new AbortController();
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    const onStop = () => { boundTimer = setTimeout(() => bound.abort(), runnerTimings.stopTimeoutMs); };
    this.intakeSignal.addEventListener("abort", onStop, { once: true });
    try {
      return await this.acquireUntilGranted(bound.signal);
    } finally {
      this.intakeSignal.removeEventListener("abort", onStop);
      clearTimeout(boundTimer);
    }
  }

  private async acquireUntilGranted(signal: AbortSignal): Promise<boolean> {
    const { projection, baseUrl, headers, logger } = this.config;
    const name = projection.config.name;
    let standby = false;
    while (!this.intakeSignal.aborted) {
      try {
        const resp = await fetch(`${baseUrl}/ironflow.v1.ProjectionService/AcquireProjectionLease`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal,
        });
        if (resp.ok) {
          const data = (await resp.json()) as { granted?: boolean; lease?: ProjectionLease; ttl?: string };
          if (data.granted && data.lease) {
            this.lease = data.lease;
            if (this.intakeSignal.aborted) return false;
            logger.info(`Projection ${name}: lease granted (epoch ${data.lease.epoch})`);
            this.startRenew(durationMs(data.ttl) || runnerTimings.fallbackTtlMs);
            return true;
          }
          if (!standby) {
            standby = true;
            logger.info(`Projection ${name}: lease held by another runner, standing by`);
          }
        } else {
          const err = await connectErrorOf(resp);
          // A Connect client reads a 404 without a Connect body as unimplemented: an older server.
          if (err.code === "unimplemented" || (resp.status === 404 && !err.code)) {
            logger.warn(`Projection ${name}: the server has no projection lease, running unguarded`);
            this.unguarded = true;
            return !this.intakeSignal.aborted;
          }
          throwIfAuthError(resp.status, `Projection ${name} lease`);
          logger.warn(`Projection ${name}: lease acquire failed, retrying: ${resp.status} ${err.message ?? ""}`);
        }
      } catch (err) {
        if (err instanceof UnauthenticatedError || err instanceof UnauthorizedError) throw err;
        if (this.intakeSignal.aborted) return false;
        // A lost grant also lands here: the next tries get granted = false until that lease expires.
        logger.warn(`Projection ${name}: lease acquire failed, retrying: ${err}`);
      }
      await this.sleep(runnerTimings.standbyRetryMs * (0.8 + 0.4 * Math.random()));
    }
    return false;
  }

  /**
   * Renews every TTL/3, from the server's ttl. On Aborted the lease is lost. On
   * any other error Renew retries every renewRetryMs and the runner keeps
   * processing. No expiry clock: only the server decides that the lease is lost.
   */
  private startRenew(ttlMs: number): void {
    const { projection, baseUrl, headers, logger } = this.config;
    const name = projection.config.name;
    const grant = this.leaseLost;
    const body = JSON.stringify({ name, lease: this.lease });
    let failures = 0;
    const renew = async (): Promise<void> => {
      let wait = runnerTimings.renewRetryMs;
      let failure = "";
      try {
        const resp = await fetch(`${baseUrl}/ironflow.v1.ProjectionService/RenewProjectionLease`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body,
          // A hung Renew would stop all renews until the lease expires: bound it.
          signal: AbortSignal.any([this.intakeSignal, AbortSignal.timeout(ttlMs / 3)]),
        });
        if (this.renewGrant !== grant) return; // a late answer must not touch the next grant
        if (resp.ok) {
          ttlMs = durationMs(((await resp.json()) as { ttl?: string }).ttl) || ttlMs;
          wait = ttlMs / 3;
        } else {
          await throwIfLeaseLost(resp, `Projection ${name} renew`);
          failure = String(resp.status);
        }
      } catch (err) {
        if (this.renewGrant !== grant || this.intakeSignal.aborted) return;
        if (err instanceof ProjectionLeaseLostError) {
          this.stopRenew();
          this.lost(err);
          return;
        }
        failure = String(err);
      }
      if (failure) {
        failures++;
        // The retry stays at renewRetryMs, but the log thins to failures 1, 2, 4, 8 …: a down
        // engine must not flood the log.
        if ((failures & (failures - 1)) === 0) {
          logger.warn(`Projection ${name}: lease renew failed (${failures} in a row), retrying: ${failure}`);
        }
      } else if (failures) {
        logger.info(`Projection ${name}: lease renew recovered after ${failures} failures`);
        failures = 0;
      }
      if (this.renewGrant === grant) this.renewTimer = setTimeout(() => void renew(), wait);
    };
    this.renewGrant = grant;
    this.renewTimer = setTimeout(() => void renew(), ttlMs / 3);
  }

  private stopRenew(): void {
    this.renewGrant = null;
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
  }

  /** Frees the lease on a clean stop, so a standby takes it on its next try. Release never fails. */
  private async releaseLease(): Promise<void> {
    this.stopRenew();
    const lease = this.lease;
    this.lease = null;
    if (!lease) return;
    const { projection, baseUrl, headers } = this.config;
    await fetch(`${baseUrl}/ironflow.v1.ProjectionService/ReleaseProjectionLease`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: projection.config.name, lease }),
      signal: AbortSignal.timeout(runnerTimings.stopTimeoutMs),
    }).catch(() => {});
  }

  /**
   * Marks the held lease lost on a lease error, and reports whether it is lost.
   * A lost lease closes the stream. An unguarded runner never loses a lease.
   */
  private lost(err?: unknown): boolean {
    if (err instanceof ProjectionLeaseLostError && this.lease && !this.leaseLost.signal.aborted) {
      this.leaseLost.abort();
      this.streamAbort?.abort();
    }
    return this.leaseLost.signal.aborted;
  }

  /** Stops the batch when the lease is lost. */
  private checkLease(): void {
    if (this.leaseLost.signal.aborted) throw new ProjectionLeaseLostError("projection lease lost");
  }

  /** Adds the held lease to a request body. An unguarded runner sends none: the server rejects an empty one. */
  private withLease<T extends object>(body: T): T & { lease?: ProjectionLease } {
    return this.lease ? { ...body, lease: this.lease } : body;
  }

  /**
   * Forgets a lost grant: its unsaved events, its stream frames and its state.
   * The fenced runner did not move the cursor, so the next holder reads the
   * events again.
   */
  private async dropGrant(): Promise<void> {
    this.stopRenew();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushChain; // a batch of the lost grant must not send the next grant's lease
    this.pendingEvents = [];
    this.flushFailed = false;
    this.resetManagedState();
    this.lease = null;
    this.leaseLost = new AbortController();
  }

  /** Starts the managed state from initialState(); the stream then loads the saved state. */
  private resetManagedState(): void {
    const { mode, initialState } = this.config.projection.config;
    const init = mode === "managed" ? initialState : undefined;
    this.managedState = init ? init() : null;
    this.managedStateInitialized = init !== undefined;
  }

  private async streamLoop(): Promise<void> {
    const { projection, baseUrl, headers, logger } = this.config;
    const name = projection.config.name;

    // Track consecutive connection failures so the first drop (often just
    // a proxy/socket idle timeout during quiet periods) logs at info rather
    // than error. Escalates to error after repeated failures — at that
    // point something is actually broken.
    let consecutiveFailures = 0;

    while (!this.intakeSignal.aborted) {
      this.checkLease();
      this.streamAbort = new AbortController();
      // Any data frame, heartbeats included, proves the connection worked. The end-of-stream
      // trailer does not count: a refusal trailer arrives on every reconnect and must keep the
      // backoff climbing.
      let worked = false;
      this.progressed = false;
      try {
        const resp = await fetch(
          `${baseUrl}/ironflow.v1.ProjectionService/StreamProjectionEvents`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/connect+json",
            },
            body: encodeConnectEnvelope(JSON.stringify(this.withLease({
              name,
              batchSize: projection.config.batchSize || 100,
              // Opt in to server-side keepalive heartbeats. Server emits
              // empty ProjectionEvent frames with kind=HEARTBEAT every
              // ~15s so idle streams don't get closed by proxies/LBs or
              // Node's default fetch socket idle timer.
              acceptHeartbeats: true,
            }))),
            signal: this.streamAbort.signal,
          }
        );

        if (this.intakeSignal.aborted) {
          await resp.body?.cancel();
          break;
        }
        if (!resp.ok) {
          const status = resp.status;
          // Connect maps HTTP 404 to unimplemented; 501 maps to unknown, a retried failure.
          if (status === 404) {
            throw new StreamingUnsupportedError(
              `Server does not support StreamProjectionEvents (${status})`
            );
          }
          // Auth failures (401/403) are non-transient. NOT StreamingUnsupported:
          // that would fall back to polling, which 401-loops at 10s instead of
          // surfacing anything actionable (#1673).
          throwIfAuthError(status, `Projection ${name} stream`);
          throw new Error(`Stream request failed: ${status}`);
        }

        if (!resp.body) {
          throw new Error("No response body for streaming");
        }

        // Read the streaming response using the ConnectRPC streaming envelope format.
        // Each message is: 1 byte flags + 4 bytes big-endian length + JSON payload.
        const reader = resp.body.getReader();
        let streamFailed = false;
        let streamError: unknown;

        try {
          let buffer = new Uint8Array(0);

          while (!this.intakeSignal.aborted) {
            const { done, value } = await reader.read();
            if (done || this.intakeSignal.aborted) break;

            // Append new data to buffer
            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;

            // Process all complete messages in the buffer
            while (buffer.length >= 5) {
              // ConnectRPC envelope: flags(1) + length(4) + payload(length)
              const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
              const msgLength = dataView.getUint32(1, false); // big-endian
              const totalLength = 5 + msgLength;

              if (buffer.length < totalLength) break; // Incomplete message

              const flags = buffer[0] ?? 0;
              const payload = buffer.slice(5, totalLength);
              buffer = buffer.slice(totalLength);

              // ConnectRPC end-of-stream trailer (flags bit 1 set)
              if (flags & 0x02) {
                let trailerError: { code?: string; message?: string } | undefined;
                try {
                  trailerError = (JSON.parse(new TextDecoder().decode(payload)) as { error?: typeof trailerError }).error;
                } catch { /* ignore malformed trailers */ }
                if (trailerError) throwConnectError(trailerError, `Projection ${name} stream`);
                break; // End of stream
              }

              worked = true;

              const text = new TextDecoder().decode(payload);
              try {
                const event = JSON.parse(text) as PollEvent & { kind?: string | number };
                // Skip server-side keepalive heartbeats (issue #550).
                // Proto enum renders as string name in ConnectRPC JSON,
                // but accept the numeric form defensively.
                if (event.kind === "PROJECTION_EVENT_KIND_HEARTBEAT" || event.kind === 2) {
                  continue;
                }
                this.enqueueEvent(normalizeEvent(event));
              } catch {
                // Skip malformed messages
                logger.warn(`Skipping malformed stream message: ${text.slice(0, 100)}`);
              }
            }
          }
        } catch (e) {
          this.lost(e);
          streamFailed = true;
          streamError = e;
        } finally {
          reader.releaseLock();
        }
        // On stop, finishStop() does the final flush so its save errors reject stop().
        // A lost lease drops the frames received before the error (ADR 0120 section 3).
        if (!this.intakeSignal.aborted && !this.leaseLost.signal.aborted) {
          try {
            await this.flushChain;
            await this.flushPending();
          } catch (e) {
            this.flushFailed = true;
            // The stream's own error wins (poll fallback or auth failure below, #1673), except a
            // lease-lost save: that goes to standby, never the reconnect loop (ADR 0120).
            if (!streamFailed || this.lost(e)) throw e;
            logger.warn(`Projection ${name}: flush after stream error failed: ${e}`);
          }
        }
        if (streamFailed) throw streamError;

        // Stream ended normally (server restart, etc.)
        if (!this.intakeSignal.aborted) {
          // A failed batch is not a clean end. The flush above returns early in this case, so
          // the catch below must count it.
          if (this.flushFailed) throw new Error(`Projection ${name}: batch failed, reconnecting`);
          logger.info(`Projection stream ended for ${name}, reconnecting...`);
          consecutiveFailures = 0;
          await this.flushChain;
          this.pendingEvents = [];
          this.flushFailed = false;
          await this.sleep(1000);
        }
      } catch (err) {
        if (this.intakeSignal.aborted) break;

        // A lost lease goes to standby: no reconnect ladder and no poll fallback. A lost lease
        // that Renew found closes the stream, so the error here can be an AbortError.
        if (this.lost(err)) {
          throw err instanceof ProjectionLeaseLostError ? err : new ProjectionLeaseLostError("projection lease lost");
        }

        // Re-throw StreamingUnsupportedError so caller can fall back to polling
        if (err instanceof StreamingUnsupportedError) {
          throw err;
        }

        // Auth failures will not fix themselves on the reconnect cadence (#1673).
        if (
          err instanceof UnauthenticatedError ||
          err instanceof UnauthorizedError
        ) {
          throw err;
        }

        // A stream that worked and then dropped starts the ladder again. A batch that always
        // fails (handler, load, save or ack) must not: it would reconnect every 2s at info, forever.
        // A batch that succeeded proves the processing works too.
        if (this.progressed || (worked && !this.flushFailed)) consecutiveFailures = 0;
        consecutiveFailures += 1;
        if (consecutiveFailures < FAIL_LOG_ESCALATE_AT) {
          // First failures are typically idle-timeout reconnects during
          // quiet periods — don't pollute logs. Issue #550.
          logger.info(`Projection stream disconnected for ${name}, reconnecting (attempt ${consecutiveFailures})`);
        } else {
          logger.error(`Projection stream error for ${name} (${consecutiveFailures} consecutive failures): ${err}`);
        }
        // Back off, capped. A flat delay here is a log-and-socket firehose against an engine
        // that is DOWN: the reconnect can never succeed, so every projection emits an error line
        // on every attempt, forever. One workspace reached 93,046 consecutive failures — two days
        // of a 2s cadence — and the worker.log outgrew the repo it sat in.
        //
        // Derived from consecutiveFailures rather than kept as its own field, so it resets
        // together with the log escalation (a stream that worked, or ended cleanly) and a
        // flaky-but-working link can never stick at the ceiling. Do NOT use this.backoffMs: that
        // one belongs to the polling fallback and mutating it from here would corrupt its ladder.
        await this.flushChain;
        this.pendingEvents = [];
        this.flushFailed = false;
        await this.sleep(
          calculateBackoff(consecutiveFailures, RECONNECT_BASE_MS, RECONNECT_MAX_MS)
        );
      }
    }
  }

  /**
   * Enqueue an event from the stream into the micro-batch.
   * Flushes when batch is full or after FLUSH_INTERVAL_MS of inactivity.
   * Flush calls are serialized via flushChain to prevent concurrent state mutations.
   */
  private enqueueEvent(event: PollEvent): void {
    this.pendingEvents.push(event);

    const batchSize = this.config.projection.config.batchSize || 100;
    if (this.pendingEvents.length >= batchSize) {
      // Batch full — flush immediately, serialized through the chain
      this.scheduleFlush();
    } else if (!this.flushTimer) {
      // Start the flush timer
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.scheduleFlush();
      }, runnerTimings.flushIntervalMs);
    }
  }

  /** Serializes flush calls so only one runs at a time */
  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(() => this.flushPending()).catch((err) => {
      // A failed save/ack: drop the rest and reconnect; the engine rewinds to the saved cursor (#2404).
      this.flushFailed = true;
      this.pendingEvents = [];
      // A lost lease closes the stream too, and goes to standby instead of the reconnect.
      if (this.lost(err)) return;
      this.config.logger.warn(`Projection flush failed, reconnecting: ${err}`);
      this.streamAbort?.abort();
    });
  }

  /**
   * Flush pending events through the handler and persist state.
   */
  private async flushPending(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.flushFailed) {
      this.pendingEvents = [];
      return; // flushing past a failed batch would skip it
    }

    const events = this.pendingEvents.splice(0);
    if (events.length === 0) return;

    const projConfig = this.config.projection.config;

    if (projConfig.mode === "managed") {
      await this.processManagedBatch(events);
    } else {
      await this.processExternalBatch(events);
    }
    this.progressed = true;
  }

  /**
   * Process a batch of events in managed mode: run reducer, save state.
   * globalState overrides the in-memory __global__ state (the poll path).
   */
  private async processManagedBatch(events: PollEvent[], globalState?: unknown): Promise<void> {
    const projConfig = this.config.projection.config;

    // Reduce and save in seq order, one run of consecutive same-partition
    // events at a time. Each save moves the server cursor to the run's last
    // seq, so a failed save leaves only unsaved events past the cursor.
    const runs: {
      pk: string;
      events: PollEvent[];
      lastEventId: string;
      lastEventSeq: number;
      lastEventTime?: string;
    }[] = [];
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      const pk = (event.metadata?.["__partition"] as string) || "__global__";
      const last = runs[runs.length - 1];
      if (last?.pk === pk) {
        last.events.push(event);
      } else {
        runs.push({ pk, events: [event], lastEventId: "", lastEventSeq: 0 });
      }
    }

    // Load every partition before the first save, so a failed load saves nothing.
    const states = new Map<string, unknown>();
    const keys = [...new Set(runs.map((r) => r.pk))].filter((pk) => pk !== "__global__");
    for (let i = 0; i < keys.length; i += 8) {
      const chunk = keys.slice(i, i + 8);
      const loaded = await Promise.all(chunk.map((pk) => this.loadPartitionState(pk)));
      chunk.forEach((pk, j) => states.set(pk, loaded[j]));
    }
    const global = globalState !== undefined ? globalState : this.managedStateInitialized ? this.managedState : undefined;
    // A {} state means "no state", as in the Go and Python runners (#2796).
    const noGlobal =
      global == null ||
      (typeof global === "object" && !Array.isArray(global) && Object.keys(global).length === 0);
    states.set("__global__", noGlobal ? (projConfig.initialState ? projConfig.initialState() : {}) : global);

    for (const batch of runs) {
      const pk = batch.pk;
      let state = states.get(pk);

      for (const event of batch.events) {
        const ctx = this.buildContext(event);
        state = (projConfig.handler as ManagedProjectionHandler)(state, event, ctx);
        batch.lastEventId = event.id;
        batch.lastEventSeq = event.seq;
        batch.lastEventTime = event.timestamp;
      }

      this.checkLease(); // Renew lost the lease: stop the batch before its next save
      await this.saveState(state, batch.lastEventId, batch.lastEventSeq, batch.lastEventTime, pk);
      states.set(pk, state);

      // Only after a successful save: a failed save must not leave unsaved events in memory (#2404).
      if (pk === "__global__") {
        this.managedState = state;
        this.managedStateInitialized = true;
      }
    }
  }

  /**
   * Process a batch of events in external mode: run handler, ack.
   */
  private async processExternalBatch(events: PollEvent[]): Promise<void> {
    const projConfig = this.config.projection.config;
    let lastEventId = "";
    let lastEventSeq = 0;

    for (const event of events) {
      this.checkLease(); // external handlers have side effects: stop the batch at once
      const ctx = this.buildContext(event);
      await (projConfig.handler as ExternalProjectionHandler)(event, ctx);
      lastEventId = event.id;
      lastEventSeq = event.seq;
    }

    this.checkLease();
    await this.ackEvents(lastEventId, lastEventSeq);
  }

  /**
   * Load existing projection state from the server so streaming resumes
   * with the correct accumulated state. Throws on failure, as the Python runner
   * does: streaming from initialState() would save over the saved state.
   */
  private async loadExistingState(): Promise<void> {
    const { projection, baseUrl, headers } = this.config;
    if (projection.config.mode !== "managed") return;

    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/GetProjection`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: projection.config.name }),
        signal: this.intakeSignal,
      }
    );
    if (resp.status === 404) return; // no saved state yet, as in the Python runner
    if (!resp.ok) {
      throwIfAuthError(resp.status, `Projection ${projection.config.name} state`);
      throw new Error(`Failed to load projection state: ${resp.status}`);
    }
    const data = await resp.json() as { state?: unknown; stateValue?: unknown };
    // A state that is not a JSON object arrives in stateValue (#1963).
    if (data.stateValue !== undefined && data.stateValue !== null) {
      this.managedState = data.stateValue;
      this.managedStateInitialized = true;
    } else if (
      data.state &&
      typeof data.state === "object" &&
      Object.keys(data.state as Record<string, unknown>).length > 0
    ) {
      this.managedState = data.state;
      this.managedStateInitialized = true;
    }
  }

  /**
   * Saved state of one partition, or initialState() when it has none. Throws
   * rather than falling back, so a failed load never overwrites saved state.
   */
  private async loadPartitionState(partition: string): Promise<unknown> {
    const { projection, baseUrl, headers } = this.config;
    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/GetProjection`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: projection.config.name, partition }),
      }
    );
    if (!resp.ok) {
      throwIfAuthError(resp.status, `Projection ${projection.config.name} partition ${partition}`);
      throw new Error(`Failed to load state of partition ${partition}: ${resp.status}`);
    }
    const data = (await resp.json()) as { state?: unknown; stateValue?: unknown };
    // A state that is not a JSON object arrives in stateValue (#1963).
    if (data.stateValue !== undefined && data.stateValue !== null) {
      return data.stateValue;
    }
    if (
      data.state &&
      typeof data.state === "object" &&
      Object.keys(data.state as Record<string, unknown>).length > 0
    ) {
      return data.state;
    }
    return projection.config.initialState ? projection.config.initialState() : {};
  }

  /**
   * Start in poll mode (fallback). Uses the existing PollProjectionEvents RPC
   * with exponential backoff.
   */
  start(): Promise<void> {
    if (this.intakeSignal.aborted) return Promise.resolve();
    this.runPromise = this.runPolling();
    return this.runPromise;
  }

  private async runPolling(): Promise<void> {
    await this.config.after;
    if (!(await this.retryUntilStopped("register", () => this.register()))) return;
    this.config.logger.info(
      `Projection runner started: ${this.config.projection.config.name}`
    );
    await this.runLeased(() => this.pollLoop());
  }

  private async pollLoop(): Promise<void> {
    while (!this.intakeSignal.aborted) {
      this.checkLease();
      try {
        const processed = await this.poll();
        if (processed > 0) {
          this.backoffMs = 1000; // Reset backoff
        } else {
          // Backoff on empty poll
          await this.sleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, 10000);
        }
      } catch (err) {
        if (this.intakeSignal.aborted) break;
        if (this.lost(err)) throw err; // standby, not the poll backoff
        // Auth failure: stop this runner with an actionable message rather than
        // polling a 401 forever (#1673). The worker keeps running.
        if (
          err instanceof UnauthenticatedError ||
          err instanceof UnauthorizedError
        ) {
          throw err;
        }
        this.config.logger.error(`Projection poll error: ${err}`);
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 10000);
      }
    }
  }

  /** Permanently stops intake and waits for accepted events to finish saving. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopAbort.abort();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    const work = (async () => {
      // Run errors were already reported to the start caller; only the final save matters here.
      await this.runPromise.catch(() => {});
      await this.flushChain;
      // A stop can win the race with a lost lease: drop that grant's frames, do not save them.
      if (this.leaseLost.signal.aborted) await this.dropGrant();
      else await this.flushPending();
    })();
    work.catch(() => {}); // a save that fails after the bound must not be an unhandled rejection
    // Bounded like Go and Python: a handler or save that hangs must not keep the
    // lease from its Release. A save still in flight is then fenced by the Release.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.config.logger.warn(
          `Projection ${this.config.projection.config.name}: stop timed out after ${runnerTimings.stopTimeoutMs} ms, abandoning the final batch`,
        );
        resolve();
      }, runnerTimings.stopTimeoutMs);
    });
    try {
      await Promise.race([work, bound]);
    } finally {
      clearTimeout(timer);
      // After the final save: a Release first would fence it.
      await this.releaseLease();
    }
  }

  private async poll(): Promise<number> {
    const { projection, baseUrl, headers } = this.config;

    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/PollProjectionEvents`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(this.withLease({
          name: projection.config.name,
          batchSize: projection.config.batchSize || 100,
        })),
        signal: this.intakeSignal,
      }
    );
    if (!resp.ok) {
      await throwIfLeaseLost(resp, `Projection ${projection.config.name} poll`);
      throwIfAuthError(resp.status, `Projection ${projection.config.name} poll`);
      throw new Error(`Poll failed: ${resp.status}`);
    }

    const data = (await resp.json()) as PollResponse;
    if (this.intakeSignal.aborted) return 0;
    const events = (data.events || []).map(normalizeEvent);
    if (events.length === 0) return 0;

    const projConfig = projection.config;

    if (projConfig.mode === "managed") {
      // The poll response carries the __global__ state; partitions load their own.
      await this.processManagedBatch(
        events,
        data.currentStateValue ?? data.currentState ?? (projConfig.initialState ? projConfig.initialState() : {})
      );
    } else {
      await this.processExternalBatch(events);
    }

    return events.length;
  }

  private buildContext(event: PollEvent): ProjectionContext {
    return {
      event: {
        id: event.id,
        name: event.name,
        seq: event.seq || 0,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        metadata: event.metadata,
      },
      projection: {
        name: this.config.projection.config.name,
        version: 1,
      },
      logger: this.config.logger,
    };
  }

  private async saveState(
    state: unknown,
    lastEventId: string,
    lastEventSeq: number,
    lastEventTime?: string,
    partitionKey?: string
  ): Promise<void> {
    const { baseUrl, headers, projection } = this.config;
    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/SaveProjectionState`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(this.withLease({
          name: projection.config.name,
          partitionKey: partitionKey ?? "",
          // `state` is a Struct and holds objects only; any other value goes in stateValue (#1963).
          ...(state !== null && typeof state === "object" && !Array.isArray(state) ? { state } : { stateValue: state }),
          lastEventId,
          lastEventSeq,
          lastEventTime,
        })),
      }
    );
    if (!resp.ok) {
      await throwIfLeaseLost(resp, `Projection ${projection.config.name} save`);
      throwIfAuthError(resp.status, `Projection ${projection.config.name} save`);
      // Include the server's message, not just the status. The commonest cause
      // is a managed handler that does not `return state`: the handler's result
      // is `undefined`, JSON.stringify drops the key entirely, and the server
      // rejects the stateless save with InvalidArgument naming the missing
      // return. A bare "Save state failed: 400" throws that explanation away
      // and leaves the developer with nothing to act on.
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `Save state failed: ${resp.status}${detail ? ` — ${detail}` : ""}`
      );
    }
  }

  private async ackEvents(
    lastEventId: string,
    lastEventSeq: number
  ): Promise<void> {
    const { baseUrl, headers, projection } = this.config;
    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/AckProjectionEvents`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(this.withLease({
          name: projection.config.name,
          lastEventId,
          lastEventSeq,
        })),
      }
    );
    if (!resp.ok) {
      await throwIfLeaseLost(resp, `Projection ${projection.config.name} ack`);
      throwIfAuthError(resp.status, `Projection ${projection.config.name} ack`);
      throw new Error(`Ack events failed: ${resp.status}`);
    }
  }

  /** Pauses. Stop and a lost lease end it early. */
  private sleep(ms: number): Promise<void> {
    const signals = [this.intakeSignal, this.leaseLost.signal];
    return new Promise((resolve) => {
      if (signals.some((s) => s.aborted)) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        for (const s of signals) s.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      for (const s of signals) s.addEventListener("abort", finish, { once: true });
    });
  }
}

/** The server fenced the runner's lease: Aborted, "projection lease lost" (ADR 0120 section 3). */
/** The server rejected the projection config (InvalidArgument). A retry cannot fix it. */
class ProjectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionConfigError";
  }
}

class ProjectionLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionLeaseLostError";
  }
}

/** Error thrown when the server doesn't support the streaming RPC */
export class StreamingUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

/**
 * Start a runner per configured projection, streaming where the server supports
 * it and polling where it does not. Shared by both pull workers: projections are
 * plain HTTP and have nothing to do with how the worker receives its jobs, so
 * the streaming worker accepting `projections` and doing nothing with them was
 * silence, not a design (#2027).
 *
 * Returns the started runners so the caller can stop them; failures are logged,
 * never thrown — a broken projection must not take the worker down.
 */
export function startProjectionRunners(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projections: IronflowProjection<any, any>[] | undefined;
  baseUrl: string;
  headers: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
  after?: Promise<void>;
}): ProjectionRunner[] {
  if (!opts.projections?.length) {
    return [];
  }

  const runners: ProjectionRunner[] = [];
  for (const projection of opts.projections) {
    const runner = createProjectionRunner({
      projection,
      baseUrl: opts.baseUrl,
      headers: opts.headers,
      logger: opts.logger,
      signal: opts.signal,
      after: opts.after,
    });
    runners.push(runner);

    // Streams, or polls when the server cannot stream.
    runner.run().catch((err) => {
      opts.logger.error(`Projection runner failed: ${err}`);
    });
  }

  opts.logger.info(`Started ${runners.length} projection runner(s)`);
  return runners;
}

export function createProjectionRunner(config: ProjectionRunnerConfig): ProjectionRunner {
  return new ProjectionRunner(config);
}

/**
 * Stops the runners. The result resolves once they and `previous` have stopped;
 * pass it as `after` to the replacements so old and new streams never overlap (#2770).
 */
export async function stopProjectionRunners(
  runners: ProjectionRunner[],
  logger: Logger,
  previous?: Promise<void>
): Promise<void> {
  await Promise.all([
    previous,
    ...runners.map((runner) =>
      runner.stop().catch((err) => logger.warn(`Projection runner stop failed: ${err}`))
    ),
  ]);
}
