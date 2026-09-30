import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "./websocket.js";
import type { TransportCallbacks, TransportOptions } from "./types.js";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

const options: TransportOptions = {
  autoReconnect: false,
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
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function connected(): Promise<{ transport: WebSocketTransport; ws: MockWebSocket }> {
  const transport = new WebSocketTransport("http://localhost:9123", options);
  transport.setCallbacks(callbacks);
  const connecting = transport.connect();
  const ws = MockWebSocket.instances[0]!;
  ws.open();
  await connecting;
  return { transport, ws };
}

describe("WebSocketTransport ack frame", () => {
  it("carries the subscription ID and, for nak, the delay", async () => {
    const { transport, ws } = await connected();

    await transport.ack("evt-1", "nak", 500, "sub-9");

    expect(JSON.parse(ws.send.mock.calls.at(-1)![0] as string)).toEqual({
      type: "ack",
      eventId: "evt-1",
      ackType: "nak",
      subscriptionId: "sub-9",
      redeliverDelay: 500,
    });
  });

  it("omits subscriptionId when none is given", async () => {
    const { transport, ws } = await connected();

    await transport.ack("evt-2", "term");

    expect(JSON.parse(ws.send.mock.calls.at(-1)![0] as string)).toEqual({
      type: "ack",
      eventId: "evt-2",
      ackType: "term",
    });
  });
});
