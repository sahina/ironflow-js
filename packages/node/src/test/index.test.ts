import { describe, it, expect } from "vitest";
import { createTestClient } from "./index.js";
import { createFunction } from "../function.js";
import { assertDefined } from "../internal/assert-defined.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const simpleFunction = createFunction(
  {
    id: "simple-fn",
    triggers: [{ event: "test.simple" }],
  },
  async ({ step }) => {
    const result = await step.run("greet", async () => "hello");
    return result;
  }
);

const multiStepFunction = createFunction(
  {
    id: "multi-step-fn",
    triggers: [{ event: "test.multi" }],
  },
  async ({ step }) => {
    const a = await step.run("step-a", async () => 1);
    const b = await step.run("step-b", async () => 2);
    const c = await step.run("step-c", async () => 3);
    return { a, b, c };
  }
);

const sleepFunction = createFunction(
  {
    id: "sleep-fn",
    triggers: [{ event: "test.sleep" }],
  },
  async ({ step }) => {
    await step.sleep("nap", "1h");
    await step.sleepUntil("alarm", "2030-01-01T00:00:00Z");
    return "awake";
  }
);

const waitEventFunction = createFunction(
  {
    id: "wait-event-fn",
    triggers: [{ event: "test.wait" }],
  },
  async ({ step }) => {
    const approval = await step.waitForEvent("wait-approval", {
      event: "approval.granted",
    });
    return approval.data;
  }
);

const invokeFunction = createFunction(
  {
    id: "invoke-fn",
    triggers: [{ event: "test.invoke" }],
  },
  async ({ step, event }) => {
    const result = await step.invoke<{ total: number }>(
      "billing/charge",
      event.data
    );
    return result;
  }
);

const sagaFunction = createFunction(
  {
    id: "saga-fn",
    triggers: [{ event: "test.saga" }],
  },
  async ({ step }) => {
    const payment = await step.run("charge", async () => ({
      paymentId: "pay-1",
    }));
    step.compensate("charge", async () => {
      // refund logic
    });

    const reservation = await step.run("reserve", async () => ({
      reservationId: "res-1",
    }));
    step.compensate("reserve", async () => {
      // cancel reservation logic
    });

    // This step fails
    await step.run("ship", async () => {
      throw new Error("out of stock");
    });

    return { payment, reservation };
  }
);

const parallelFunction = createFunction(
  {
    id: "parallel-fn",
    triggers: [{ event: "test.parallel" }],
  },
  async ({ step }) => {
    const [a, b] = await step.parallel("fetch-all", [
      async (s) => s.run("fetch-a", async () => "result-a"),
      async (s) => s.run("fetch-b", async () => "result-b"),
    ]);
    return { a, b };
  }
);

const mapFunction = createFunction(
  {
    id: "map-fn",
    triggers: [{ event: "test.map" }],
  },
  async ({ step }) => {
    const results = await step.map(
      "process-items",
      [1, 2, 3],
      async (item, s, index) => {
        return s.run(`process-${index}`, async () => item * 10);
      }
    );
    return results;
  }
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTestClient", () => {
  it("creates without errors", () => {
    const t = createTestClient({ functions: [simpleFunction] });
    expect(t).toBeDefined();
    expect(typeof t.mockStep).toBe("function");
    expect(typeof t.mockInvoke).toBe("function");
    expect(typeof t.sendEvent).toBe("function");
    expect(typeof t.emit).toBe("function");
  });
});

describe("emit", () => {
  it("triggers matching function and returns TestRun", async () => {
    const t = createTestClient({ functions: [simpleFunction] });
    t.mockStep("greet", () => "hello");

    const run = await t.emit("test.simple", {});

    expect(run.status).toBe("completed");
    expect(run.output).toBe("hello");
    expect(run.steps).toHaveLength(1);
    const s0 = assertDefined(run.steps[0]);
    expect(s0.name).toBe("greet");
    expect(s0.type).toBe("run");
    expect(s0.output).toBe("hello");
  });

  it("throws when no matching function", async () => {
    const t = createTestClient({ functions: [simpleFunction] });

    await expect(t.emit("unknown.event", {})).rejects.toThrow(
      'No function registered for event "unknown.event"'
    );
  });
});

