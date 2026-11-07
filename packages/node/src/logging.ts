import type { Logger } from "@ironflow/core";
import { currentLogTrace } from "./internal/tracing.js";

/** Values supported by the optional OTel Logs API. */
export type OTelLogValue = string | number | boolean | Uint8Array | null | undefined | OTelLogValue[] | { [key: string]: OTelLogValue };

/** Structural execution context, without a required OpenTelemetry type import. */
export interface OTelLogContext {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OTelLogContext;
  deleteValue(key: symbol): OTelLogContext;
}

/** Structural subset of an application-owned OTel Logs logger. */
export interface OTelLogSink {
  emit(record: {
    body: string;
    severityNumber: 5 | 9 | 13 | 17;
    severityText: string;
    timestamp: number;
    attributes: { [key: string]: OTelLogValue };
    context?: OTelLogContext;
  }): void;
}

function logValue(value: unknown): OTelLogValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Uint8Array) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(logValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, logValue(entry)]));
  return String(value);
}

/** Replace the user log sink with one app-owned OTel route, without a console tee. */
export function createOTelLogger(sink: OTelLogSink): Logger {
  const emit = (severityNumber: 5 | 9 | 13 | 17, severityText: string, body: string, data?: Record<string, unknown>) => {
    sink.emit({
      body, severityNumber, severityText, timestamp: Date.now(),
      attributes: Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [key, logValue(value)])),
      context: currentLogTrace().context,
    });
  };
  return {
    debug: (message, data) => emit(5, "DEBUG", message, data),
    info: (message, data) => emit(9, "INFO", message, data),
    warn: (message, data) => emit(13, "WARN", message, data),
    error: (message, data) => emit(17, "ERROR", message, data),
  };
}
