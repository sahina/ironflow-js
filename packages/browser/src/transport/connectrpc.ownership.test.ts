import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TransportOptions } from "./types.js";
import { SubscriptionManager } from "../subscription.js";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }));

vi.mock("@connectrpc/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@connectrpc/connect")>();
  return {
    ...actual,
    createClient: vi.fn(() => ({ subscribe: mocks.subscribe })),
  };
});

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}));

import { ConnectRPCTransport } from "./connectrpc.js";

const options: TransportOptions = {
  autoReconnect: true,
  reconnectDelay: 1,
  maxReconnectDelay: 1,
  reconnectBackoff: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockImplementation((_request, { signal }: { signal: AbortSignal }) => (async function* () {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  })());
});
afterEach(() => vi.restoreAllMocks());

it("keeps duplicate ConnectRPC streams, options and abort signals independent across resume", async () => {
  const transport = new ConnectRPCTransport("http://localhost:9123", options);
  const manager = new SubscriptionManager(transport, false);
  const first = await manager.subscribe("orders.*", { replay: 3 });
  const second = await manager.subscribe("orders.*", { replay: 7 });
  expect(first.id).not.toBe(second.id);
  expect(mocks.subscribe.mock.calls.map(([request]) => request.options.replay)).toEqual([3, 7]);
  const initialSignals = mocks.subscribe.mock.calls.map(([, opts]) => opts.signal as AbortSignal);
  manager.pause();
  expect(initialSignals.every((signal) => signal.aborted)).toBe(true);
  const pending = manager.subscribe("orders.*", { replay: 11 });
  manager.resume();
  const third = await pending;
  expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  expect(manager.activeSubscriptionCount).toBe(3);
  expect(mocks.subscribe.mock.calls.map(([request]) => request.options.replay)).toEqual([3, 7, 3, 7, 11]);
  const resumedSignals = mocks.subscribe.mock.calls.slice(2).map(([, opts]) => opts.signal as AbortSignal);
  first.unsubscribe();
  expect(resumedSignals.map((signal) => signal.aborted)).toEqual([true, false, false]);
  second.unsubscribe(); third.unsubscribe();
  expect(resumedSignals.every((signal) => signal.aborted)).toBe(true);
  manager.disconnect();
});
