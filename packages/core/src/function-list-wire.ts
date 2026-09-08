import { registeredFunctionFromWire } from "./types.js";

/** Keep the public function-list fields when reading a Connect Function. */
export function functionListFromWire(raw: Record<string, unknown>) {
  const fn = registeredFunctionFromWire(raw);
  return {
    id: fn.id,
    name: fn.name,
    slug: fn.id,
    description: fn.description,
    triggers: fn.triggers,
    retry_attempts: fn.retry?.maxAttempts ?? 0,
    retry_delay_ms: fn.retry?.initialDelayMs ?? 0,
    retry_backoff: fn.retry?.backoffFactor ?? 0,
    timeout_ms: fn.timeoutMs ?? 0,
    ...(fn.concurrency
      ? {
          concurrency: {
            limit: fn.concurrency.limit,
            ...(fn.concurrency.key ? { key: fn.concurrency.key } : {}),
          },
        }
      : {}),
    execution_mode: fn.preferredMode ?? "",
    endpoint_url: fn.endpointUrl,
    actor_key: fn.actorKey,
    status: fn.status,
    version: fn.version,
    created_at: fn.createdAt,
    updated_at: fn.updatedAt,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
    ...(fn.debounce
      ? {
          debounce: {
            period_ms: fn.debounce.periodMs,
            key: fn.debounce.key ?? "",
            ...(fn.debounce.maxWaitMs
              ? { max_wait_ms: fn.debounce.maxWaitMs }
              : {}),
          },
        }
      : {}),
    ...(fn.cancelOn?.length ? { cancel_on: fn.cancelOn } : {}),
  };
}