describe("mockStep", () => {
  it("replaces step execution with stub", async () => {
    const t = createTestClient({ functions: [simpleFunction] });
    t.mockStep("greet", () => "mocked-hello");

    const run = await t.emit("test.simple", {});

    expect(run.status).toBe("completed");
    expect(run.output).toBe("mocked-hello");
    expect(run.stepOutput("greet")).toBe("mocked-hello");
  });

  it("throws with helpful message when step is unmocked", async () => {
    const t = createTestClient({ functions: [simpleFunction] });

    const run = await t.emit("test.simple", {});

    expect(run.status).toBe("failed");
    expect(run.error).toBeDefined();
    expect(run.error!.message).toContain('Step "greet" was called but has no mock');
    expect(run.error!.message).toContain('t.mockStep("greet", fn)');
  });

  it("executes multiple steps in order", async () => {
    const t = createTestClient({ functions: [multiStepFunction] });
    t.mockStep("step-a", () => 10);
    t.mockStep("step-b", () => 20);
    t.mockStep("step-c", () => 30);

    const run = await t.emit("test.multi", {});

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ a: 10, b: 20, c: 30 });
    expect(run.steps).toHaveLength(3);
    expect(assertDefined(run.steps[0]).name).toBe("step-a");
    expect(assertDefined(run.steps[1]).name).toBe("step-b");
    expect(assertDefined(run.steps[2]).name).toBe("step-c");
  });
});

describe("sleep / sleepUntil", () => {
  it("resolve immediately and record type 'sleep'", async () => {
    const t = createTestClient({ functions: [sleepFunction] });

    const run = await t.emit("test.sleep", {});

    expect(run.status).toBe("completed");
    expect(run.output).toBe("awake");
    expect(run.steps).toHaveLength(2);
    const s0 = assertDefined(run.steps[0]);
    const s1 = assertDefined(run.steps[1]);
    expect(s0.name).toBe("nap");
    expect(s0.type).toBe("sleep");
    expect(s1.name).toBe("alarm");
    expect(s1.type).toBe("sleep");
  });
});

describe("waitForEvent", () => {
  it("resolves with pre-registered event via sendEvent", async () => {
    const t = createTestClient({ functions: [waitEventFunction] });
    t.sendEvent("approval.granted", { approved: true, by: "admin" });

    const run = await t.emit("test.wait", {});

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ approved: true, by: "admin" });
    expect(run.steps).toHaveLength(1);
    expect(assertDefined(run.steps[0]).type).toBe("waitForEvent");
  });

  it("throws when no event pre-registered", async () => {
    const t = createTestClient({ functions: [waitEventFunction] });

    const run = await t.emit("test.wait", {});

    expect(run.status).toBe("failed");
    expect(run.error).toBeDefined();
    expect(run.error!.message).toContain(
      'step.waitForEvent("wait-approval") is waiting for "approval.granted"'
    );
    expect(run.error!.message).toContain("t.sendEvent");
  });
});

describe("invoke", () => {
  it("resolves with mocked invoke", async () => {
    const t = createTestClient({ functions: [invokeFunction] });
    t.mockInvoke("billing/charge", (data) => ({
      total: (data as { amount: number }).amount + 10,
    }));

    const run = await t.emit("test.invoke", { amount: 100 });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ total: 110 });
    expect(run.steps).toHaveLength(1);
    expect(assertDefined(run.steps[0]).name).toBe("billing/charge");
    expect(assertDefined(run.steps[0]).type).toBe("invoke");
  });

  it("throws with helpful message when invoke is unmocked", async () => {
    const t = createTestClient({ functions: [invokeFunction] });

    const run = await t.emit("test.invoke", { amount: 100 });

    expect(run.status).toBe("failed");
    expect(run.error).toBeDefined();
    expect(run.error!.message).toContain(
      'step.invoke("billing/charge") was called but has no mock'
    );
    expect(run.error!.message).toContain('t.mockInvoke("billing/charge", fn)');
  });
});

describe("compensations", () => {
  it("run in reverse order on failure", async () => {
    const compensationOrder: string[] = [];

    const t = createTestClient({ functions: [sagaFunction] });
    t.mockStep("charge", () => ({ paymentId: "pay-1" }));
    t.mockStep("reserve", () => ({ reservationId: "res-1" }));
    t.mockStep("ship", () => {
      throw new Error("out of stock");
    });

    // We can't easily track the order of built-in compensations since
    // they are no-op in the fixture. Let's use a custom saga to test order.
    const orderTrackingSaga = createFunction(
      {
        id: "order-saga",
        triggers: [{ event: "test.order-saga" }],
      },
      async ({ step }) => {
        await step.run("step-1", async () => "a");
        step.compensate("step-1", async () => {
          compensationOrder.push("comp-1");
        });

        await step.run("step-2", async () => "b");
        step.compensate("step-2", async () => {
          compensationOrder.push("comp-2");
        });

        await step.run("step-3", async () => {
          throw new Error("boom");
        });

        return "done";
      }
    );

    const t2 = createTestClient({ functions: [orderTrackingSaga] });
    t2.mockStep("step-1", () => "a");
    t2.mockStep("step-2", () => "b");
    t2.mockStep("step-3", () => {
      throw new Error("boom");
    });

    const run = await t2.emit("test.order-saga", {});

    expect(run.status).toBe("failed");
    expect(run.error!.message).toBe("boom");
    expect(compensationOrder).toEqual(["comp-2", "comp-1"]);
    expect(run.compensationsRan).toEqual(["step-2", "step-1"]);
  });

  it("don't run on success", async () => {
    const sagaSuccess = createFunction(
      {
        id: "saga-success",
        triggers: [{ event: "test.saga-success" }],
      },
      async ({ step }) => {
        await step.run("charge", async () => "charged");
        step.compensate("charge", async () => {
          throw new Error("should not run");
        });
        return "done";
      }
    );

    const t = createTestClient({ functions: [sagaSuccess] });
    t.mockStep("charge", () => "charged");

    const run = await t.emit("test.saga-success", {});

    expect(run.status).toBe("completed");
    expect(run.compensationsRan).toEqual([]);
  });
});

