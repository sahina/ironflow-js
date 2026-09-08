import type { EventSchema } from "./types.js";

export interface SchemaWire {
  eventName?: string;
  version?: number;
  schemaJson?: string;
  description?: string;
  environmentId?: string;
  createdAt?: string;
}

/** Retain the SDK's snake_case schema fields when reading protobuf JSON. */
export function schemaFromWire(wire: SchemaWire): EventSchema {
  let schema: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(wire.schemaJson || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      schema = parsed as Record<string, unknown>;
    }
  } catch {
    // Old registries may contain documents written before validation existed.
  }
  const result = {
    event_name: wire.eventName ?? "",
    version: wire.version ?? 0,
    schema,
    schema_json: wire.schemaJson ?? "",
    environment_id: wire.environmentId ?? "",
    ...(wire.description ? { description: wire.description } : {}),
    created_at: wire.createdAt ?? "",
  };
  return result;
}
