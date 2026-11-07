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

import {
  optionalTimestampFromWire,
  runStatusFromWire,
  timestampFromWire,
  type CancellationEvent,
  type Run,
} from "@ironflow/core";

/** The wire shape: what protojson actually sends. */
export interface RunWireResponse {
  cancellationCause?: string;
  cancellationEvent?: CancellationEvent;
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

export function mapRunResponse(response: RunWireResponse): Run {
  return {
    id: response.id ?? "",
    cancellationCause: response.cancellationCause,
    cancellationEvent: response.cancellationEvent
      ? {
          ...response.cancellationEvent,
          matchValue: response.cancellationEvent.matchValue ?? "",
        }
      : undefined,
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
    startedAt: optionalTimestampFromWire("run.startedAt", response.startedAt),
    endedAt: optionalTimestampFromWire("run.endedAt", response.endedAt),
    createdAt: timestampFromWire("run.createdAt", response.createdAt),
    updatedAt: timestampFromWire("run.updatedAt", response.updatedAt),
  };
}
