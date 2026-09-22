import { describe, test, expect } from "vitest";
import { createUpcasterRegistry } from "./upcaster.js";
import { isRedacted } from "./utils.js";

describe("UpcasterRegistry", () => {
  test("registers and applies single upcaster", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({
      ...data,
      shippingAddress: null,
    }));

    const result = registry.upcast("order.created", { orderId: "123" }, 1, 2);
    expect(result).toEqual({ orderId: "123", shippingAddress: null });
  });

  test("applies upcaster chain v1 -> v2 -> v3", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({
      ...data,
      shippingAddress: null,
    }));
    registry.register("order.created", 2, 3, (data: any) => ({
      ...data,
      priority: "normal",
    }));

    const result = registry.upcast("order.created", { orderId: "123" }, 1, 3);
    expect(result).toEqual({
      orderId: "123",
      shippingAddress: null,
      priority: "normal",
    });
  });

  test("throws on incomplete upcaster chain", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({
      ...data,
      field: "added",
    }));

    expect(() =>
      registry.upcast("order.created", { orderId: "123" }, 1, 3)
    ).toThrow(/incomplete upcaster chain.*v2/i);
  });

  test("returns data unchanged when fromVersion equals toVersion", () => {
    const registry = createUpcasterRegistry();
    const data = { orderId: "123" };
    const result = registry.upcast("order.created", data, 2, 2);
    expect(result).toEqual(data);
  });

  test("throws on unknown event name", () => {
    const registry = createUpcasterRegistry();
    expect(() =>
      registry.upcast("unknown.event", { foo: "bar" }, 1, 2)
    ).toThrow(/incomplete upcaster chain/i);
  });

  test("getLatestVersion returns highest registered toVersion", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (d: any) => d);
    registry.register("order.created", 2, 3, (d: any) => d);

    expect(registry.getLatestVersion("order.created")).toBe(3);
    expect(registry.getLatestVersion("unknown.event")).toBeUndefined();
  });

  test("throws when upcaster function throws", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, () => {
      throw new Error("upcaster boom");
    });

    expect(() =>
      registry.upcast("order.created", { orderId: "123" }, 1, 2)
    ).toThrow("upcaster boom");
  });

  test("propagates error from middle of chain", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({
      ...data,
      shippingAddress: null,
    }));
    registry.register("order.created", 2, 3, () => {
      throw new Error("v2->v3 failed");
    });
    registry.register("order.created", 3, 4, (data: any) => ({
      ...data,
      priority: "high",
    }));

    expect(() =>
      registry.upcast("order.created", { orderId: "123" }, 1, 4)
    ).toThrow("v2->v3 failed");
  });

  test("handles deeply chained upcasters v1 through v6", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({ ...data, field2: "v2" }));
    registry.register("order.created", 2, 3, (data: any) => ({ ...data, field3: "v3" }));
    registry.register("order.created", 3, 4, (data: any) => ({ ...data, field4: "v4" }));
    registry.register("order.created", 4, 5, (data: any) => ({ ...data, field5: "v5" }));
    registry.register("order.created", 5, 6, (data: any) => ({ ...data, field6: "v6" }));

    const result = registry.upcast("order.created", { orderId: "123" }, 1, 6);
    expect(result).toEqual({
      orderId: "123",
      field2: "v2",
      field3: "v3",
      field4: "v4",
      field5: "v5",
      field6: "v6",
    });
  });

  test("handles complete shape replacement", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, () => ({
      completelynew: true,
      version: 2,
    }));

    const result = registry.upcast("order.created", { orderId: "123", old: true }, 1, 2);
    expect(result).toEqual({ completelynew: true, version: 2 });
  });

  test("handles upcaster that returns null", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, () => null);
    registry.register("order.created", 2, 3, (data: any) => ({ wrapped: data }));

    const result = registry.upcast("order.created", { orderId: "123" }, 1, 3);
    expect(result).toEqual({ wrapped: null });
  });

  test("independent event names do not interfere", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.created", 1, 2, (data: any) => ({
      ...data,
      orderField: true,
    }));
    registry.register("user.created", 1, 2, (data: any) => ({
      ...data,
      userField: true,
    }));

    const orderResult = registry.upcast("order.created", { id: "o1" }, 1, 2);
    expect(orderResult).toEqual({ id: "o1", orderField: true });

    const userResult = registry.upcast("user.created", { id: "u1" }, 1, 2);
    expect(userResult).toEqual({ id: "u1", userField: true });

    // Verify they didn't leak into each other
    expect((orderResult as any).userField).toBeUndefined();
    expect((userResult as any).orderField).toBeUndefined();
  });
});