describe("parallel", () => {
  it("executes branches with mocked steps", async () => {
    const t = createTestClient({ functions: [parallelFunction] });
    t.mockStep("fetch-a", () => "result-a");
    t.mockStep("fetch-b", () => "result-b");

    const run = await t.emit("test.parallel", {});

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ a: "result-a", b: "result-b" });
    expect(run.steps).toHaveLength(2);
    expect(run.stepOutput("fetch-a")).toBe("result-a");
    expect(run.stepOutput("fetch-b")).toBe("result-b");
  });
});

describe("map", () => {
  it("executes over items with mocked steps", async () => {
    const t = createTestClient({ functions: [mapFunction] });
    t.mockStep("process-0", () => 10);
    t.mockStep("process-1", () => 20);
    t.mockStep("process-2", () => 30);

    const run = await t.emit("test.map", {});

    expect(run.status).toBe("completed");
    expect(run.output).toEqual([10, 20, 30]);
    expect(run.steps).toHaveLength(3);
  });
});

describe("stepOutput", () => {
  it("returns undefined for unknown step", async () => {
    const t = createTestClient({ functions: [simpleFunction] });
    t.mockStep("greet", () => "hello");

    const run = await t.emit("test.simple", {});

    expect(run.stepOutput("greet")).toBe("hello");
    expect(run.stepOutput("nonexistent")).toBeUndefined();
  });
});

describe("run.output", () => {
  it("captures function return value", async () => {
    const returnValueFn = createFunction(
      {
        id: "return-value-fn",
        triggers: [{ event: "test.return" }],
      },
      async ({ event }) => {
        return { received: event.data, processed: true };
      }
    );

    const t = createTestClient({ functions: [returnValueFn] });

    const run = await t.emit("test.return", { foo: "bar" });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ received: { foo: "bar" }, processed: true });
  });
});

describe("invokeAsync", () => {
  it("resolves with a runId when mocked", async () => {
    const asyncInvokeFn = createFunction(
      {
        id: "async-invoke-fn",
        triggers: [{ event: "test.async-invoke" }],
      },
      async ({ step }) => {
        const { runId } = await step.invokeAsync("background/job", {
          task: "process",
        });
        return { childRunId: runId };
      }
    );

    const t = createTestClient({ functions: [asyncInvokeFn] });
    t.mockInvoke("background/job", () => "ok");

    const run = await t.emit("test.async-invoke", {});

    expect(run.status).toBe("completed");
    expect(run.output).toHaveProperty("childRunId");
    expect((run.output as { childRunId: string }).childRunId).toMatch(
      /^test-run-/
    );
  });

  it("throws with helpful message when unmocked", async () => {
    const asyncInvokeFn = createFunction(
      {
        id: "async-invoke-fn",
        triggers: [{ event: "test.async-invoke" }],
      },
      async ({ step }) => {
        await step.invokeAsync("background/job", { task: "process" });
      }
    );

    const t = createTestClient({ functions: [asyncInvokeFn] });

    const run = await t.emit("test.async-invoke", {});

    expect(run.status).toBe("failed");
    expect(run.error!.message).toContain(
      'step.invokeAsync("background/job") was called but has no mock'
    );
  });
});

describe("event data forwarding", () => {
  it("passes event data to function handler", async () => {
    const dataFn = createFunction(
      {
        id: "data-fn",
        triggers: [{ event: "test.data" }],
      },
      async ({ event }) => {
        return { echo: event.data };
      }
    );

    const t = createTestClient({ functions: [dataFn] });

    const run = await t.emit("test.data", { key: "value", num: 42 });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ echo: { key: "value", num: 42 } });
  });
});

describe("multiple functions for same event", () => {
  it("triggers the first registered function", async () => {
    const fn1 = createFunction(
      {
        id: "fn-1",
        triggers: [{ event: "shared.event" }],
      },
      async () => "from-fn-1"
    );
    const fn2 = createFunction(
      {
        id: "fn-2",
        triggers: [{ event: "shared.event" }],
      },
      async () => "from-fn-2"
    );

    const t = createTestClient({ functions: [fn1, fn2] });

    const run = await t.emit("shared.event", {});

    expect(run.status).toBe("completed");
    expect(run.output).toBe("from-fn-1");
  });
});
