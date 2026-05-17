/**
 * memory() — durable agent memory backed by an entity stream + projection.
 *
 * Composition:
 *   - memory.append(eventName, data) → step.run wraps backend.appendEvent +
 *     auto-waitForCatchup so memory.get() inside the same run sees the write.
 *   - memory.get() → step.run wraps backend.getProjection. In-run cache
 *     short-circuits repeated reads. Cache invalidates on append.
 *   - memory.entityStream() — kept as NotImplementedError stub. Lands when a
 *     concrete cross-agent peer-memory use case surfaces.
 *
 * Cross-run retry safety: append generates a deterministic idempotencyKey
 * (`${runId}:memory.append:${counter}`) so a replayed handler appends the
 * same logical event and the server dedupes server-side.
 *
 * Anti-scope: raw event replay is not exposed. Consumers must register a
 * projection — see MemoryProjectionRequiredError.
 */

import type {
  AppendResult,
  ProjectionStateResult,
  StepClient,
} from "@ironflow/core";
import { IronflowError } from "@ironflow/core";
import { MemoryProjectionRequiredError } from "./errors.js";
import type {
  MemoryAppendOptions,
  MemoryClient,
  MemoryConfig,
  MemoryGetOptions,
} from "./types.js";

/**
 * Wait timeout for the auto-catchup after append. Stream-level minSeq is
 * sufficient for read-your-writes — partition param is intentionally not
 * passed. External projections (cursor at stream level only) reject
 * partition with 400; managed projections accept it but it adds nothing
 * for the typical single-stream agent memory pattern.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 5000;

/**
 * Default entity type when MemoryConfig.entityType is omitted. Server-side
 * the field is informational; "agent" matches the typical streamId convention
 * and avoids surprising users who don't know about it.
 */
const DEFAULT_ENTITY_TYPE = "agent";

class NotImplementedError extends IronflowError {
  constructor(method: string) {
    super(
      `memory.${method}() is not yet implemented — entityStream lands when a concrete cross-agent peer-memory use case surfaces`,
      {
        code: "AGENT_MEMORY_NOT_IMPLEMENTED",
        retryable: false,
        details: { method },
      }
    );
    this.name = "NotImplementedError";
  }
}

/**
 * Minimal backend the memory client needs. Wraps the IronflowClient surface
 * so tests can substitute a fake without constructing a real client.
 *
 * Method shapes mirror the underlying client methods:
 *   - appendEvent  → client.streams.append
 *   - getProjection → client.projections.get
 *   - waitForCatchup → client.projections.waitForCatchup
 */
export interface MemoryBackend {
  appendEvent(
    streamId: string,
    input: {
      name: string;
      data: Record<string, unknown>;
      entityType: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<AppendResult>;

  getProjection<TState = unknown>(
    name: string
  ): Promise<ProjectionStateResult<TState>>;

  waitForCatchup(
    name: string,
    opts: { minSeq: number; partition?: string; timeoutMs?: number }
  ): Promise<void>;
}

/**
 * Per-run in-memory cache for memory.get() reads.
 *
 * Default cache-on; invalidates on memory.append() within the same run.
 * Lives across step boundaries within a run, replaced fresh on replay.
 */
export interface MemoryRuntimeCache {
  has: boolean;
  value: unknown;
}

export function createMemoryRuntimeCache(): MemoryRuntimeCache {
  return { has: false, value: undefined };
}

/**
 * Tracks per-run append counter used for idempotency-key generation.
 *
 * Resets per run; replay on the same run reuses the counter value from
 * the call ordering — same sequence of memory.append calls produces the
 * same sequence of keys, so the server dedupes deterministically.
 */
export interface MemoryRuntimeCounters {
  appendCount: number;
}

export function createMemoryRuntimeCounters(): MemoryRuntimeCounters {
  return { appendCount: 0 };
}

/**
 * Build a MemoryClient backed by the supplied backend.
 *
 * The backend is required when `config` is set. Tests pass a fake backend;
 * agent.ts constructs the default backend from a runtime IronflowClient.
 */
export function makeMemory(
  step: StepClient,
  config: MemoryConfig | undefined,
  runId: string,
  cache: MemoryRuntimeCache,
  backend: MemoryBackend | undefined,
  counters: MemoryRuntimeCounters = createMemoryRuntimeCounters()
): MemoryClient {
  return {
    async get<T = unknown>(options?: MemoryGetOptions): Promise<T | undefined> {
      assertConfigured(config);
      if (!options?.bypassCache && cache.has) {
        return cache.value as T | undefined;
      }
      assertBackend(backend);
      const result = await step.run("memory.get", () =>
        backend.getProjection<T>(config.projection)
      );
      const state = result.state ?? undefined;
      cache.has = true;
      cache.value = state;
      return state;
    },

    async append<T = unknown>(
      eventName: string,
      data: T,
      options?: MemoryAppendOptions
    ): Promise<void> {
      assertConfigured(config);
      assertBackend(backend);

      const dataRecord = toAppendRecord(data);
      const counterIndex = counters.appendCount;
      counters.appendCount += 1;
      const idempotencyKey = `${runId}:memory.append:${counterIndex}`;

      const appended = await step.run("memory.append", () =>
        backend.appendEvent(config.streamId, {
          name: eventName,
          data: dataRecord,
          entityType: config.entityType ?? DEFAULT_ENTITY_TYPE,
          idempotencyKey,
          metadata: options?.metadata,
        })
      );

      if (appended.sequence && appended.sequence > 0) {
        await step.run("memory.append.wait", () =>
          backend.waitForCatchup(config.projection, {
            minSeq: appended.sequence!,
            timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
          })
        );
      }

      cache.has = false;
      cache.value = undefined;
    },

    async entityStream<T = unknown>(
      streamId: string,
      projectionName: string
    ): Promise<T | undefined> {
      if (!projectionName) {
        throw new MemoryProjectionRequiredError(streamId);
      }
      throw new NotImplementedError("entityStream");
    },
  };
}

function assertConfigured(config: MemoryConfig | undefined): asserts config {
  if (!config) {
    throw new IronflowError(
      "memory() requires AgentConfig.memory ({ streamId, projection }) to be set",
      { code: "AGENT_MEMORY_UNCONFIGURED", retryable: false }
    );
  }
}

function assertBackend(backend: MemoryBackend | undefined): asserts backend {
  if (!backend) {
    throw new IronflowError(
      "memory() requires a runtime backend — set IRONFLOW_URL (or IRONFLOW_SERVER_URL) so the agent can construct an IronflowClient, or inject a backend via test harness",
      { code: "AGENT_MEMORY_NO_BACKEND", retryable: false }
    );
  }
}

/**
 * Convert the user's data argument into the object shape AppendEvent expects.
 *
 * Rejects primitives, arrays, and null with a typed error rather than
 * silently wrapping them in `{ value }`. The wrap-on-write would round-trip
 * cleanly only if every projection reducer knows to unwrap it; rejecting
 * up-front avoids the silent shape mismatch.
 */
function toAppendRecord(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new IronflowError(
      "memory.append() requires data to be a plain object — primitives and arrays must be wrapped explicitly so the projection reducer sees a stable shape",
      {
        code: "AGENT_MEMORY_INVALID_DATA",
        retryable: false,
        details: { receivedType: data === null ? "null" : Array.isArray(data) ? "array" : typeof data },
      }
    );
  }
  return data as Record<string, unknown>;
}
