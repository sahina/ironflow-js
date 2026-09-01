import { describe, it, expect, vi } from "vitest";
import {
  AgentInvokeTimeoutError,
  RunCancelledError,
  RunFailedError,
  RunWaitTimeoutError,
  ValidationError,
  type InvokeSyncResult,
} from "@ironflow/core";

import { invoke } from "../invoke.js";
import type { AgentClientLike } from "../types.js";

// ---------------------------------------------------------------------------
// Mock client harness
// ---------------------------------------------------------------------------

const completedResult: InvokeSyncResult = {
  runId: "run-mock",
  functionId: "agent",
  status: "completed",
  output: { ok: true },
  durationMs: 12,
};

function buildMockClient(): {
  client: AgentClientLike;
  invokeSync: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  const invokeSync = vi.fn(async () => completedResult);
  const cancelRun = vi.fn(async (runId: string) => ({
    id: runId,
    functionId: "agent",
    status: "cancelled",
  }));
  // Present only to prove `invoke` never reaches for it any more.
  const subscribe = vi.fn();

  return {
    client: {
      invoke: invokeSync,
      subscribe,
      cancelRun,
    } as unknown as AgentClientLike,
    invokeSync,
    cancelRun,
    subscribe,
  };
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

  it("rejects when signal already aborted, before any network I/O", async () => {
    const { client, invokeSync } = buildMockClient();
    const ac = new AbortController();
    ac.abort();
    await expect(
      invoke(client, "agent", {}, { signal: ac.signal })
    ).rejects.toThrow("Aborted");
    expect(invokeSync).not.toHaveBeenCalled();
  });
});

describe("agents.invoke — the single sync call", () => {
  it("resolves with the run's output and never subscribes", async () => {
    const { client, invokeSync, subscribe } = buildMockClient();

    const result = await invoke<{ ok: true }>(client, "agent", { task: "x" });

    expect(result.runId).toBe("run-mock");
    expect(result.output).toEqual({ ok: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(invokeSync).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("sends the wait budget as `timeout`, not as a transport abort", async () => {
    const { client, invokeSync } = buildMockClient();

    await invoke(client, "agent", { x: 1 }, { timeoutMs: 45_000 });

    const [, opts] = invokeSync.mock.calls[0] as [
      string,
      { timeout?: number; signal?: AbortSignal },
    ];
    expect(opts.timeout).toBe(45_000);
    // The signal slot carries caller cancellation only — wiring the budget
    // there would cancel the run on every timeout.
    expect(opts.signal).toBeUndefined();
  });

  it("forwards idempotencyKey to client.invoke", async () => {
    const { client, invokeSync } = buildMockClient();

    await invoke(client, "agent", { x: 1 }, { idempotencyKey: "key-abc" });

    expect(invokeSync).toHaveBeenCalledWith("agent", {
      data: { x: 1 },
      timeout: 30_000,
      idempotencyKey: "key-abc",
      signal: undefined,
    });
  });

  it("propagates a network error", async () => {
    const { client, invokeSync } = buildMockClient();
    invokeSync.mockRejectedValueOnce(new Error("network down"));
    await expect(invoke(client, "agent", {})).rejects.toThrow("network down");
  });

  it("propagates RunFailedError from the client", async () => {
    const { client, invokeSync } = buildMockClient();
    invokeSync.mockRejectedValueOnce(
      new RunFailedError("run-mock", { partial: true }, "boom")
    );
    await expect(invoke(client, "agent", {})).rejects.toBeInstanceOf(
      RunFailedError
    );
  });

  it("propagates RunCancelledError from the client", async () => {
    const { client, invokeSync } = buildMockClient();
    invokeSync.mockRejectedValueOnce(new RunCancelledError("run-mock"));
    await expect(invoke(client, "agent", {})).rejects.toBeInstanceOf(
      RunCancelledError
    );
  });

  it("does not cancel the run on an ordinary failure", async () => {
    const { client, invokeSync, cancelRun } = buildMockClient();
    invokeSync.mockRejectedValueOnce(
      new RunFailedError("run-mock", null, "boom")
    );
    await expect(invoke(client, "agent", {})).rejects.toBeInstanceOf(
      RunFailedError
    );
    expect(cancelRun).not.toHaveBeenCalled();
  });
});

describe("agents.invoke — timeout + abort", () => {
  it("maps an expired wait budget to AgentInvokeTimeoutError and cancels the run", async () => {
    const { client, invokeSync, cancelRun } = buildMockClient();
    // An expired `timeout_ms` deliberately leaves the run ALIVE server-side,
    // so the client-side cancel is the only thing stopping a zombie agent.
    invokeSync.mockRejectedValueOnce(
      new RunWaitTimeoutError("run-mock", "agent", "running", 20)
    );

    const err = await invoke(client, "agent", {}, { timeoutMs: 20 }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AgentInvokeTimeoutError);
    expect((err as AgentInvokeTimeoutError).runId).toBe("run-mock");
    expect(cancelRun).toHaveBeenCalledWith(
      "run-mock",
      expect.stringContaining("timed out")
    );
  });

  it("survives a cancelRun that rejects on the timeout path", async () => {
    const { client, invokeSync, cancelRun } = buildMockClient();
    invokeSync.mockRejectedValueOnce(
      new RunWaitTimeoutError("run-mock", "agent", "running", 20)
    );
    cancelRun.mockRejectedValueOnce(new Error("cancel failed"));

    await expect(
      invoke(client, "agent", {}, { timeoutMs: 20 })
    ).rejects.toBeInstanceOf(AgentInvokeTimeoutError);
  });

  it("passes the caller's signal down to the transport", async () => {
    const { client, invokeSync } = buildMockClient();
    const ac = new AbortController();

    await invoke(client, "agent", {}, { signal: ac.signal });

    const [, opts] = invokeSync.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(opts.signal).toBe(ac.signal);
  });

  it("aborts mid-wait WITHOUT a client-side cancelRun — the server cancels", async () => {
    const { client, invokeSync, cancelRun } = buildMockClient();
    const ac = new AbortController();
    // Stand in for the real client: the request stays open until the signal
    // fires, then rejects with AbortError exactly as `send()` does.
    invokeSync.mockImplementationOnce(
      async (_name: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );

    const promise = invoke(client, "agent", {}, { signal: ac.signal });
    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toThrow("Aborted");
    // Q19: killing the request cancels the run server-side, so a client-side
    // cancel would be a redundant second write.
    expect(cancelRun).not.toHaveBeenCalled();
  });
});

describe("agents.invoke — onRunStarted", () => {
  it("invokes onRunStarted with the runId", async () => {
    const { client } = buildMockClient();
    const seen: string[] = [];

    await invoke(
      client,
      "agent",
      {},
      {
        onRunStarted: (rid) => {
          seen.push(rid);
        },
      }
    );

    expect(seen).toEqual(["run-mock"]);
  });

  it("swallows errors thrown by onRunStarted", async () => {
    const { client } = buildMockClient();

    const result = await invoke(
      client,
      "agent",
      {},
      {
        onRunStarted: () => {
          throw new Error("caller bug");
        },
      }
    );

    expect(result.output).toEqual({ ok: true });
  });

  it("does not fire onRunStarted when the run failed", async () => {
    const { client, invokeSync } = buildMockClient();
    invokeSync.mockRejectedValueOnce(
      new RunFailedError("run-mock", null, "boom")
    );
    const seen: string[] = [];

    await expect(
      invoke(client, "agent", {}, { onRunStarted: (rid) => void seen.push(rid) })
    ).rejects.toBeInstanceOf(RunFailedError);
    expect(seen).toEqual([]);
  });
});
