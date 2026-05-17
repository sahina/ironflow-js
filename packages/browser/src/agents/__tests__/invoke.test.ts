import { describe, it, expect, vi } from "vitest";
import { assertDefined } from "../../internal/assert-defined.js";
import {
  AgentInvokeTimeoutError,
  NoRunCreatedError,
  RunFailedError,
  RunCancelledError,
  ValidationError,
  type SubscriptionCallbacks,
  type SubscriptionEvent,
} from "@ironflow/core";

import { invoke } from "../invoke.js";
import type { AgentClientLike } from "../types.js";

// ---------------------------------------------------------------------------
// Mock client harness
// ---------------------------------------------------------------------------

interface MockSubscription {
  pattern: string;
  unsubscribe: () => void;
  emit: (event: Partial<SubscriptionEvent<unknown>>) => void;
  emitError: (msg: string) => void;
}

function buildMockClient(): {
  client: AgentClientLike;
  trigger: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  /** Manually drive subscription event delivery from tests. */
  subs: MockSubscription[];
} {
  const subs: MockSubscription[] = [];

  const subscribe = vi.fn(
    async (
      pattern: string | string[],
      cbs: SubscriptionCallbacks<unknown>
    ) => {
      const unsub = vi.fn();
      const sub: MockSubscription = {
        pattern: Array.isArray(pattern) ? (pattern[0] ?? "") : pattern,
        unsubscribe: unsub,
        emit: (partial) => {
          const evt: SubscriptionEvent<unknown> = {
            topic: partial.topic ?? "",
            data: partial.data ?? null,
            meta: partial.meta,
            eventId: partial.eventId,
          };
          cbs.onEvent?.(evt);
        },
        emitError: (msg) =>
          cbs.onError?.({ code: "TEST_ERR", message: msg }),
      };
      subs.push(sub);
      return { unsubscribe: unsub };
    }
  );

  const trigger = vi.fn(async (_name: string, _opts) => ({
    runIds: ["run-mock"],
    eventId: "evt-mock",
  }));

  const cancelRun = vi.fn(async (runId: string) => ({
    id: runId,
    functionId: "fn",
    status: "cancelled",
  }));

  return {
    client: {
      invoke: trigger,
      subscribe,
      cancelRun,
    } as unknown as AgentClientLike,
    trigger,
    subscribe,
    cancelRun,
    subs,
  };
}

// Drain the microtask queue so subscribe()'s await chain settles.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agents.invoke — input validation", () => {
  it("rejects empty name", async () => {
    const { client } = buildMockClient();
    await expect(invoke(client, "", { x: 1 })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("rejects oversized name", async () => {
    const { client } = buildMockClient();
    const big = "a".repeat(257);
    await expect(invoke(client, big, {})).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("rejects when signal already aborted", async () => {
    const { client } = buildMockClient();
    const ac = new AbortController();
    ac.abort();
    await expect(
      invoke(client, "agent", {}, { signal: ac.signal })
    ).rejects.toThrow("Aborted");
  });
});

describe("agents.invoke — POST errors", () => {
  it("propagates network error from trigger", async () => {
    const { client, trigger } = buildMockClient();
    trigger.mockRejectedValueOnce(new Error("network down"));
    await expect(invoke(client, "agent", {})).rejects.toThrow("network down");
  });

  it("throws NoRunCreatedError when runIds is empty", async () => {
    const { client, trigger } = buildMockClient();
    trigger.mockResolvedValueOnce({ runIds: [], eventId: "evt-1" });
    await expect(invoke(client, "agent", {})).rejects.toBeInstanceOf(
      NoRunCreatedError
    );
  });

  it.each([
    ["wildcard *", "*"],
    ["wildcard >", ">"],
    ["dotted", "run.evil"],
    ["space", "bad id"],
  ])(
    "rejects malformed server-returned runId: %s",
    async (_label, badId) => {
      const { client, trigger } = buildMockClient();
      trigger.mockResolvedValueOnce({ runIds: [badId], eventId: "e" });
      await expect(invoke(client, "agent", {})).rejects.toThrow(
        /invalid runId/
      );
    }
  );
});

describe("agents.invoke — terminal events", () => {
  it("resolves on .completed with output", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke<{ ok: true }>(client, "agent", { task: "x" });
    await flush();
    expect(subs.length).toBe(1);
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { status: "completed", output: { ok: true } },
    });
    const result = await promise;
    expect(result.runId).toBe("run-mock");
    expect(result.output).toEqual({ ok: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws RunFailedError on .failed", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.failed",
      data: { status: "failed", error: { message: "boom", code: "X" } },
    });
    await expect(promise).rejects.toBeInstanceOf(RunFailedError);
  });

  it("throws RunCancelledError on .cancelled", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.cancelled",
      data: { status: "cancelled" },
    });
    await expect(promise).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("ignores step events and non-terminal run events", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.created",
      data: { status: "running" },
    });
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.step.s1.completed",
      data: { type: "completed" },
    });
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: { done: true } },
    });
    const result = await promise;
    expect(result.output).toEqual({ done: true });
  });

  it("resolves once even if duplicate completion events arrive", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: 1 },
    });
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: 2 },
    });
    const result = await promise;
    expect(result.output).toBe(1);
  });
});

