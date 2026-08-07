import { describe, it, expect } from "vitest";
import {
  webhookVerifyConfigToWire,
  webhookVerifyConfigFromWire,
  type WebhookVerifyConfig,
} from "./types.js";

// The twelve descriptor fields. A converter that drops one silently strips
// part of the signature scheme, and the delivery then fails with "invalid
// signature" pointing at nothing.
const FULL: Required<WebhookVerifyConfig> = {
  signatureHeader: "Stripe-Signature",
  entrySeparator: ",",
  kvDelimiter: "=",
  signatureKey: "v1",
  timestampHeader: "X-Slack-Request-Timestamp",
  timestampKey: "t",
  signingTemplate: "{ts}.{body}",
  encoding: "hex",
  algorithm: "hmac-sha256",
  toleranceSeconds: 300,
  eventNamePath: "body:type",
  dedupIdPath: "body:id",
};

const WIRE_KEYS = [
  "signature_header",
  "entry_separator",
  "kv_delimiter",
  "signature_key",
  "timestamp_header",
  "timestamp_key",
  "signing_template",
  "encoding",
  "algorithm",
  "tolerance_seconds",
  "event_name_path",
  "dedup_id_path",
];

describe("webhookVerifyConfigToWire", () => {
  it("emits every field in snake_case", () => {
    const wire = webhookVerifyConfigToWire(FULL)!;
    expect(Object.keys(wire).sort()).toEqual([...WIRE_KEYS].sort());
    expect(wire).toEqual({
      signature_header: "Stripe-Signature",
      entry_separator: ",",
      kv_delimiter: "=",
      signature_key: "v1",
      timestamp_header: "X-Slack-Request-Timestamp",
      timestamp_key: "t",
      signing_template: "{ts}.{body}",
      encoding: "hex",
      algorithm: "hmac-sha256",
      tolerance_seconds: 300,
      event_name_path: "body:type",
      dedup_id_path: "body:id",
    });
  });

  // Not because the server demands it — the codec unmarshals with
  // DiscardUnknown and would accept an absent field — but because emitting a
  // stable twelve-key shape keeps the request identical whether a field was
  // cleared or never set.
  it("sends zero values, not undefined, for omitted optionals", () => {
    const wire = webhookVerifyConfigToWire({
      signatureHeader: "X-Hub-Signature-256",
      signingTemplate: "{body}",
      encoding: "hex",
      algorithm: "hmac-sha256",
    })!;
    expect(Object.keys(wire).sort()).toEqual([...WIRE_KEYS].sort());
    expect(wire.entry_separator).toBe("");
    expect(wire.tolerance_seconds).toBe(0);
    expect(Object.values(wire).some((v) => v === undefined)).toBe(false);
  });

  it("omits the descriptor entirely when there is none", () => {
    expect(webhookVerifyConfigToWire(undefined)).toBeUndefined();
  });
});

describe("webhookVerifyConfigFromWire", () => {
  it("reads every field back", () => {
    const back = webhookVerifyConfigFromWire(webhookVerifyConfigToWire(FULL));
    expect(back).toEqual(FULL);
  });

  it("round-trips through the wire without loss", () => {
    const once = webhookVerifyConfigToWire(FULL);
    const twice = webhookVerifyConfigToWire(webhookVerifyConfigFromWire(once));
    expect(twice).toEqual(once);
  });

  // The server marshals with EmitUnpopulated: false, so it OMITS unset fields
  // rather than sending ""/0. The converter normalizes both shapes defensively;
  // surfacing "" to a caller would make an unset field look
  // configured-as-empty.
  it("normalises the server's zero values to undefined", () => {
    const back = webhookVerifyConfigFromWire({
      signature_header: "X-Hub-Signature-256",
      entry_separator: "",
      kv_delimiter: "",
      signature_key: "",
      timestamp_header: "",
      timestamp_key: "",
      signing_template: "{body}",
      encoding: "hex",
      algorithm: "hmac-sha256",
      tolerance_seconds: 0,
      event_name_path: "",
      dedup_id_path: "",
    })!;
    expect(back.entrySeparator).toBeUndefined();
    expect(back.toleranceSeconds).toBeUndefined();
    // The required three stay strings even when empty.
    expect(back.signatureHeader).toBe("X-Hub-Signature-256");
    expect(back.signingTemplate).toBe("{body}");
  });

  it("returns undefined for an absent descriptor", () => {
    expect(webhookVerifyConfigFromWire(undefined)).toBeUndefined();
  });

  // Responses are snake_case on every transport (UseProtoNames=true), so a
  // camelCase payload is not a shape this has to accept — pinned so nobody
  // "fixes" it by adding a camel fallback the server never sends.
  it("does not read camelCase keys", () => {
    const back = webhookVerifyConfigFromWire({ signatureHeader: "Nope" })!;
    expect(back.signatureHeader).toBe("");
  });
});
