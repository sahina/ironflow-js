# Generate Tests

### Step 1: Detect framework

- `vitest.config.ts` or `vitest` in devDependencies → vitest
- `jest.config.*` or `jest` in devDependencies → Jest
- `go.mod` → Go testing
- None? Recommend vitest (TS) or stdlib (Go) and offer install.

### Step 2: Find components to test

```bash
grep -rn "createFunction\|createProjection\|createWorker\|createWebhook" src/ --include="*.ts"
grep -rn "ironflow.CreateFunction\|ironflow.CreateProjection\|ironflow.NewWorker" . --include="*.go"
grep -rn "from ironflow.worker import\|@function(" . --include="*.py"
```

### Step 3: Apply test patterns

| Component | Type | Must test | Server required? |
|---|---|---|---|
| **Aggregate decider** (pure fn) | Unit (Given/When/Then) | Every invariant, every command-path, rejected commands | No |
| **Aggregate evolver** (pure fn) | Unit | Fold correctness, field preservation across events | No |
| Projection | Unit | Initial state, single event, accumulation, immutability | No |
| Function (command handler) | Integration | Dispatch → append → projection reflects | Yes |
| Function (process manager / reactor) | Integration | Event in → command or side effect out | Yes |
| Entity Stream | Integration | Append+read, optimistic concurrency, version info | Yes |
| Worker | Integration | Starts, registers functions | Yes |
| KV Store | Integration | Bucket CRUD, create-if-not-exists | Yes |
| Webhook | Unit | Verify rejects bad sigs, transform output | No |
| Upcaster | Unit | v1→v2 transform, field preservation | No |

**Order of test coverage for a command-side feature:**
1. Decider (Given/When/Then) — every invariant
2. Evolver — folding correctness
3. Projection — view shape per event
4. Command handler integration — one happy path, one rejection
5. Process manager / reactor integration — if present

### Step 4: Projection unit test (vitest)

```typescript
import { describe, it, expect } from "vitest";
import type { ManagedProjectionHandler, ProjectionContext } from "@ironflow/node";
import { orderStats } from "./order-stats";
import { OrderEvents } from "../events/order-events";

// `createProjection` returns `{ config }` and nothing else — reach the reducer
// through `.config`, not off the projection object. `handler` is typed as a
// managed|external union and takes a third `ctx` argument — narrow it and stub ctx.
type State = { totalOrders: number; totalRevenue: number };
const ctx = { logger: console } as unknown as ProjectionContext;
describe("order-stats projection", () => {
  const handler = orderStats.config.handler as ManagedProjectionHandler<State>;
  const initialState = orderStats.config.initialState!();

  it("starts with zero state", () => {
    expect(initialState).toEqual({ totalOrders: 0, totalRevenue: 0 });
  });

  it("accumulates across events", () => {
    const events = [
      { name: OrderEvents.PLACED, data: { orderId: "1", total: 49.99 } },
      { name: OrderEvents.PLACED, data: { orderId: "2", total: 25.00 } },
    ];
    const final = events.reduce((s, e) => handler(s, e, ctx), initialState);
    expect(final.totalOrders).toBe(2);
    expect(final.totalRevenue).toBeCloseTo(74.99);
  });

  it("does not mutate previous state", () => {
    const before = { ...initialState };
    handler(initialState, { name: OrderEvents.PLACED, data: { total: 10 } }, ctx);
    expect(initialState).toEqual(before);
  });
});
```

### Step 4a: Aggregate decider — Given/When/Then (vitest)

The canonical ES test shape. Zero SDK dependency — the decider is a pure function, so
these tests are fast, deterministic, and cover every invariant.

```typescript
import { describe, it, expect } from "vitest";
import { decideOrder, evolveOrder, type OrderState } from "./order-aggregate";
import { NonRetryableError } from "@ironflow/node";

function given(events: any[]): OrderState {
  return events.reduce(evolveOrder, evolveOrder(undefined as any, { name: "__init" } as any));
}

describe("Order aggregate", () => {
  it("Given nothing, When Place, Then OrderPlaced is produced", () => {
    const state = given([]);
    const cmd = { type: "Place", orderId: "o1", items: [{ sku: "A", qty: 1 }] };
    const events = decideOrder(state, cmd);
    expect(events).toEqual([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
  });

  it("Given OrderPlaced, When Place again, Then rejected", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
    expect(() => decideOrder(state, { type: "Place", orderId: "o1", items: [] }))
      .toThrow(NonRetryableError);
  });

  it("Given OrderPlaced, When Cancel, Then OrderCancelled", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
    const events = decideOrder(state, { type: "Cancel", orderId: "o1", reason: "oops" });
    expect(events[0].name).toBe("OrderCancelled");
  });

  it("Given OrderShipped, When Cancel, Then rejected (cannot cancel shipped)", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [] } },
      { name: "OrderShipped", data: { orderId: "o1", trackingId: "T1" } },
    ]);
    expect(() => decideOrder(state, { type: "Cancel", orderId: "o1", reason: "late" }))
      .toThrow(/cannot cancel/i);
  });
});
```

Rules:
- **One invariant per test.** Test name reads as the Given/When/Then clause
- **Never mock the decider.** Test it directly; it has no I/O
- **Expectations are events, not state.** The decider's contract is "given this history,
  which events does this command produce?"
- **Rejections throw `NonRetryableError`** — assert the error class, not the string
- Cover every guard clause — one negative test per invariant

### Step 5: Function integration test (vitest)

Requires `ironflow serve` running.

```typescript
import { describe, it, expect } from "vitest";
import { createClient } from "@ironflow/node";
import { OrderEvents } from "../events/order-events";

const client = createClient({
  serverUrl: process.env.IRONFLOW_SERVER_URL || "http://localhost:9123",
});

describe("process-order (integration)", () => {
  it("completes on valid order", async () => {
    const { eventId } = await client.emit(OrderEvents.PLACED, {
      orderId: "test_1", total: 99.99,
    });
    const run = await waitForRun(client, "process-order", eventId, 10_000);
    expect(run.status).toBe("completed");
  });
});

async function waitForRun(client: any, fnId: string, evId: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // listRuns returns { runs, nextCursor, totalCount } — not a bare array.
    const { runs } = await client.listRuns({ functionId: fnId, limit: 10 });
    const run = runs.find((r: any) => r.eventId === evId);   // field is eventId
    if (run && (run.status === "completed" || run.status === "failed")) return run;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${fnId}`);
}
```

### Step 6: Entity stream test (optimistic concurrency)

```typescript
it("enforces optimistic concurrency", async () => {
  const id = `order-${Date.now()}`;
  await client.streams.append(id, {
    name: OrderEvents.PLACED, data: { total: 50 }, entityType: "order",
  }, { expectedVersion: 0 });

  await expect(
    client.streams.append(id, {
      name: OrderEvents.UPDATED, data: { total: 60 }, entityType: "order",
    }, { expectedVersion: 0 }),   // wrong — should be 1
  ).rejects.toThrow();
});
```

### Step 7: Run tests

```bash
pnpm vitest run path/to/file.test.ts
pnpm jest path/to/file.test.ts
go test -v -run TestName ./path/...
```

If integration tests fail with connection errors, prompt user to start `ironflow serve`.

### Test file naming

- TS: `*.test.ts` next to source; integration in `tests/` or `*.integration.test.ts`
- Go: `*_test.go` in same package