describe("agents.invoke — timeout + abort", () => {
  it("throws AgentInvokeTimeoutError and calls cancelRun", async () => {
    const { client, cancelRun } = buildMockClient();
    // Real timer with a small budget. Test never emits a terminal event,
    // so the only way out is the timeout firing.
    await expect(
      invoke(client, "agent", {}, { timeoutMs: 20 })
    ).rejects.toBeInstanceOf(AgentInvokeTimeoutError);
    expect(cancelRun).toHaveBeenCalledWith(
      "run-mock",
      expect.stringContaining("aborted")
    );
  });

  it("aborts mid-wait and calls cancelRun", async () => {
    const { client, cancelRun } = buildMockClient();
    const ac = new AbortController();
    const promise = invoke(client, "agent", {}, { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(promise).rejects.toThrow("Aborted");
    expect(cancelRun).toHaveBeenCalled();
  });
});

describe("agents.invoke — idempotencyKey + cleanup", () => {
  it("invokes onRunStarted with runId before terminal event", async () => {
    const { client, subs } = buildMockClient();
    const seen: string[] = [];
    const promise = invoke(
      client,
      "agent",
      {},
      { onRunStarted: (rid) => { seen.push(rid); } }
    );
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: null },
    });
    await promise;
    expect(seen).toEqual(["run-mock"]);
  });

  it("swallows errors thrown by onRunStarted", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(
      client,
      "agent",
      {},
      {
        onRunStarted: () => {
          throw new Error("caller bug");
        },
      }
    );
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: 1 },
    });
    const result = await promise;
    expect(result.output).toBe(1);
  });

  it("forwards idempotencyKey to client.invoke", async () => {
    const { client, trigger, subs } = buildMockClient();
    const promise = invoke(
      client,
      "agent",
      { x: 1 },
      { idempotencyKey: "key-abc" }
    );
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: null },
    });
    await promise;
    expect(trigger).toHaveBeenCalledWith("agent", {
      data: { x: 1 },
      idempotencyKey: "key-abc",
    });
  });

  it("unsubscribes on success", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.completed",
      data: { output: null },
    });
    await promise;
    expect(assertDefined(subs[0]).unsubscribe).toHaveBeenCalled();
  });

  it("unsubscribes on failure path too", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emit({
      topic: "system.run.run-mock.failed",
      data: { error: "x" },
    });
    await expect(promise).rejects.toBeTruthy();
    expect(assertDefined(subs[0]).unsubscribe).toHaveBeenCalled();
  });

  it("propagates subscription transport errors", async () => {
    const { client, subs } = buildMockClient();
    const promise = invoke(client, "agent", {});
    await flush();
    assertDefined(subs[0]).emitError("transport blew up");
    await expect(promise).rejects.toThrow("transport blew up");
  });
});
