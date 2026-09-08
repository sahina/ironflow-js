/** Public inspection fields decoded from Connect JSON. Application payload keys stay intact. */
function enumName(
  value: unknown,
  prefix: string,
  names: readonly string[],
): string {
  return typeof value === "number"
    ? (names[value] ?? "unspecified")
    : String(value ?? "")
        .replace(prefix, "")
        .toLowerCase();
}
const statuses = [
  "unspecified",
  "unspecified",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "waiting_for_capacity",
  "waiting",
];
export function runInspectionFromWire(r: Record<string, unknown>) {
  return {
    id: r.id ?? "",
    function_id: r.functionId ?? "",
    event_id: r.eventId ?? "",
    event_name: r.eventName,
    execution_mode: enumName(r.executionMode, "EXECUTION_MODE_", [
      "unspecified",
      "push",
      "pull",
    ]),
    worker_id: r.workerId,
    actor_id: r.actorId,
    status: enumName(r.status, "RUN_STATUS_", statuses),
    input: r.inputValue !== undefined ? r.inputValue : r.input,
    output: r.outputValue !== undefined ? r.outputValue : r.output,
    error: r.errorValue !== undefined ? r.errorValue : r.error,
    attempt: r.attempt ?? 0,
    max_attempts: r.maxAttempts ?? 0,
    resume_from_step: r.resumeFromStep,
    parent_run_id: r.parentRunId,
    parent_step_id: r.parentStepId,
    function_version: r.functionVersion,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    timeout_at: r.timeoutAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pause_requested: r.pauseRequested ?? false,
    pause_reason: r.pauseReason,
    cancellation_cause: r.cancellationCause,
  };
}
export function stepInspectionFromWire(r: Record<string, unknown>) {
  return {
    id: r.id ?? "",
    run_id: r.runId ?? "",
    step_id: r.stepId ?? "",
    step_type: enumName(r.stepType, "STEP_TYPE_", [
      "unspecified",
      "invoke",
      "sleep",
      "wait_for_event",
      "compensate",
      "invoke_function",
    ]),
    sequence: r.sequence ?? 0,
    status:
      r.storedStatus ??
      enumName(r.status, "STEP_STATUS_", [
        "unspecified",
        "pending",
        "running",
        "completed",
        "failed",
        "sleeping",
        "waiting",
        "timed_out",
        "retrying",
        "dead",
      ]),
    input: r.inputValue !== undefined ? r.inputValue : r.input,
    output: r.outputValue !== undefined ? r.outputValue : r.output,
    original_output:
      r.originalOutputValue !== undefined
        ? r.originalOutputValue
        : r.originalOutput,
    error: r.errorValue !== undefined ? r.errorValue : r.error,
    input_hash: r.inputHash,
    attempt: r.attempt ?? 0,
    duration_ms:
      r.durationMsFull !== undefined ? Number(r.durationMsFull) : r.durationMs,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    sleep_until: r.sleepUntil,
    wait_event_name: r.waitEventName,
    wait_timeout: r.waitTimeout,
    patched_at: r.patchedAt,
    patched_by: r.patchedBy,
    compensation_for: r.compensationFor,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
