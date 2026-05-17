import { describe, it, expect, vi } from "vitest";
import { ValidationError, type SubscriptionEvent } from "@ironflow/core";

import { subscribe } from "../subscribe.js";
import type { AgentClientLike, AgentSubscribeCallbacks } from "../types.js";

function buildClient() {
  let onEvent:
    | ((evt: SubscriptionEvent<unknown>) => void)
    | undefined;
  let onError: ((e: { code: string; message: string }) => void) | undefined;
  const unsubscribe = vi.fn();

  const client: AgentClientLike = {
    invoke: vi.fn(),
    subscribe: vi.fn(async (_pattern, cbs) => {
      onEvent = cbs.onEvent as never;
      onError = cbs.onError as never;
      return { unsubscribe };
    }) as unknown as AgentClientLike["subscribe"],
    cancelRun: vi.fn(),
    getProjection: vi.fn() as unknown as AgentClientLike["getProjection"],
    waitForProjectionCatchup: vi.fn() as unknown as AgentClientLike["waitForProjectionCatchup"],
  };

  return {
    client,
    unsubscribe,
    emit: (event: Partial<SubscriptionEvent<unknown>>) =>
      onEvent?.({
        topic: event.topic ?? "",
        data: event.data ?? null,
      } as SubscriptionEvent<unknown>),
    raiseError: (msg: string) =>
      onError?.({ code: "ERR", message: msg }),
  };
}

describe("agents.subscribe — validation", () => {
  it("rejects empty runId", async () => {
    const { client } = buildClient();
    await expect(subscribe(client, "", {})).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("rejects oversized runId", async () => {
    const { client } = buildClient();
    await expect(
      subscribe(client, "a".repeat(129), {})
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ["wildcard *", "*"],
    ["wildcard >", ">"],
    ["dotted", "a.b.c"],
    ["space", "run id"],
    ["question mark", "run?"],
    ["semicolon injection", "run;DROP"],
  ])("rejects NATS metacharacter: %s", async (_label, runId) => {
    const { client } = buildClient();
    await expect(subscribe(client, runId, {})).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it.each([
    ["alphanumeric", "run123abc"],
    ["with underscore", "run_2025_abc"],
    ["with hyphen", "run-2025-abc"],
  ])("accepts safe runId: %s", async (_label, runId) => {
    const { client } = buildClient();
    await expect(subscribe(client, runId, {})).resolves.toBeTruthy();
  });
});

describe("agents.subscribe — event dispatch", () => {
  it("dispatches step events to onStep with parsed stepId+type", async () => {
    const { client, emit } = buildClient();
    const onStep = vi.fn();
    const cbs: AgentSubscribeCallbacks = { onStep };
    await subscribe(client, "run-1", cbs);
    emit({
      topic: "system.run.run-1.step.s42.completed",
      data: { type: "completed" },
    });
    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "system.run.run-1.step.s42.completed",
        stepId: "s42",
        type: "completed",
      })
    );
  });

  it("dispatches .completed to onComplete with output", async () => {
    const { client, emit } = buildClient();
    const onComplete = vi.fn();
    await subscribe(client, "run-1", { onComplete });
    emit({
      topic: "system.run.run-1.completed",
      data: { output: { ok: true } },
    });
    expect(onComplete).toHaveBeenCalledWith({ output: { ok: true } });
  });

  it("dispatches .failed with error.message + code", async () => {
    const { client, emit } = buildClient();
    const onFailed = vi.fn();
    await subscribe(client, "run-1", { onFailed });
    emit({
      topic: "system.run.run-1.failed",
      data: { error: { message: "boom", code: "X1" } },
    });
    expect(onFailed).toHaveBeenCalledWith({ message: "boom", code: "X1" });
  });

  it("dispatches .cancelled to onCancelled", async () => {
    const { client, emit } = buildClient();
    const onCancelled = vi.fn();
    await subscribe(client, "run-1", { onCancelled });
    emit({ topic: "system.run.run-1.cancelled", data: {} });
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("dispatches non-terminal run events to onProgress", async () => {
    const { client, emit } = buildClient();
    const onProgress = vi.fn();
    await subscribe(client, "run-1", { onProgress });
    emit({
      topic: "system.run.run-1.updated",
      data: { status: "running" },
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "system.run.run-1.updated",
        status: "running",
      })
    );
  });

  it("forwards transport errors to onError", async () => {
    const { client, raiseError } = buildClient();
    const onError = vi.fn();
    await subscribe(client, "run-1", { onError });
    raiseError("transport down");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transport down" })
    );
  });
});

describe("agents.subscribe — unsubscribe idempotency", () => {
  it("calls underlying unsubscribe at most once", async () => {
    const { client, unsubscribe } = buildClient();
    const sub = await subscribe(client, "run-1", {});
    sub.unsubscribe();
    sub.unsubscribe();
    sub.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
