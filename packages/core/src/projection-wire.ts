import { peelProjectionEnvelope } from "./projection-types.js";
import type {
  ProjectionStateResult,
  ProjectionStatusInfo,
} from "./projection-types.js";

type Wire = Record<string, unknown>;

/** Decode protocol metadata without changing keys inside reducer state. */
export function projectionRegistryFromWire(p: Wire) {
  return {
    name: String(p.name ?? ""),
    environment_id: String(p.environmentId ?? ""),
    mode: String(p.mode ?? ""),
    status: String(p.status ?? ""),
    events: (p.events as string[] | undefined) ?? [],
    partition_key: String(p.partitionKey ?? ""),
    version: Number(p.versionFull ?? p.version ?? 0),
    last_event_seq: Number(p.lastEventSeq ?? 0),
    created_at: String(p.createdAt ?? ""),
    updated_at: String(p.updatedAt ?? ""),
    error_message: String(p.errorMessage ?? ""),
    type: String(p.type ?? ""),
    sql_definition: String(p.sqlDefinition ?? ""),
    event_handlers: p.eventHandlers,
    description: String(p.description ?? ""),
    ...(p.rebuildTargetSeq !== undefined
      ? { rebuild_target_seq: Number(p.rebuildTargetSeq) }
      : {}),
    ...(p.rebuildStartCursor !== undefined
      ? { rebuild_start_cursor: Number(p.rebuildStartCursor) }
      : {}),
    rebuild_started_at: String(p.rebuildStartedAt ?? ""),
  };
}

/** Preserve the inspection shape consumed by the dashboard and MCP-style views. */
export function projectionInspectionFromWire(p: Wire) {
  const registry = projectionRegistryFromWire(
    (p.registry as Wire | undefined) ?? {
      name: p.name,
      mode: p.mode,
      version: p.version,
    },
  );
  const hasState = Object.hasOwn(p, "stateValue") || Object.hasOwn(p, "state");
  return {
    ...registry,
    state: hasState
      ? {
          projection_name: String(p.name ?? ""),
          environment_id: String(p.stateEnvironmentId ?? ""),
          partition_key: String(p.partition ?? "__global__"),
          state: Object.hasOwn(p, "stateValue") ? p.stateValue : p.state,
          last_event_id: String(p.lastEventId ?? ""),
          last_event_seq: Number(p.stateLastEventSeq ?? 0),
          last_event_time: String(p.lastEventTime ?? ""),
          version: Number(p.version ?? 0),
          updated_at: String(p.stateUpdatedAt ?? ""),
        }
      : null,
  };
}

export function projectionStateFromWire<T = unknown>(
  p: Wire,
  partition?: string,
): ProjectionStateResult<T> {
  return peelProjectionEnvelope<T>(projectionInspectionFromWire(p), partition);
}

export function projectionStatusFromWire(p: Wire): ProjectionStatusInfo {
  return {
    name: String(p.name ?? ""),
    status: p.status as ProjectionStatusInfo["status"],
    mode: p.mode as ProjectionStatusInfo["mode"],
    lastEventSeq: Number(p.lastEventSeq ?? 0),
    lag: Number(p.lag ?? 0),
    errorMessage: p.errorMessage ? String(p.errorMessage) : undefined,
    updatedAt: p.updatedAt ? new Date(String(p.updatedAt ?? "")) : new Date(),
  };
}

export function rebuildJobFromWire(p: Wire): {
  name: string;
  status: string;
  progress: number;
  startedAt: string;
} {
  const job = (p.job as Wire | undefined) ?? {};
  return {
    name: String(job.projectionName ?? ""),
    status: String(job.status ?? ""),
    progress: Number(job.progress ?? 0),
    startedAt: String(job.startedAt ?? ""),
  };
}
