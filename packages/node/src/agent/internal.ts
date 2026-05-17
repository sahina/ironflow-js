/**
 * Internal utilities shared by agent module wrappers.
 *
 * Not part of the public API surface — `index.ts` does not re-export.
 */

import type { Duration } from "@ironflow/core";

/**
 * Normalize a Duration (string | number) into the ms-suffixed string form
 * that step.run options.timeout expects.
 *
 *   normalizeDuration("30s")  → "30s"
 *   normalizeDuration(5000)   → "5000ms"
 *   normalizeDuration(undefined) → undefined
 */
export function normalizeDuration(value: Duration | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}ms` : value;
}

/**
 * Escape a value for safe interpolation into a CEL-style match expression
 * (`data.field == "<value>"`). Replaces `\` and `"` with escaped forms.
 *
 * Internal IDs are unlikely to contain quotes, but defending against it
 * prevents broken filters if upstream ever loosens the format.
 */
export function escapeMatchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
