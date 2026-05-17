import type {
  IronflowFunction,
  AnyIronflowFunction,
  IronflowEvent,
  FunctionContext,
  Logger,
  SecretsClient,
} from "@ironflow/core";
import {
  createTestStepClient,
  type TestStep,
  type TestStepRegistries,
  type TestStepState,
} from "./test-step.js";

export interface TestClientConfig {
  functions: AnyIronflowFunction[];
}

export interface TestRun {
  status: "completed" | "failed";
  steps: TestStep[];
  output: unknown;
  error?: Error;
  compensationsRan: string[];
  stepOutput(name: string): unknown;
}

export interface TestClient {
  mockStep(name: string, fn: () => unknown): void;
  mockInvoke(functionId: string, fn: (data: unknown) => unknown): void;
  sendEvent(eventName: string, data: unknown): void;
  emit(eventName: string, data: unknown): Promise<TestRun>;
}

export function createTestClient(config: TestClientConfig): TestClient {
  const stepMocks = new Map<string, () => unknown>();
  const invokeMocks = new Map<string, (data: unknown) => unknown>();
  const eventQueue = new Map<string, unknown[]>();

  // Index functions by trigger event
  const functionsByEvent = new Map<string, IronflowFunction[]>();
  for (const fn of config.functions) {
    for (const trigger of fn.config.triggers) {
      const existing = functionsByEvent.get(trigger.event) ?? [];
      existing.push(fn);
      functionsByEvent.set(trigger.event, existing);
    }
  }

  return {
    mockStep(name: string, fn: () => unknown): void {
      stepMocks.set(name, fn);
    },

    mockInvoke(functionId: string, fn: (data: unknown) => unknown): void {
      invokeMocks.set(functionId, fn);
    },

    sendEvent(eventName: string, data: unknown): void {
      const existing = eventQueue.get(eventName) ?? [];
      existing.push(data);
      eventQueue.set(eventName, existing);
    },

    async emit(eventName: string, data: unknown): Promise<TestRun> {
      const fns = functionsByEvent.get(eventName);
      if (!fns || fns.length === 0) {
        throw new Error(
          `No function registered for event "${eventName}". ` +
            `Check that your function has a trigger for this event.`
        );
      }

      const fn = fns[0]!;
      const registries: TestStepRegistries = { stepMocks, invokeMocks, eventQueue };
      const state: TestStepState = { steps: [], compensations: [] };
      const step = createTestStepClient(registries, state);

      const event: IronflowEvent = {
        id: `test-evt-${Date.now()}`,
        name: eventName,
        version: 1,
        data,
        timestamp: new Date(),
      };

      const noopLogger: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      const noopSecrets: SecretsClient = {
        get(name: string) {
          throw new Error(`Secret "${name}" not available in test mode`);
        },
        has() {
          return false;
        },
      };

      const ctx: FunctionContext = {
        event,
        step,
        run: {
          id: `test-run-${Date.now()}`,
          functionId: fn.config.id,
          attempt: 1,
          startedAt: new Date(),
        },
        logger: noopLogger,
        secrets: noopSecrets,
      };

      try {
        const output = await fn.handler(ctx);
        return buildTestRun("completed", state.steps, output, undefined, []);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Run compensations in reverse order
        const compensationsRan: string[] = [];
        const reversed = [...state.compensations].reverse();
        for (const { stepName, fn: compFn } of reversed) {
          try {
            await compFn();
            compensationsRan.push(stepName);
            state.steps.push({ name: `compensate:${stepName}`, type: "compensate" });
          } catch (compErr) {
            compensationsRan.push(stepName);
            state.steps.push({
              name: `compensate:${stepName}`,
              type: "compensate",
              error: compErr instanceof Error ? compErr : new Error(String(compErr)),
            });
          }
        }

        return buildTestRun("failed", state.steps, undefined, err, compensationsRan);
      }
    },
  };
}

function buildTestRun(
  status: "completed" | "failed",
  steps: TestStep[],
  output: unknown,
  error: Error | undefined,
  compensationsRan: string[]
): TestRun {
  return {
    status,
    steps,
    output,
    error,
    compensationsRan,
    stepOutput(name: string): unknown {
      const s = steps.find((step) => step.name === name);
      return s?.output;
    },
  };
}

export type { TestStep };
