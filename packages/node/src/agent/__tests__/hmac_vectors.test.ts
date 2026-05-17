import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerLocal, unregisterLocal } from "../internal-registry.js";
import { handleAgentToolDispatch, verifyHmac } from "../dispatch.js";
import { z } from "zod";

interface HmacVector {
  name: string;
  description: string;
  secret_hex: string;
  timestamp: number;
  body: string;
  expected_signature: string;
}

interface HmacVectorFile {
  version: number;
  vectors: HmacVector[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
// here = .../sdk/js/node/src/agent/__tests__
// repo root is 6 levels up.
const vectorsPath = path.resolve(here, "..", "..", "..", "..", "..", "..", "testdata", "hmac_vectors.json");
const vf: HmacVectorFile = JSON.parse(readFileSync(vectorsPath, "utf8"));

describe("HMAC vectors — cross-SDK parity (#595 S8)", () => {
  it("loaded supported vectors file", () => {
    expect(vf.version).toBe(1);
    expect(vf.vectors.length).toBeGreaterThan(0);
  });

  // The JS sign side is exercised here: compute HMAC the same way
  // dispatch.ts verifies, then assert it matches the Go-generated
  // expected_signature. Drift in the canonical payload format would
  // surface here first.
  for (const v of vf.vectors) {
    it(`signs vector "${v.name}" identically to the shared expectation`, () => {
      const secret = Buffer.from(v.secret_hex, "hex");
      const sig =
        "sha256=" +
        createHmac("sha256", secret)
          .update(`${v.timestamp}.${v.body}`)
          .digest("hex");
      expect(sig).toBe(v.expected_signature);
    });
  }

  // Production verifyHmac (exported from dispatch.ts) accepts each
  // vector's exact (ts, body, signature, secret) tuple. Catches drift
  // between the JS sign side (above) and JS verify side (production)
  // that would otherwise pass round-trip but reject Go-signed bytes.
  for (const v of vf.vectors) {
    it(`dispatch.ts verifyHmac accepts vector "${v.name}" verbatim`, () => {
      expect(v.expected_signature.startsWith("sha256=")).toBe(true);
      const receivedHex = v.expected_signature.slice("sha256=".length);
      expect(verifyHmac(v.body, v.timestamp, receivedHex, v.secret_hex)).toBe(true);
    });
  }

  // Tamper guard: flipping the last hex char of the expected signature
  // must cause verifyHmac to reject. Catches non-constant-time
  // comparison bugs that pass round-trip but accept near-misses.
  for (const v of vf.vectors) {
    it(`dispatch.ts verifyHmac rejects tampered signature for "${v.name}"`, () => {
      const receivedHex = v.expected_signature.slice("sha256=".length);
      const last = receivedHex[receivedHex.length - 1];
      const tampered = receivedHex.slice(0, -1) + (last === "0" ? "1" : "0");
      expect(verifyHmac(v.body, v.timestamp, tampered, v.secret_hex)).toBe(false);
    });
  }

  // Verify side: register a per-vector qualified name in the local
  // registry so concurrent vitest iterations don't race on the global
  // registry (clearLocalForTests would otherwise wipe a sibling's
  // registration). POST a synthetic dispatch signed with the vector's
  // secret + a fresh timestamp; the handler accepts it (200 + envelope).
  // This proves dispatch.ts treats the vector secret correctly; the
  // signature-bytes parity is asserted by the sign loop above.
  for (const v of vf.vectors) {
    it(`dispatch.ts verifies vector "${v.name}" via the production handler`, async () => {
      const agentName = `vec_${v.name}`;
      const toolName = "echo";
      const qualifiedName = `${agentName}.${toolName}`;
      try {
        registerLocal({
          agentName,
          qualifiedName,
          hmacSecret: v.secret_hex,
          def: {
            name: toolName,
            description: "",
            input: z.object({}).passthrough(),
            handler: async () => ({ ok: true }),
          },
        });

        const ts = Math.floor(Date.now() / 1000);
        const body = JSON.stringify({ qualified_name: qualifiedName, input: {} });
        const sig =
          "sha256=" +
          createHmac("sha256", Buffer.from(v.secret_hex, "hex"))
            .update(`${ts}.${body}`)
            .digest("hex");

        const result = await handleAgentToolDispatch({
          text: async () => body,
          headers: {
            get: (name: string) => {
              if (name.toLowerCase() === "x-ironflow-timestamp") return String(ts);
              if (name.toLowerCase() === "x-ironflow-signature") return sig;
              return null;
            },
          },
        });
        expect(result.status).toBe(200);
        expect(result.body.error).toBeUndefined();
      } finally {
        unregisterLocal(agentName);
      }
    });
  }
});
