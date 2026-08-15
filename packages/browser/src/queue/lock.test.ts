import { describe, it, expect, vi, afterEach } from "vitest";
import { withFlushLock, hasWebLocks, LOCK_BUSY } from "./lock.js";
import { newUuid } from "./ids.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal LockManager that grants at most one holder per name. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    request: vi.fn(
      async (
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: unknown) => Promise<unknown>
      ) => {
        if (held.has(name)) {
          if (options.ifAvailable) return callback(null);
          throw new Error("would deadlock: test fake does not queue waiters");
        }
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      }
    ),
  };
}

describe("withFlushLock", () => {
  describe("without navigator.locks (Safari < 16, SSR)", () => {
    it("reports no Web Locks support", () => {
      expect(hasWebLocks()).toBe(false);
    });

    it("runs the callback anyway and returns its value", async () => {
      const result = await withFlushLock("q", async () => "drained");
      expect(result).toBe("drained");
    });

    it("propagates errors from the callback", async () => {
      await expect(
        withFlushLock("q", async () => {
          throw new Error("drain failed");
        })
      ).rejects.toThrow("drain failed");
    });
  });

  describe("with navigator.locks", () => {
    it("reports support and runs under an exclusive, ifAvailable lock", async () => {
      const locks = fakeLocks();
      vi.stubGlobal("navigator", { locks });

      expect(hasWebLocks()).toBe(true);
      await expect(withFlushLock("q", async () => "drained")).resolves.toBe("drained");

      expect(locks.request).toHaveBeenCalledWith(
        "q",
        { ifAvailable: true, mode: "exclusive" },
        expect.any(Function)
      );
    });

    it("returns LOCK_BUSY without running the callback when another holder has it", async () => {
      const locks = fakeLocks();
      vi.stubGlobal("navigator", { locks });
      locks.held.add("q");

      const fn = vi.fn(async () => "drained");
      await expect(withFlushLock("q", fn)).resolves.toBe(LOCK_BUSY);
      expect(fn).not.toHaveBeenCalled();
    });

    it("serialises two drainers — the second sees LOCK_BUSY", async () => {
      const locks = fakeLocks();
      vi.stubGlobal("navigator", { locks });

      let releaseFirst!: () => void;
      const firstInside = new Promise<void>((r) => (releaseFirst = r));
      const order: string[] = [];

      const first = withFlushLock("q", async () => {
        order.push("first:start");
        await firstInside;
        order.push("first:end");
        return "first";
      });

      // Second attempt while the first still holds the lock.
      const second = await withFlushLock("q", async () => {
        order.push("second:ran");
        return "second";
      });

      expect(second).toBe(LOCK_BUSY);
      releaseFirst();
      await expect(first).resolves.toBe("first");
      expect(order).toEqual(["first:start", "first:end"]);
    });

    it("releases the lock when the callback returns, so a later call can acquire", async () => {
      const locks = fakeLocks();
      vi.stubGlobal("navigator", { locks });

      await withFlushLock("q", async () => "one");
      expect(locks.held.size).toBe(0);
      await expect(withFlushLock("q", async () => "two")).resolves.toBe("two");
    });

    it("releases the lock even when the callback throws", async () => {
      const locks = fakeLocks();
      vi.stubGlobal("navigator", { locks });

      await expect(
        withFlushLock("q", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      expect(locks.held.size).toBe(0);
    });
  });
});

describe("newUuid", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: globalThis.crypto.getRandomValues });

    expect(newUuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalled();
  });

  it("falls back to getRandomValues on the documented Safari 13.1 baseline", () => {
    // Safari 13.1 has getRandomValues but not randomUUID.
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues: real });

    const id = newUuid();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("produces distinct ids from the fallback", () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues: real });

    const ids = new Set(Array.from({ length: 200 }, () => newUuid()));
    expect(ids.size).toBe(200);
  });

  it("sets the version and variant bits from a fully-zero random source", () => {
    // Pins the RFC 4122 bit-twiddling itself rather than trusting randomness.
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => a.fill(0),
    });

    expect(newUuid()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("throws a clear error when Web Crypto is unavailable entirely", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newUuid()).toThrow(/requires Web Crypto/);
  });
});
