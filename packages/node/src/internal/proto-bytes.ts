/**
 * Helpers for proto `bytes` fields on the ConnectRPC surface.
 *
 * IronflowService runs on Connect's default protojson codec, which carries a
 * `bytes` field as a **base64 string** — not as raw JSON. Ironflow stores JSON
 * payloads inside bytes fields on the scoped-injection RPCs
 * (`PausedStepInfo.output`, `InjectStepOutputRequest.new_output`,
 * `InjectStepOutputResponse.previous_output`), so the payload has to be
 * base64-encoded on the way out and decoded on the way back.
 *
 * Sending raw JSON text is rejected by protojson *before the handler runs*
 * ("invalid value for bytes field"), and reading a response without decoding
 * hands the caller a base64 string where an object was promised. See #1919.
 */

/**
 * Encode a JSON-serializable value for a proto `bytes` field.
 *
 * `null` is a valid JSON document and is encoded as such — collapsing it to an
 * empty field would persist a zero-length byte slice the server accepts and
 * stores as an unparseable step output. Only `undefined` means "no value".
 */
export function encodeProtoBytes(value: unknown): string {
  if (value === undefined) return "";
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decode a proto `bytes` field carrying a JSON payload. */
export function decodeProtoBytes(encoded: string | undefined | null): unknown {
  if (!encoded) return null;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
