/**
 * Function definition registration, shared by both pull-mode workers.
 *
 * Announcing a worker tells the server which functions it *can run*; it does
 * not create them and carries no triggers. Without this call the event router
 * has nothing to match an incoming event against, so the worker connects,
 * heartbeats and executes nothing (#2027).
 */

import type { IronflowFunction, Logger } from "@ironflow/core";
import {
  DEFAULT_ENVIRONMENT,
  HEADERS,
  IronflowError,
  throwIfAuthError,
} from "@ironflow/core";
import { errorDetail } from "./error-detail.js";
import { createHash } from "node:crypto";

// Reserved metadata key carrying a hash of the handler source (#1280). The engine
// bumps a function's VERSION only when its registered config changes, and
// functionsConfigEqual compares metadata — so stamping the code hash here is what
// makes a code-only reload observable (ironflow_await_reload + the desktop
// staleness chip gate on that version bump). Reserved (`__` prefix) so it doesn't
// collide with user metadata.
export const CODE_HASH_META_KEY = "__ironflow_code_hash";

// functionCodeHash is a short deterministic hash of a handler's SOURCE. Content
// hash, NOT a nonce: two distinct instances with identical source (an identical
// dev-process restart) hash the same, so the version is not inflated; a body edit
// changes the source → the hash → the registered metadata → the engine version.
// Caveat: reflects the handler body only — edits to an imported helper the handler
// calls are not visible in handler.toString(). Exported for tests.
export function functionCodeHash(handler: unknown): string {
  return createHash("sha256").update(String(handler)).digest("hex").slice(0, 16);
}

/**
 * The environment a worker scopes its requests to.
 */
export function resolveEnvironment(configured?: string): string {
  return configured ?? process.env.IRONFLOW_ENV ?? DEFAULT_ENVIRONMENT;
}

/**
 * Common headers for a worker's HTTP calls, including environment.
 */
export function buildWorkerHeaders(
  environment: string,
  apiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [HEADERS.ENVIRONMENT]: environment,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Register every worker function's definition with the Ironflow server.
 */
export async function registerFunctions(opts: {
  baseUrl: string;
  functions: Map<string, IronflowFunction>;
  headers: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<void> {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  for (const [fnId, fn] of opts.functions) {
    const body: Record<string, unknown> = {
      id: fn.config.id,
      name: fn.config.name || fn.config.id,
      triggers: fn.config.triggers || [],
      preferredMode: "EXECUTION_MODE_PULL",
    };

    if (fn.config.description) body.description = fn.config.description;
    if (fn.config.retry) body.retry = fn.config.retry;
    if (fn.config.timeout) body.timeoutMs = fn.config.timeout;
    if (fn.config.concurrency) body.concurrency = fn.config.concurrency;
    if (fn.config.debounce) {
      // Server expects snake_case period_ms / max_wait_ms;
      // SDK uses camelCase for parity with the rest of the TS surface.
      body.debounce = {
        period_ms: fn.config.debounce.periodMs,
        key: fn.config.debounce.key ?? "",
        ...(fn.config.debounce.maxWaitMs != null
          ? { max_wait_ms: fn.config.debounce.maxWaitMs }
          : {}),
      };
    }
    if (fn.config.actorKey) body.actorKey = fn.config.actorKey;
    if (fn.config.recording != null) body.recording = fn.config.recording;
    if (fn.config.recordingProfile != null) body.recordingProfile = fn.config.recordingProfile;
    if (fn.config.recordingRetention != null) body.recordingRetention = fn.config.recordingRetention;
    // Stamp a hash of the handler source so a code edit changes the registered
    // config → the engine bumps the version → the reload barrier fires (#1280).
    body.metadata = { ...(fn.config.metadata ?? {}), [CODE_HASH_META_KEY]: functionCodeHash(fn.handler) };
    if (fn.config.secrets?.length) body.secrets = fn.config.secrets;
    if (fn.config.cancelOn?.length) {
      body.cancelOn = fn.config.cancelOn.map((s) => ({
        event: s.event,
        match: s.match,
      }));
    }

    const response = await fetch(
      `${baseUrl}/ironflow.v1.IronflowService/RegisterFunction`,
      {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      }
    );

    if (!response.ok) {
      // Read the body BEFORE throwIfAuthError: a Response body can only be
      // consumed once, and the auth throw would take the reason with it.
      const detail = await errorDetail(response);
      throwIfAuthError(response.status, `Failed to register function ${fnId}`);
      throw new IronflowError(
        `Failed to register function ${fnId}: ${detail}`,
        { code: "FUNCTION_REGISTRATION_FAILED" }
      );
    }

    opts.logger.info(`Registered function: ${fnId}`);
  }
}
