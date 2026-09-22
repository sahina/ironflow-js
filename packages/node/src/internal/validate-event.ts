import {
  EventSource,
  SchemaValidationError,
  formatZodIssues,
  isRedacted,
  type IronflowEvent,
  type IronflowFunction,
} from "@ironflow/core";

/** Zod does not abort early; a bad array can yield thousands of issues. Keep the persisted run error bounded. */
const MAX_ISSUES = 10;

/**
 * Enforce `config.schema` on the incoming event (#1948). Shared by every
 * execution path: serve (push), createWorker and createStreamingWorker (pull),
 * and the `@ironflow/node/test` harness.
 *
 * No schema declared → the event passes through untouched. A declared schema
 * returns the event with `data` replaced by the parsed Zod output (defaults and
 * transforms applied), or throws `SchemaValidationError` — non-retryable, so the
 * run fails once without burning retries on a payload that can never match.
 * Async refinements are supported; that is why this is async rather than a call
 * to core's sync `validate()`.
 *
 * Cron ticks are exempt: the engine fabricates their payload
 * (`{type:"cron", expression, scheduled}`), so a schema describing the emitted
 * event can never match it and a mixed-trigger function would fail every tick.
 *
 * A redacted payload is NOT exempt. Unlike a cron tick, the function cannot do
 * its job — the bytes its schema describes are gone. It fails here, once,
 * non-retryably, and says so in as many words: reporting the placeholder as a
 * field-by-field Zod diff ("amount: expected number, received undefined")
 * would send whoever reads the run looking for a producer bug. A function with
 * no declared schema still receives the placeholder, as the redaction contract
 * promises; guard it with `isRedacted`.
 */
export async function validateEventData(
  fn: IronflowFunction,
  event: IronflowEvent
): Promise<IronflowEvent> {
  const schema = fn.config.schema;
  if (!schema || event.source === EventSource.CRON) return event;
  if (isRedacted(event.data)) {
    throw new SchemaValidationError(
      `Event "${event.name}" for function "${fn.config.id}" was redacted: its payload has been ` +
        `irreversibly replaced with a placeholder and cannot satisfy the declared schema. ` +
        `Drop config.schema and guard with isRedacted() if this function must still run.`,
      { validationErrors: ["event data was redacted"] }
    );
  }
  const result = await schema.safeParseAsync(event.data);
  if (result.success) return { ...event, data: result.data };

  const issues = formatZodIssues(result.error.issues);
  const shown = issues.slice(0, MAX_ISSUES);
  if (issues.length > MAX_ISSUES) shown.push(`…and ${issues.length - MAX_ISSUES} more`);
  throw new SchemaValidationError(
    `Validation failed in event "${event.name}" for function "${fn.config.id}": ${shown.join(", ")}`,
    { validationErrors: shown }
  );
}
