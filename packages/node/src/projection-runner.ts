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
 */

import type {
  IronflowProjection,
  ProjectionContext,
  Logger,
  ManagedProjectionHandler,
  ExternalProjectionHandler,
} from "@ironflow/core";

export interface ProjectionRunnerConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projection: IronflowProjection<any, any>;
  baseUrl: string;
  headers: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
}

/** Event shape returned by PollProjectionEvents / StreamProjectionEvents */
interface PollEvent {
  id: string;
  name: string;
  data: unknown;
  seq: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/** Response shape from PollProjectionEvents */
interface PollResponse {
  events: PollEvent[];
  currentState?: unknown;
}

/** Micro-batch flush configuration */
const FLUSH_INTERVAL_MS = 100;

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

export class ProjectionRunner {
  private config: ProjectionRunnerConfig;
  private running = false;
  private backoffMs = 1000;

  // Micro-batch state for streaming mode
  private pendingEvents: PollEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes flushPending calls to prevent concurrent state mutations
  private flushChain: Promise<void> = Promise.resolve();
  // In-memory state for managed projections (accumulated across micro-batches)
  private managedState: unknown = null;
  private managedStateInitialized = false;

  constructor(config: ProjectionRunnerConfig) {
    this.config = config;
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
      }
    );
    if (!resp.ok) {
      throw new Error(`Failed to register projection: ${resp.status}`);
    }
  }

  /**
   * Start in streaming mode (preferred). Opens a ConnectRPC server-stream
   * that delivers events in real-time. Falls back to polling if the server
   * returns Unimplemented or the stream fails to connect.
   */
  async startStreaming(): Promise<void> {
    this.running = true;
    await this.register();

    const { projection, baseUrl, headers, logger } = this.config;
    const name = projection.config.name;

    logger.info(`Projection runner started (streaming): ${name}`);

    // Initialize managed state from initialState() if available
    if (projection.config.mode === "managed" && projection.config.initialState) {
      this.managedState = projection.config.initialState();
      this.managedStateInitialized = true;
    }

    // Fetch existing state from server to resume from where we left off
    await this.loadExistingState();

    // Track consecutive connection failures so the first drop (often just
    // a proxy/socket idle timeout during quiet periods) logs at info rather
    // than error. Escalates to error after repeated failures — at that
    // point something is actually broken.
    let consecutiveFailures = 0;
    const FAIL_LOG_ESCALATE_AT = 3;

    while (this.running && !this.config.signal?.aborted) {
      try {
        const resp = await fetch(
          `${baseUrl}/ironflow.v1.ProjectionService/StreamProjectionEvents`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/connect+json",
            },
            body: encodeConnectEnvelope(JSON.stringify({
              name,
              batchSize: projection.config.batchSize || 100,
              // Opt in to server-side keepalive heartbeats. Server emits
              // empty ProjectionEvent frames with kind=HEARTBEAT every
              // ~15s so idle streams don't get closed by proxies/LBs or
              // Node's default fetch socket idle timer.
              acceptHeartbeats: true,
            })),
            signal: this.config.signal,
          }
        );

        if (!resp.ok) {
          const status = resp.status;
          // If server doesn't support streaming, let the caller know to fall back
          if (status === 404 || status === 501) {
            throw new StreamingUnsupportedError(
              `Server does not support StreamProjectionEvents (${status})`
            );
          }
          // Auth failures (401/403) are non-transient — break out of the reconnect loop
          if (status === 401 || status === 403) {
            throw new StreamingUnsupportedError(
              `Stream authentication failed (${status}) — check credentials`
            );
          }
          throw new Error(`Stream request failed: ${status}`);
        }

        if (!resp.body) {
          throw new Error("No response body for streaming");
        }

        // Read the streaming response using the ConnectRPC streaming envelope format.
        // Each message is: 1 byte flags + 4 bytes big-endian length + JSON payload.
        const reader = resp.body.getReader();

        try {
          let buffer = new Uint8Array(0);

          while (this.running && !this.config.signal?.aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            // Successful read — the connection is healthy, so clear the
            // failure counter that gates error-log escalation.
            consecutiveFailures = 0;

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
                const text = new TextDecoder().decode(payload);
                try {
                  const trailer = JSON.parse(text) as { error?: { code?: string; message?: string } };
                  if (trailer.error) {
                    logger.error(`Stream trailer error: ${trailer.error.message || trailer.error.code}`);
                  }
                } catch { /* ignore malformed trailers */ }
                break; // End of stream
              }

              const text = new TextDecoder().decode(payload);
              try {
                const event = JSON.parse(text) as PollEvent & { kind?: string | number };
                // Skip server-side keepalive heartbeats (issue #550).
                // Proto enum renders as string name in ConnectRPC JSON,
                // but accept the numeric form defensively.
                if (event.kind === "PROJECTION_EVENT_KIND_HEARTBEAT" || event.kind === 2) {
                  continue;
                }
                // Normalize field names from protobuf JSON (camelCase)
                const normalized: PollEvent = {
                  id: event.id || "",
                  name: event.name || "",
                  data: event.data,
                  seq: typeof event.seq === "string" ? parseInt(event.seq as unknown as string, 10) : (event.seq || 0),
                  timestamp: event.timestamp,
                  metadata: event.metadata,
                };
                this.enqueueEvent(normalized);
              } catch {
                // Skip malformed messages
                logger.warn(`Skipping malformed stream message: ${text.slice(0, 100)}`);
              }
            }
          }
        } finally {
          reader.releaseLock();
          // Flush any remaining events
          await this.flushPending();
        }

        // Stream ended normally (server restart, etc.)
        if (this.running) {
          logger.info(`Projection stream ended for ${name}, reconnecting...`);
          await this.sleep(1000);
        }
      } catch (err) {
        if (!this.running || this.config.signal?.aborted) break;

        // Re-throw StreamingUnsupportedError so caller can fall back to polling
        if (err instanceof StreamingUnsupportedError) {
          throw err;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures < FAIL_LOG_ESCALATE_AT) {
          // First failures are typically idle-timeout reconnects during
          // quiet periods — don't pollute logs. Issue #550.
          logger.info(`Projection stream disconnected for ${name}, reconnecting (attempt ${consecutiveFailures})`);
        } else {
          logger.error(`Projection stream error for ${name} (${consecutiveFailures} consecutive failures): ${err}`);
        }
        await this.sleep(2000); // Brief delay before reconnect
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
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** Serializes flush calls so only one runs at a time */
  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(() => this.flushPending()).catch(() => {});
  }

  /**
   * Flush pending events through the handler and persist state.
   */
  private async flushPending(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const events = this.pendingEvents.splice(0);
    if (events.length === 0) return;

    const projConfig = this.config.projection.config;

    if (projConfig.mode === "managed") {
      await this.processManagedBatch(events);
    } else {
      await this.processExternalBatch(events);
    }
  }

  /**
   * Process a batch of events in managed mode: run reducer, save state.
   */
  private async processManagedBatch(events: PollEvent[]): Promise<void> {
    const projConfig = this.config.projection.config;

    // Group by partition
    const partitions = new Map<
      string,
      { events: PollEvent[]; lastEventId: string; lastEventSeq: number; lastEventTime?: string }
    >();
    for (const event of events) {
      const pk = (event.metadata?.["__partition"] as string) || "__global__";
      if (!partitions.has(pk)) {
        partitions.set(pk, { events: [], lastEventId: "", lastEventSeq: 0 });
      }
      partitions.get(pk)!.events.push(event);
    }

    for (const [pk, batch] of partitions) {
      // For __global__ partition, use in-memory accumulated state
      let state: unknown;
      if (pk === "__global__" && this.managedStateInitialized) {
        state = this.managedState;
      } else {
        state = projConfig.initialState ? projConfig.initialState() : {};
      }

      for (const event of batch.events) {
        const ctx = this.buildContext(event);
        state = (projConfig.handler as ManagedProjectionHandler)(state, event as any, ctx);
        batch.lastEventId = event.id;
        batch.lastEventSeq = event.seq;
        batch.lastEventTime = event.timestamp;
      }

      // Update in-memory state for __global__ partition
      if (pk === "__global__") {
        this.managedState = state;
        this.managedStateInitialized = true;
      }

      await this.saveState(state, batch.lastEventId, batch.lastEventSeq, batch.lastEventTime, pk);
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
      const ctx = this.buildContext(event);
      await (projConfig.handler as ExternalProjectionHandler)(event as any, ctx);
      lastEventId = event.id;
      lastEventSeq = event.seq;
    }

    await this.ackEvents(lastEventId, lastEventSeq);
  }

  /**
   * Load existing projection state from the server so streaming resumes
   * with the correct accumulated state.
   */
  private async loadExistingState(): Promise<void> {
    const { projection, baseUrl, headers, logger } = this.config;
    if (projection.config.mode !== "managed") return;

    try {
      const resp = await fetch(
        `${baseUrl}/ironflow.v1.ProjectionService/GetProjection`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: projection.config.name }),
        }
      );
      if (resp.ok) {
        const data = await resp.json() as { state?: unknown };
        if (
          data.state &&
          typeof data.state === "object" &&
          Object.keys(data.state as Record<string, unknown>).length > 0
        ) {
          this.managedState = data.state;
          this.managedStateInitialized = true;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load existing projection state: ${err}`);
    }
  }

  /**
   * Start in poll mode (fallback). Uses the existing PollProjectionEvents RPC
   * with exponential backoff.
   */
  async start(): Promise<void> {
    this.running = true;
    await this.register();
    this.config.logger.info(
      `Projection runner started: ${this.config.projection.config.name}`
    );

    while (this.running && !this.config.signal?.aborted) {
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
        this.config.logger.error(`Projection poll error: ${err}`);
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 10000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for any in-flight flush, then flush remaining events
    await this.flushChain;
    await this.flushPending();
  }

  private async poll(): Promise<number> {
    const { projection, baseUrl, headers } = this.config;

    const resp = await fetch(
      `${baseUrl}/ironflow.v1.ProjectionService/PollProjectionEvents`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projection.config.name,
          batchSize: projection.config.batchSize || 100,
        }),
      }
    );
    if (!resp.ok) throw new Error(`Poll failed: ${resp.status}`);

    const data = (await resp.json()) as PollResponse;
    const events = data.events || [];
    if (events.length === 0) return 0;

    const projConfig = projection.config;

    if (projConfig.mode === "managed") {
      // Managed mode: group events by partition, run reducer per partition, save each.
      const partitions = new Map<
        string,
        { events: PollEvent[]; lastEventId: string; lastEventSeq: number; lastEventTime?: string }
      >();
      for (const event of events) {
        const pk =
          (event.metadata?.["__partition"] as string) || "__global__";
        if (!partitions.has(pk)) {
          partitions.set(pk, {
            events: [],
            lastEventId: "",
            lastEventSeq: 0,
          });
        }
        partitions.get(pk)!.events.push(event);
      }

      for (const [pk, batch] of partitions) {
        // Use currentState from server only for __global__ (non-partitioned).
        let state =
          pk === "__global__" && data.currentState != null
            ? data.currentState
            : projConfig.initialState
              ? projConfig.initialState()
              : {};

        for (const event of batch.events) {
          const ctx = this.buildContext(event);
          state = (projConfig.handler as ManagedProjectionHandler)(
            state,
            event as any,
            ctx
          );
          batch.lastEventId = event.id;
          batch.lastEventSeq = event.seq;
          batch.lastEventTime = event.timestamp;
        }

        await this.saveState(
          state,
          batch.lastEventId,
          batch.lastEventSeq,
          batch.lastEventTime,
          pk
        );
      }
    } else {
      // External mode: run handler for each event, then ack
      let lastEventId = "";
      let lastEventSeq = 0;

      for (const event of events) {
        const ctx = this.buildContext(event);
        await (projConfig.handler as ExternalProjectionHandler)(
          event as any,
          ctx
        );
        lastEventId = event.id;
        lastEventSeq = event.seq;
      }

      await this.ackEvents(lastEventId, lastEventSeq);
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
        body: JSON.stringify({
          name: projection.config.name,
          partitionKey: partitionKey ?? "",
          state,
          lastEventId,
          lastEventSeq,
          lastEventTime,
        }),
      }
    );
    if (!resp.ok) throw new Error(`Save state failed: ${resp.status}`);
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
        body: JSON.stringify({
          name: projection.config.name,
          lastEventId,
          lastEventSeq,
        }),
      }
    );
    if (!resp.ok) throw new Error(`Ack events failed: ${resp.status}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.config.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}

/** Error thrown when the server doesn't support the streaming RPC */
export class StreamingUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

export function createProjectionRunner(config: ProjectionRunnerConfig): ProjectionRunner {
  return new ProjectionRunner(config);
}
