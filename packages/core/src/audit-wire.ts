import { timestampFromWire } from "./timestamp-wire.js";
import type { AuditEvent } from "./types.js";

/** Decode one audit event. Connect sends camelCase and `GET /api/v1/audit` snake_case. */
export function auditEventFromWire(raw: Record<string, unknown>): AuditEvent {
  return {
    id: String(raw.id ?? ""),
    runId: String(raw.run_id ?? raw.runId ?? ""),
    functionId: String(raw.function_id ?? raw.functionId ?? ""),
    stepId: (raw.step_id ?? raw.stepId) as string | undefined,
    eventType: String(raw.event_type ?? raw.eventType ?? ""),
    payload: (raw.payload as Record<string, unknown>) ?? {},
    metadata: raw.metadata as Record<string, string> | undefined,
    createdAt: timestampFromWire("auditEvent.createdAt", raw.created_at ?? raw.createdAt),
  };
}