describe("UpcasterRegistry with a redacted payload", () => {
  const REDACTED = {
    $redacted: true,
    sha256: "ab".repeat(32),
    redactedAt: "2026-09-21T00:00:00.000Z",
  };

  test("skips the chain entirely and returns the placeholder untouched", () => {
    const registry = createUpcasterRegistry();
    let invoked = false;
    registry.register("order.placed", 1, 2, (data: any) => {
      invoked = true;
      return { ...data, currency: "USD" };
    });

    const result = registry.upcast("order.placed", REDACTED, 1, 2);

    // The never-invoked flag is the assertion that matters: it is the one that
    // fails if the guard is ever moved below the loop.
    expect(invoked).toBe(false);
    expect(result).toEqual(REDACTED);
    expect(isRedacted(result)).toBe(true);
  });

  test("an upcaster that rebuilds the object cannot drop the marker", () => {
    // Before the guard this returned {currency:"USD"} — isRedacted went false
    // and the handler folded in `undefined` as if the producer had sent it.
    const registry = createUpcasterRegistry();
    registry.register("order.placed", 1, 2, (data: any) => ({
      amount: data.amount,
      currency: "USD",
    }));

    expect(isRedacted(registry.upcast("order.placed", REDACTED, 1, 2))).toBe(true);
  });

  test("an upcaster that reaches through a nested field no longer throws", () => {
    // Before the guard this threw a TypeError out of the ExecutionContext
    // constructor, which serve() reported as a 500 and the engine retried to
    // exhaustion.
    const registry = createUpcasterRegistry();
    registry.register("order.placed", 1, 2, (data: any) => ({
      email: data.customer.email,
    }));

    expect(() => registry.upcast("order.placed", REDACTED, 1, 2)).not.toThrow();
  });

  test("skips a multi-step chain, not just the first hop", () => {
    const registry = createUpcasterRegistry();
    const invoked: number[] = [];
    registry.register("order.placed", 1, 2, (d: any) => (invoked.push(1), d));
    registry.register("order.placed", 2, 3, (d: any) => (invoked.push(2), d));

    expect(registry.upcast("order.placed", REDACTED, 1, 3)).toEqual(REDACTED);
    expect(invoked).toEqual([]);
  });

  test("an incomplete chain no longer errors on a redacted payload", () => {
    // The placeholder needs no migration, so a gap in the chain is not a
    // problem it can hit. Real payloads still throw — asserted above.
    const registry = createUpcasterRegistry();
    registry.register("order.placed", 1, 2, (d: any) => d);

    expect(registry.upcast("order.placed", REDACTED, 1, 3)).toEqual(REDACTED);
    expect(() => registry.upcast("order.placed", { id: "o1" }, 1, 3)).toThrow(
      /Incomplete upcaster chain/
    );
  });

  test("real payloads still run the chain", () => {
    const registry = createUpcasterRegistry();
    registry.register("order.placed", 1, 2, (data: any) => ({
      ...data,
      currency: "USD",
    }));

    expect(registry.upcast("order.placed", { amount: 10 }, 1, 2)).toEqual({
      amount: 10,
      currency: "USD",
    });
  });
});
