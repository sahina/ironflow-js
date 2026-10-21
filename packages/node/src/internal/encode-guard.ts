import { NonRetryableError, type StepResult } from "@ironflow/core";

/**
 * Code for a run whose result or step output JSON cannot encode (a BigInt, a
 * circular object). Retrying runs the same code and fails the same way, so the
 * failure is not retryable.
 */
export const SERIALIZATION_ERROR = "SERIALIZATION_ERROR";

function encodeError(value: unknown): string | undefined {
  try {
    JSON.stringify(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The longest prefix of steps that JSON can encode. The prefix keeps completed
 * side effects from running again (#2874).
 */
export function encodableSteps(steps: StepResult[]): StepResult[] {
  const bad = steps.findIndex((s) => encodeError(s) !== undefined);
  return bad < 0 ? steps : steps.slice(0, bad);
}

/**
 * Steps without the ones JSON cannot encode. A failure report keeps every
 * other step, including the compensations that ran after the bad one (#2874).
 */
export function dropUnencodable(steps: StepResult[]): StepResult[] {
  return steps.filter((s) => encodeError(s) === undefined);
}

/**
 * The failure for a result and steps that JSON cannot encode, or undefined
 * when everything encodes.
 */
export function serializationError(result: unknown, steps: StepResult[]): NonRetryableError | undefined {
  for (const step of steps) {
    const reason = encodeError(step);
    if (reason !== undefined) {
      return new NonRetryableError(`step "${step.name}" output is not JSON-encodable: ${reason}`, {
        code: SERIALIZATION_ERROR,
      });
    }
  }
  const reason = encodeError(result);
  if (reason !== undefined) {
    return new NonRetryableError(`function result is not JSON-encodable: ${reason}`, { code: SERIALIZATION_ERROR });
  }
  return undefined;
}

/**
 * JSON for a response body, encoded before any header is written. A body that
 * cannot encode becomes a 500 with an encodable error.
 */
export function encodeResponse(status: number, body: unknown): { status: number; text: string } {
  try {
    return { status, text: JSON.stringify(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 500,
      text: JSON.stringify({ error: { message: `response is not JSON-encodable: ${message}`, code: "internal" } }),
    };
  }
}
