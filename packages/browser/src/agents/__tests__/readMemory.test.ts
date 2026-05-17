import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "@ironflow/core";

import { readMemory } from "../readMemory.js";
import type { AgentClientLike } from "../types.js";

// ---------------------------------------------------------------------------
// Mock client harness
// ---------------------------------------------------------------------------

interface BuildOpts {
  state?: unknown;
  version?: number;
  lastEventId?: string;
  catchupResult?: { caughtUp: boolean; timedOut: boolean };
  /** Hold getProjection until this promise resolves (for abort tests). */
  holdGetProjection?: Promise<void>;
  /** Hold waitForProjectionCatchup until this promise resolves. */
  holdCatchup?: Promise<void>;
}

function buildMockClient(o: BuildOpts = {}): {
  client: AgentClientLike;
  getProjection: ReturnType<typeof vi.fn>;
  waitForProjectionCatchup: ReturnType<typeof vi.fn>;
  callOrder: string[];
} {
  const callOrder: string[] = [];

  const getProjection = vi.fn(async (name: string, opts?: { partition?: string }) => {
    callOrder.push("getProjection");
    if (o.holdGetProjection) await o.holdGetProjection;
    return {
      name,
      partition: opts?.partition ?? "__global__",
      state: o.state ?? { docs: 1 },
      lastEventId: o.lastEventId ?? "evt-1",
      lastEventTime: new Date(0),
      version: o.version ?? 7,
      mode: "managed",
    };
  });

  const waitForProjectionCatchup = vi.fn(
    async (
      _name: string,
      opts: { minSeq: number | bigint; timeoutMs?: number; partition?: string }
    ) => {
      callOrder.push("waitForProjectionCatchup");
      if (o.holdCatchup) await o.holdCatchup;
      return {
        caughtUp: o.catchupResult?.caughtUp ?? true,
        timedOut: o.catchupResult?.timedOut ?? false,
        currentSeq: Number(opts.minSeq),
        targetSeq: Number(opts.minSeq),
        behindByEvents: 0,
      };
    }
  );

  const client = {
    invoke: vi.fn(),
    subscribe: vi.fn(),
    cancelRun: vi.fn(),
    getProjection,
    waitForProjectionCatchup,
  } as unknown as AgentClientLike;

  return { client, getProjection, waitForProjectionCatchup, callOrder };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agents.readMemory — input validation", () => {
  it("rejects empty projection name", async () => {
    const { client } = buildMockClient();
    await expect(readMemory(client, "")).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects projection name over 256 chars", async () => {
    const { client } = buildMockClient();
    await expect(readMemory(client, "x".repeat(257))).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe("agents.readMemory — happy path", () => {
  it("returns projection state without minSeq", async () => {
    const { client, getProjection, waitForProjectionCatchup } = buildMockClient({
      state: { docs: { a: { status: "ocr" } } },
      version: 12,
      lastEventId: "evt-42",
    });

    const result = await readMemory<{ docs: Record<string, { status: string }> }>(
      client,
      "doc-processor-memory"
    );

    expect(result.state).toEqual({ docs: { a: { status: "ocr" } } });
    expect(result.version).toBe(12);
    expect(result.lastEventId).toBe("evt-42");
    expect(result.caughtUp).toBe(true);
    expect(waitForProjectionCatchup).not.toHaveBeenCalled();
    expect(getProjection).toHaveBeenCalledWith("doc-processor-memory", {
      partition: undefined,
    });
  });

  it("skips catchup when minSeq is 0", async () => {
    const { client, waitForProjectionCatchup, getProjection } = buildMockClient();
    await readMemory(client, "p", { minSeq: 0 });
    expect(waitForProjectionCatchup).not.toHaveBeenCalled();
    expect(getProjection).toHaveBeenCalled();
  });

  it("skips catchup when minSeq is 0n (bigint)", async () => {
    const { client, waitForProjectionCatchup, getProjection } = buildMockClient();
    await readMemory(client, "p", { minSeq: 0n });
    expect(waitForProjectionCatchup).not.toHaveBeenCalled();
    expect(getProjection).toHaveBeenCalled();
  });

  it("calls catchup before getProjection when minSeq is set", async () => {
    const { client, callOrder, waitForProjectionCatchup, getProjection } =
      buildMockClient();

    await readMemory(client, "p", { minSeq: 99, timeoutMs: 5000 });

    expect(callOrder).toEqual(["waitForProjectionCatchup", "getProjection"]);
    expect(waitForProjectionCatchup).toHaveBeenCalledWith("p", {
      minSeq: 99,
      timeoutMs: 5000,
      partition: undefined,
    });
    expect(getProjection).toHaveBeenCalled();
  });

  it("passes partition to both catchup and getProjection", async () => {
    const { client, waitForProjectionCatchup, getProjection } = buildMockClient();

    await readMemory(client, "p", { minSeq: 1, partition: "tenant-a" });

    expect(waitForProjectionCatchup).toHaveBeenCalledWith("p", {
      minSeq: 1,
      timeoutMs: 30_000,
      partition: "tenant-a",
    });
    expect(getProjection).toHaveBeenCalledWith("p", { partition: "tenant-a" });
  });

  it("preserves typed state generic", async () => {
    interface DocMem {
      docs: Record<string, { status: "ocr" | "classified" }>;
    }
    const { client } = buildMockClient({
      state: { docs: { d1: { status: "classified" } } },
    });

    const result = await readMemory<DocMem>(client, "doc-mem");

    // Type assertion at compile time; runtime check that key exists.
    expect(result.state.docs.d1!.status).toBe("classified");
  });

  it("omits lastEventId when empty string from server", async () => {
    const { client } = buildMockClient({ lastEventId: "" });
    const result = await readMemory(client, "p");
    expect(result.lastEventId).toBeUndefined();
  });
});

describe("agents.readMemory — catchup timeout", () => {
  it("throws MemoryCatchupTimeoutError when WaitResult.timedOut is true", async () => {
    const { client, getProjection } = buildMockClient({
      catchupResult: { caughtUp: false, timedOut: true },
    });

    await expect(
      readMemory(client, "slow-projection", { minSeq: 1000n, timeoutMs: 100 })
    ).rejects.toMatchObject({
      name: "MemoryCatchupTimeoutError",
      projection: "slow-projection",
      minSeq: 1000n,
      timeoutMs: 100,
    });
    expect(getProjection).not.toHaveBeenCalled();
  });
});

describe("agents.readMemory — abort handling", () => {
  it("throws AbortError pre-flight without making any calls", async () => {
    const { client, getProjection, waitForProjectionCatchup } = buildMockClient();
    const ctrl = new AbortController();
    ctrl.abort();

    const err = await readMemory(client, "p", { signal: ctrl.signal }).catch(
      (e: unknown) => e
    );

    expect((err as Error).name).toBe("AbortError");
    expect(waitForProjectionCatchup).not.toHaveBeenCalled();
    expect(getProjection).not.toHaveBeenCalled();
  });

  it("aborts during catchup → AbortError, getProjection not called", async () => {
    let releaseCatchup: () => void = () => {};
    const hold = new Promise<void>((res) => {
      releaseCatchup = res;
    });
    const { client, getProjection } = buildMockClient({ holdCatchup: hold });

    const ctrl = new AbortController();
    const promise = readMemory(client, "p", {
      minSeq: 1,
      signal: ctrl.signal,
    });
    // Abort before catchup resolves.
    queueMicrotask(() => ctrl.abort());

    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(getProjection).not.toHaveBeenCalled();
    releaseCatchup();
  });

  it("aborts during getProjection → AbortError", async () => {
    let releaseGet: () => void = () => {};
    const hold = new Promise<void>((res) => {
      releaseGet = res;
    });
    const { client } = buildMockClient({ holdGetProjection: hold });

    const ctrl = new AbortController();
    const promise = readMemory(client, "p", { signal: ctrl.signal });
    queueMicrotask(() => ctrl.abort());

    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    releaseGet();
  });
});

describe("agents.readMemory — error propagation", () => {
  it("propagates getProjection errors", async () => {
    const { client } = buildMockClient();
    (client.getProjection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("projection not found")
    );
    await expect(readMemory(client, "missing")).rejects.toThrow(
      "projection not found"
    );
  });

  it("propagates waitForProjectionCatchup errors", async () => {
    const { client } = buildMockClient();
    (
      client.waitForProjectionCatchup as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("network down"));
    await expect(readMemory(client, "p", { minSeq: 1 })).rejects.toThrow(
      "network down"
    );
  });
});
