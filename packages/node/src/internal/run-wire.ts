/**
 * Decoding for the protobuf-JSON run shape returned by IronflowService.
 *
 * The service runs on Connect's default codec: lowerCamel field names,
 * canonical `RUN_STATUS_*` enum names, and `EmitUnpopulated:false` — so a
 * zero-valued field is OMITTED entirely rather than sent as a zero.
 *
 * Before #1919 this client returned `response.json() as Run`, which handed
 * callers `status: "RUN_STATUS_COMPLETED"` while the `RunStatus` type promised
 * "completed". Every optional field here is optional because the server really
 * does omit it.
 */

import { runStatusFromWire, type RunStatus } from "@ironflow/core";

/** The wire shape: what protojson actually sends. */
export interface RunWireResponse {
  id?: string;
  functionId?: string;
  eventId?: string;
  status?: string;
  attempt?: number;
  maxAttempts?: number;
  input?: unknown;
  output?: unknown;
  error?: { message?: string; code?: string };
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The decoded shape, matching the public `Run` interface in client.ts. */
export interface DecodedRun {
  id: string;
  functionId: string;
  eventId: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code: string };
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function mapRunResponse(response: RunWireResponse): DecodedRun {
  return {
    id: response.id ?? "",
    functionId: response.functionId ?? "",
    eventId: response.eventId ?? "",
    // Throws on an unknown or absent status rather than presenting the caller
    // a different one. An absent key IS RUN_STATUS_UNSPECIFIED on this codec.
    status: runStatusFromWire(response.status),
    attempt: response.attempt ?? 0,
    maxAttempts: response.maxAttempts ?? 0,
    input: response.input,
    output: response.output,
    error: response.error
      ? {
          message: response.error.message ?? "",
          code: response.error.code ?? "",
        }
      : undefined,
    startedAt: response.startedAt,
    endedAt: response.endedAt,
    createdAt: response.createdAt ?? "",
    updatedAt: response.updatedAt ?? "",
  };
}
