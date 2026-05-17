/**
 * Base64 helpers — LangGraph's serde returns Uint8Array for serialized
 * checkpoints/metadata/writes, but Ironflow's AppendEvent payload is JSON.
 * Encode bytes as base64 strings on write; decode back to bytes on read.
 */

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
