const STABLE_PROTOCOL = "ironflow.v1";
const BEARER_PROTOCOL_PREFIX = "ironflow.auth.bearer.";

/** Build WebSocket protocols without placing credentials in the URL. */
export function webSocketProtocols(credential?: string): string[] {
  if (!credential) return [STABLE_PROTOCOL];
  return [STABLE_PROTOCOL, `${BEARER_PROTOCOL_PREFIX}${Buffer.from(credential, "utf8").toString("base64url")}`];
}
