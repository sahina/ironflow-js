import { create } from "@bufbuild/protobuf";
import { ConnectError, Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventMetadataSchema,
  SubscriptionEventSchema,
} from "@ironflow/core/gen";
import type { TransportCallbacks, TransportOptions } from "./types.js";
import { assertDefined } from "../internal/assert-defined.js";

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

const callbacks: TransportCallbacks = {
  onEvent: vi.fn(),
  onError: vi.fn(),
  onConnectionChange: vi.fn(),
  onSubscribed: vi.fn(),
  onSubscribeFailed: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectRPCTransport resume cursor", () => {
  it("restores identifying options without replaying the initial window", async () => {
    let call = 0;
    mocks.subscribe.mockImplementation(() => {
      call++;
      if (call === 1) {
        return (async function* () {
          yield create(SubscriptionEventSchema, {
            subscriptionId: "sub-1",
            eventId: "event-1",
            topic: "orders.created",
            sequence: 1n,
            metadata: create(EventMetadataSchema, {}),
          });
          throw new ConnectError("transport dropped", Code.Unavailable);
        })();
      }
      return (async function* () {})();
    });

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", {
      replay: 25,
      includeMetadata: true,
      filter: "data.total > 100",
      namespace: "production",
      consumerGroup: "processors",
      ackMode: "manual",
      backpressure: "block",
    });

    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    const initial = assertDefined(mocks.subscribe.mock.calls[0])[0];
    expect(initial.options.replay).toBe(25);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

    const reconnect = assertDefined(mocks.subscribe.mock.calls[1])[0];
    expect(reconnect.options).toMatchObject({
      includeMetadata: initial.options.includeMetadata,
      filter: initial.options.filter,
      namespace: initial.options.namespace,
      consumerGroup: initial.options.consumerGroup,
      ackMode: initial.options.ackMode,
      backpressure: initial.options.backpressure,
    });
    expect(reconnect.options.replay).toBe(0);
  });

  it("preserves replay until a cursor request is accepted", async () => {
    let call = 0;
    mocks.subscribe.mockImplementation(() => {
      call++;
      if (call === 1) {
        return (async function* () {
          throw new ConnectError("transport dropped", Code.Unavailable);
        })();
      }
      return (async function* () {
        throw new ConnectError(
          "replay and start_after_sequence are mutually exclusive",
          Code.InvalidArgument,
        );
      })();
    });

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", {
      replay: 25,
      startAfterSequence: 400,
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
    const retry = assertDefined(mocks.subscribe.mock.calls[1])[0];
    expect(retry.options.replay).toBe(25);
    expect(retry.options.startAfterSequence).toBe(400n);
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("re-anchors a reconnect after the last delivered event", async () => {
    let call = 0;
    mocks.subscribe.mockImplementation(() => {
      call++;
      if (call === 1) {
        return (async function* () {
          yield create(SubscriptionEventSchema, {
            subscriptionId: "sub-1",
            eventId: "event-405",
            topic: "orders.created",
            sequence: 405n,
            metadata: create(EventMetadataSchema, {}),
          });
          throw new ConnectError("transport dropped", Code.Unavailable);
        })();
      }
      return (async function* () {})();
    });

    const transport = new ConnectRPCTransport("http://localhost:9123", {
      ...options,
      autoReconnect: false,
    });
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", { startAfterSequence: 400 });

    await vi.waitFor(() => expect(callbacks.onEvent).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

    const reconnectRequest = assertDefined(mocks.subscribe.mock.calls[1])[0];
    expect(reconnectRequest.options.startAfterSequence).toBe(405n);
    expect(reconnectRequest.options.replay).toBe(0);
  });

  it("reports a permanent cursor rejection without reconnecting", async () => {
    mocks.subscribe.mockImplementation(() =>
      (async function* () {
        throw new ConnectError(
          "replay and start_after_sequence are mutually exclusive",
          Code.InvalidArgument,
        );
      })(),
    );

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", {
      replay: 25,
      startAfterSequence: 400,
    });

    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledTimes(1));
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        code: String(Code.InvalidArgument),
        retrying: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(transport.connectionState).toBe("connected");

    transport.pause();
    transport.resume();
    await vi.waitFor(() => expect(transport.connectionState).toBe("connected"));
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("aborts healthy streams before starting transport-wide replacements", async () => {
    let dropFirst!: () => void;
    const firstFailure = new Promise<void>((resolve) => {
      dropFirst = resolve;
    });
    let healthySignal: AbortSignal | undefined;
    let call = 0;
    mocks.subscribe.mockImplementation(
      (_request: unknown, streamOptions?: { signal?: AbortSignal }) => {
        call++;
        if (call === 1) {
          return (async function* () {
            await firstFailure;
            throw new ConnectError("transport dropped", Code.Unavailable);
          })();
        }
        if (call === 2) {
          healthySignal = streamOptions?.signal;
          return (async function* () {
            await new Promise<void>((resolve) => {
              healthySignal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          })();
        }
        return (async function* () {})();
      },
    );

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", { startAfterSequence: 400 });
    transport.subscribe("payments.*", { startAfterSequence: 800 });
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

    dropFirst();
    await vi.waitFor(() => expect(healthySignal?.aborted).toBe(true));
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(4));
  });

  it("keeps every subscription when streams fail concurrently", async () => {
    let dropStreams!: () => void;
    const outage = new Promise<void>((resolve) => {
      dropStreams = resolve;
    });
    let call = 0;
    mocks.subscribe.mockImplementation(() => {
      call++;
      if (call <= 2) {
        return (async function* () {
          await outage;
          throw new ConnectError("transport dropped", Code.Unavailable);
        })();
      }
      return (async function* () {})();
    });

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", { startAfterSequence: 400 });
    transport.subscribe("payments.*", { startAfterSequence: 800 });
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

    dropStreams();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(4));
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("reconnects from an exact uint64 sequence", async () => {
    const sequence = 9_007_199_254_740_995n;
    let call = 0;
    mocks.subscribe.mockImplementation(() => {
      call++;
      if (call === 1) {
        return (async function* () {
          yield create(SubscriptionEventSchema, {
            subscriptionId: "sub-1",
            eventId: "event-large",
            topic: "orders.created",
            sequence,
            metadata: create(EventMetadataSchema, {}),
          });
          throw new ConnectError("transport dropped", Code.Unavailable);
        })();
      }
      return (async function* () {})();
    });

    const transport = new ConnectRPCTransport("http://localhost:9123", options);
    transport.setCallbacks(callbacks);
    await transport.connect();
    transport.subscribe("orders.*", { startAfterSequence: 400n });

    await vi.waitFor(() => expect(callbacks.onEvent).toHaveBeenCalledTimes(1));
    expect(callbacks.onEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({ sequenceExact: sequence.toString() }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));

    expect(mocks.subscribe.mock.calls[1]![0].options.startAfterSequence).toBe(
      sequence,
    );
  });
});
