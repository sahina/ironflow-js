import { describe, it, expect } from "vitest";
import {
  webhookVerifyConfigToWire,
  webhookVerifyConfigFromWire,
  webhookSourceFromWire,
  webhookDeliveryFromWire,
  webhookGraceToWire,
  WEBHOOK_SECRET_GRACE_CAP_SECONDS,
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

describe("webhookSourceFromWire", () => {
  // Every WebhookService RPC that returns a source returns this same message,
  // so one mapper covers all seven. Anything it drops is dropped everywhere.
  it("reads every field the server sends", () => {
    const s = webhookSourceFromWire({
      id: "wh_1",
      name: "Stripe",
      event_prefix: "stripe.",
      verify_header: "Stripe-Signature",
      verify_algorithm: "sha256",
      source_type: "api",
      metadata: { team: "payments" },
      verify_secret_set: true,
      verify_secret_prev_set: true,
      verify_secret_prev_expires_at: "2026-03-29T00:00:00Z",
      ingest_token_prefix: "ifwh_1a2b3c4d",
      ingest_token: "ifwh_raw",
      verify_config: { signature_header: "Stripe-Signature", signing_template: "{ts}.{body}" },
      created_at: "2026-03-28T00:00:00Z",
      updated_at: "2026-03-28T01:00:00Z",
    });

    expect(s).toMatchObject({
      id: "wh_1",
      name: "Stripe",
      eventPrefix: "stripe.",
      verifyHeader: "Stripe-Signature",
      verifyAlgorithm: "sha256",
      sourceType: "api",
      metadata: { team: "payments" },
      verifySecretSet: true,
      verifySecretPrevSet: true,
      verifySecretPrevExpiresAt: "2026-03-29T00:00:00Z",
      ingestTokenPrefix: "ifwh_1a2b3c4d",
      ingestToken: "ifwh_raw",
      createdAt: "2026-03-28T00:00:00Z",
      updatedAt: "2026-03-28T01:00:00Z",
    });
    expect(s.verifyConfig?.signingTemplate).toBe("{ts}.{body}");
  });

  // Same pin as the descriptor mapper: the server never sends camelCase, and a
  // fallback would paper over a wire change instead of surfacing it.
  it("does not read camelCase keys", () => {
    const s = webhookSourceFromWire({ id: "wh_1", eventPrefix: "stripe." });
    expect(s.eventPrefix).toBe("");
  });

  it("survives a sparse payload", () => {
    const s = webhookSourceFromWire({ id: "wh_1" });
    expect(s).toEqual({
      id: "wh_1",
      name: undefined,
      eventPrefix: "",
      verifyHeader: undefined,
      verifyAlgorithm: undefined,
      sourceType: undefined,
      metadata: undefined,
      verifySecretSet: undefined,
      verifySecretPrevSet: undefined,
      verifySecretPrevExpiresAt: undefined,
      ingestTokenPrefix: undefined,
      ingestToken: undefined,
      verifyConfig: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
  });
});

describe("webhookDeliveryFromWire", () => {
  it("reads every field the server sends", () => {
    expect(
      webhookDeliveryFromWire({
        id: "del-1",
        source_id: "wh_1",
        external_id: "evt_ext",
        status: "delivered",
        event_id: "evt-123",
        error: "",
        signature_key: "prev",
        created_at: "2026-03-28T00:00:00Z",
      })
    ).toEqual({
      id: "del-1",
      sourceId: "wh_1",
      externalId: "evt_ext",
      status: "delivered",
      eventId: "evt-123",
      error: undefined,
      signatureKey: "prev",
      createdAt: "2026-03-28T00:00:00Z",
    });
  });

  it("does not read camelCase keys", () => {
    expect(webhookDeliveryFromWire({ id: "del-1", sourceId: "wh_1" }).sourceId).toBe("");
  });
});

describe("webhookGraceToWire", () => {
  // Tri-state: absent key, explicit 0, explicit N. Collapsing any two of these
  // changes how long a rotated-out secret keeps verifying.
  it("omits the key entirely when unset, so the server default wins", () => {
    expect(webhookGraceToWire(undefined)).toEqual({});
  });

  it("preserves an explicit 0 (instant cutover)", () => {
    expect(webhookGraceToWire(0)).toEqual({ grace_seconds: 0 });
  });

  it("passes through an in-range value", () => {
    expect(webhookGraceToWire(3600)).toEqual({ grace_seconds: 3600 });
    expect(webhookGraceToWire(WEBHOOK_SECRET_GRACE_CAP_SECONDS)).toEqual({
      grace_seconds: WEBHOOK_SECRET_GRACE_CAP_SECONDS,
    });
  });

  // JSON.stringify(NaN) is `null`, protojson reads null as unset, and the
  // server then applies its 24 h default — so an unguarded NaN silently does
  // the opposite of whatever the caller intended.
  it("rejects non-finite values instead of letting them reach the wire", () => {
    expect(JSON.stringify({ grace_seconds: NaN })).toBe('{"grace_seconds":null}');
    for (const bad of [NaN, Infinity, -Infinity, 1.5]) {
      expect(() => webhookGraceToWire(bad)).toThrow(RangeError);
    }
  });

  it("rejects out-of-range values the server would reject anyway", () => {
    expect(() => webhookGraceToWire(-1)).toThrow(RangeError);
    expect(() => webhookGraceToWire(WEBHOOK_SECRET_GRACE_CAP_SECONDS + 1)).toThrow(RangeError);
  });
});
