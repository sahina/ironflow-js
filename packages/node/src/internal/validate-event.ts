import {
  EventSource,
  SchemaValidationError,
  formatZodIssues,
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
 */
export async function validateEventData(
  fn: IronflowFunction,
  event: IronflowEvent
): Promise<IronflowEvent> {
  const schema = fn.config.schema;
  if (!schema || event.source === EventSource.CRON) return event;
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
