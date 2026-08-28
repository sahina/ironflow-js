import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDefined } from "../internal/assert-defined.js";
import { WebSocketTransport } from "./websocket.js";

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

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocketTransport authentication", () => {
  it("keeps the credential out of the URL and passes it as subprotocol metadata", async () => {
    const transport = new WebSocketTransport("https://ironflow.example.com", {
      auth: { apiKey: "ifkey/browser+unsafe" },
      autoReconnect: false,
      reconnectDelay: 1,
      maxReconnectDelay: 1,
      reconnectBackoff: 1,
      environment: "production",
    });

    const connecting = transport.connect();
    const socket = assertDefined(MockWebSocket.instances[0]);

    expect(socket.url).toBe("wss://ironflow.example.com/ws?env=production");
    expect(socket.url).not.toContain("ifkey");
    expect(socket.protocols).toEqual([
      "ironflow.v1",
      "ironflow.auth.bearer.aWZrZXkvYnJvd3Nlcit1bnNhZmU",
    ]);

    socket.open();
    await connecting;
    transport.disconnect();
  });
});
