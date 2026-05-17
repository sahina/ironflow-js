import { describe, it, expect } from "vitest";
import { createProjection } from "./projection.js";

describe("createProjection", () => {
  it("creates a managed projection with initialState", () => {
    const proj = createProjection({
      name: "test-projection",
      events: ["order.created"],
      handler: (state: any, _event: any) => ({ ...state, count: (state.count || 0) + 1 }),
      initialState: () => ({ count: 0 }),
    });

    expect(proj.config.name).toBe("test-projection");
    expect(proj.config.mode).toBe("managed");
    expect(proj.config.events).toEqual(["order.created"]);
  });

  it("creates an external projection without initialState", () => {
    const proj = createProjection({
      name: "external-proj",
      events: ["employee.*"],
      mode: "external",
      handler: async (_event: any, _ctx: any) => { /* side effect */ },
    });

    expect(proj.config.mode).toBe("external");
    expect(proj.config.initialState).toBeUndefined();
  });

  it("auto-detects managed mode when initialState is provided", () => {
    const proj = createProjection({
      name: "auto-detect",
      events: ["test"],
      handler: (state: any, _event: any) => state,
      initialState: () => ({}),
    });

    expect(proj.config.mode).toBe("managed");
  });

  it("auto-detects external mode when initialState is absent", () => {
    const proj = createProjection({
      name: "auto-detect-external",
      events: ["test"],
      handler: async (_event: any) => {},
    });

    expect(proj.config.mode).toBe("external");
  });

  it("throws on empty name", () => {
    expect(() =>
      createProjection({
        name: "",
        events: ["test"],
        handler: (s: any, _e: any) => s,
        initialState: () => ({}),
      })
    ).toThrow();
  });

  it("throws on empty events array", () => {
    expect(() =>
      createProjection({
        name: "test",
        events: [],
        handler: (s: any, _e: any) => s,
        initialState: () => ({}),
      })
    ).toThrow();
  });

  it("sets default maxRetries and batchSize", () => {
    const proj = createProjection({
      name: "defaults",
      events: ["test"],
      handler: (s: any, _e: any) => s,
      initialState: () => ({}),
    });

    expect(proj.config.maxRetries).toBe(3);
    expect(proj.config.batchSize).toBe(100);
  });

  it("respects custom maxRetries and batchSize", () => {
    const proj = createProjection({
      name: "custom",
      events: ["test"],
      handler: (s: any, _e: any) => s,
      initialState: () => ({}),
      maxRetries: 5,
      batchSize: 50,
    });

    expect(proj.config.maxRetries).toBe(5);
    expect(proj.config.batchSize).toBe(50);
  });
});
