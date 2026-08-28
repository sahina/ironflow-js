/** Stable application protocol offered by Ironflow WebSocket clients. */
export const IRONFLOW_WEBSOCKET_PROTOCOL = "ironflow.v1";

const WEBSOCKET_AUTH_PROTOCOL_PREFIX = "ironflow.auth.bearer.";

/**
 * Build WebSocket subprotocols without putting the bearer credential in the URL.
 *
 * The server negotiates only `ironflow.v1`. The credential-bearing protocol is
 * request metadata for the authentication middleware and is never echoed in the
 * upgrade response.
 */
export function webSocketProtocols(credential?: string): string[] {
  const protocols = [IRONFLOW_WEBSOCKET_PROTOCOL];
  if (credential) {
    protocols.push(
      `${WEBSOCKET_AUTH_PROTOCOL_PREFIX}${encodeBase64Url(credential)}`,
    );
  }
  return protocols;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
