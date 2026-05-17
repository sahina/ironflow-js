import { describe, test, expect } from "vitest";
import { defineEvent, createEventDefinitionRegistry } from "./event-definition.js";

describe("defineEvent", () => {
  test("creates event definition with name and version", () => {
    const def = defineEvent({
      name: "order.created",
      version: 1,
    });
    expect(def.name).toBe("order.created");
    expect(def.version).toBe(1);
    expect(def.upcast).toBeUndefined();
  });

  test("creates event definition with upcast function", () => {
    const def = defineEvent({
      name: "order.created",
      version: 2,
      upcast: (data: any) => ({ ...data, newField: "default" }),
    });
    expect(def.version).toBe(2);
    expect(def.upcast).toBeDefined();
    expect(def.upcast!({ orderId: "123" })).toEqual({
      orderId: "123",
      newField: "default",
    });
  });
});

describe("EventDefinitionRegistry", () => {
  test("registers definitions and builds upcaster chain", () => {
    const registry = createEventDefinitionRegistry();

    registry.register(defineEvent({ name: "order.created", version: 1 }));
    registry.register(
      defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: any) => ({ ...data, address: null }),
      })
    );
    registry.register(
      defineEvent({
        name: "order.created",
        version: 3,
        upcast: (data: any) => ({ ...data, priority: "normal" }),
      })
    );

    const result = registry.upcastEvent("order.created", { orderId: "123" }, 1);
    expect(result).toEqual({
      orderId: "123",
      address: null,
      priority: "normal",
    });
  });

  test("getLatestVersion returns highest version", () => {
    const registry = createEventDefinitionRegistry();
    registry.register(defineEvent({ name: "order.created", version: 1 }));
    registry.register(
      defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: any) => data,
      })
    );
    expect(registry.getLatestVersion("order.created")).toBe(2);
  });

  test("returns data unchanged for events at latest version", () => {
    const registry = createEventDefinitionRegistry();
    registry.register(defineEvent({ name: "order.created", version: 1 }));

    const data = { orderId: "123" };
    const result = registry.upcastEvent("order.created", data, 1);
    expect(result).toEqual(data);
  });

  test("returns data unchanged for unknown events", () => {
    const registry = createEventDefinitionRegistry();
    const data = { foo: "bar" };
    const result = registry.upcastEvent("unknown.event", data, 1);
    expect(result).toEqual(data);
  });
});
