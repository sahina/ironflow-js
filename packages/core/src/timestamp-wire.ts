/**
 * Decoding for timestamps the server sends as RFC 3339 strings.
 *
 * An unreadable value throws: an Invalid Date reaches the caller silently and
 * only misbehaves where it is used.
 *
 * A `Date` holds milliseconds and the server stores finer. Do not send a decoded
 * value back where the server compares it for equality.
 */

import { SchemaValidationError } from "./errors.js";

/** Decode a timestamp the server always sends. `field` names it in the error. */
export function timestampFromWire(field: string, value: unknown): Date {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchemaValidationError(
      `Invalid ${field} from server: ${String(value)}`,
      { validationErrors: [`${field} must be an RFC 3339 timestamp`] },
    );
  }
  return parsed;
}

/**
 * Decode a timestamp the server may leave out. protojson omits an unset field,
 * and the REST routes send null or an empty string for one.
 */
export function optionalTimestampFromWire(field: string, value: unknown): Date | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : timestampFromWire(field, value);
}

/** Encode a timestamp filter. A string goes unchanged, so it keeps full precision. */
export function timestampFilterToWire(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
