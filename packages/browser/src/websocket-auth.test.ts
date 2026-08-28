import { describe, expect, it } from "vitest";
import {
  IRONFLOW_WEBSOCKET_PROTOCOL,
  webSocketProtocols,
} from "./websocket-auth.js";

describe("webSocketProtocols", () => {
  it("offers only the stable protocol without a credential", () => {
    expect(webSocketProtocols()).toEqual([IRONFLOW_WEBSOCKET_PROTOCOL]);
  });

  it("carries a UTF-8 credential as unpadded base64url metadata", () => {
    const credential = "ifkey_ümlaut/with+a=query?";
    const protocols = webSocketProtocols(credential);

    expect(protocols[0]).toBe(IRONFLOW_WEBSOCKET_PROTOCOL);
    expect(protocols[1]).toMatch(/^ironflow\.auth\.bearer\.[A-Za-z0-9_-]+$/);
    expect(protocols.join(",")).not.toContain(credential);
  });
});
