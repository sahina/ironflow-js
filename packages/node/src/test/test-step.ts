import type {
  StepClient,
  Duration,
  EventFilter,
  IronflowEvent,
  ParallelOptions,
  PublishResult,
} from "@ironflow/core";

export interface TestStep {
  name: string;
  type: "run" | "invoke" | "sleep" | "waitForEvent" | "compensate";
  output?: unknown;
  error?: Error;
}

export interface TestStepRegistries {
  stepMocks: Map<string, () => unknown>;
  invokeMocks: Map<string, (data: unknown) => unknown>;
  eventQueue: Map<string, unknown[]>;
}

export interface TestStepState {
  steps: TestStep[];
  compensations: Array<{ stepName: string; fn: () => Promise<void> }>;
}

export function createTestStepClient(
  registries: TestStepRegistries,
  state: TestStepState
): StepClient {
  const stepClient: StepClient = {
    async run<T>(name: string, _fn: () => Promise<T>): Promise<T> {
      const mock = registries.stepMocks.get(name);
      if (!mock) {
        throw new Error(
          `Step "${name}" was called but has no mock. ` +
            `Use t.mockStep("${name}", fn) to provide one.`
        );
      }
      const output = await Promise.resolve(mock());
      state.steps.push({ name, type: "run", output });
      return output as T;
    },

    async sleep(name: string, _duration: Duration): Promise<void> {
      state.steps.push({ name, type: "sleep" });
    },

    async sleepUntil(name: string, _until: Date | string): Promise<void> {
      state.steps.push({ name, type: "sleep" });
    },

    async waitForEvent<T = unknown>(
      name: string,
      filter: EventFilter
    ): Promise<IronflowEvent<T>> {
      const events = registries.eventQueue.get(filter.event);
      if (!events || events.length === 0) {
        throw new Error(
          `step.waitForEvent("${name}") is waiting for "${filter.event}" ` +
            `but no events were pre-registered. ` +
            `Use t.sendEvent("${filter.event}", data) before calling t.emit().`
        );
      }
      const data = events.shift()!;
      const event: IronflowEvent<T> = {
        id: `test-evt-${Date.now()}`,
        name: filter.event,
        version: 1,
        data: data as T,
        timestamp: new Date(),
      };
      state.steps.push({ name, type: "waitForEvent", output: event });
      return event;
    },

    async parallel<T extends unknown[]>(
      _name: string,
      branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
      _options?: ParallelOptions
    ): Promise<T> {
      const results: unknown[] = [];
      for (const branch of branches as ((step: StepClient) => Promise<unknown>)[]) {
        const result = await branch(stepClient);
        results.push(result);
      }
      return results as T;
    },

    async map<T, R>(
      _name: string,
      items: T[],
      fn: (item: T, step: StepClient, index: number) => Promise<R>,
      _options?: ParallelOptions
    ): Promise<R[]> {
      const results: R[] = [];
      for (let i = 0; i < items.length; i++) {
        const result = await fn(items[i]!, stepClient, i);
        results.push(result);
      }
      return results;
    },

    compensate(stepName: string, fn: () => Promise<void>): void {
      state.compensations.push({ stepName, fn });
    },

    async invoke<T = unknown>(
      functionId: string,
      input?: unknown,
      _options?: { timeout?: string }
    ): Promise<T> {
      const mock = registries.invokeMocks.get(functionId);
      if (!mock) {
        throw new Error(
          `step.invoke("${functionId}") was called but has no mock. ` +
            `Use t.mockInvoke("${functionId}", fn) to provide one.`
        );
      }
      const output = await Promise.resolve(mock(input));
      state.steps.push({ name: functionId, type: "invoke", output });
      return output as T;
    },

    async invokeAsync(
      functionId: string,
      input?: unknown
    ): Promise<{ runId: string }> {
      const mock = registries.invokeMocks.get(functionId);
      if (!mock) {
        throw new Error(
          `step.invokeAsync("${functionId}") was called but has no mock. ` +
            `Use t.mockInvoke("${functionId}", fn) to provide one.`
        );
      }
      await Promise.resolve(mock(input));
      const runId = `test-run-${Date.now()}`;
      state.steps.push({ name: functionId, type: "invoke", output: { runId } });
      return { runId };
    },

    async publish(_topic: string, _data: unknown): Promise<PublishResult> {
      return { eventId: `test-msg-${Date.now()}`, sequence: 0 };
    },
  };

  return stepClient;
}
