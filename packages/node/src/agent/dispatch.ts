/**
 * Inbound callback handler for Ironflow → SDK agent-tool dispatch.
 *
 * The Ironflow server's `agent_tools.Dispatcher` POSTs an HMAC-signed
 * request to `${callbackUrl}` (the user's serve() mount). serve() routes
 * `/ironflow/agent-tools/dispatch` here. We:
 *
 *   1. Verify HMAC + replay window (5min past, 1min future).
 *   2. Look up the qualified tool in the local registry.
 *   3. Validate input against the McpToolDef Zod schema.
 *   4. Run the handler, mapping success → {output} and any throw →
 *      {error:{code:"HANDLER_ERROR", message}} (200 with envelope so the
 *      Go dispatcher decodes it as a tool error instead of a transport
 *      failure — see internal/agent_tools/dispatcher.go:182).
 *
 *	 server                            SDK serve()
 *	   │  POST /…/dispatch              │
 *	   │ X-Ironflow-Timestamp: <unix>   │
 *	   │ X-Ironflow-Signature: sha256=… │
 *	   │ body: {qualified_name, input}  │
 *	   │  ─────────────────────────────▶│
 *	   │                                │ verify HMAC
 *	   │                                │ lookupLocal()
 *	   │                                │ Zod parse(input)
 *	   │                                │ def.handler(input)
 *	   │                                │
 *	   │ 200 {output} | 200 {error} |   │
 *	   │ 401 sig | 400 schema           │
 *	   │ ◀───────────────────────────── │
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { lookupLocal } from "./internal-registry.js";

const HEADER_SIGNATURE = "x-ironflow-signature";
const HEADER_TIMESTAMP = "x-ironflow-timestamp";
const SIGNATURE_PREFIX = "sha256=";

const REPLAY_WINDOW_SEC = 5 * 60;
const FUTURE_SKEW_SEC = 60;

/** Path served on the user's serve() mount. */
export const DISPATCH_PATH = "/ironflow/agent-tools/dispatch";

interface DispatchEnvelope {
  output?: unknown;
  error?: { code: string; message: string };
}

interface DispatchPayload {
  qualified_name?: unknown;
  input?: unknown;
}

interface DispatchResult {
  status: number;
  body: DispatchEnvelope;
}

interface MinimalRequest {
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

/**
 * Process an inbound dispatch request. Returns status + body envelope —
 * the caller (serve()) is responsible for serializing.
 */
export async function handleAgentToolDispatch(
  request: MinimalRequest
): Promise<DispatchResult> {
  const rawBody = await request.text();
  const sigHeader = request.headers.get(HEADER_SIGNATURE);
  const tsHeader = request.headers.get(HEADER_TIMESTAMP);

  if (!sigHeader || !tsHeader) {
    return errorResponse(401, "SIGNATURE_MISMATCH", "missing HMAC headers");
  }
  if (!sigHeader.startsWith(SIGNATURE_PREFIX)) {
    return errorResponse(401, "SIGNATURE_MISMATCH", "invalid signature format");
  }

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) {
    return errorResponse(401, "TIMESTAMP_SKEW", "invalid timestamp");
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > REPLAY_WINDOW_SEC) {
    return errorResponse(401, "TIMESTAMP_SKEW", "request timestamp too old");
  }
  if (ts - now > FUTURE_SKEW_SEC) {
    return errorResponse(401, "TIMESTAMP_SKEW", "request timestamp too far in future");
  }

  let payload: DispatchPayload;
  try {
    payload = JSON.parse(rawBody) as DispatchPayload;
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "callback body is not valid JSON");
  }

  const qualifiedName =
    typeof payload.qualified_name === "string" ? payload.qualified_name : "";
  if (!qualifiedName) {
    return errorResponse(400, "INVALID_REQUEST", "qualified_name missing");
  }

  const entry = lookupLocal(qualifiedName);
  if (!entry) {
    console.warn(
      `ironflow.agent.dispatch unknown_tool qualified_name=${JSON.stringify(qualifiedName)}`
    );
    return errorResponse(401, "SIGNATURE_MISMATCH", "HMAC mismatch");
  }

  if (!verifyHmac(rawBody, ts, sigHeader.slice(SIGNATURE_PREFIX.length), entry.hmacSecret)) {
    return errorResponse(401, "SIGNATURE_MISMATCH", "HMAC mismatch");
  }

  const parseResult = entry.def.input.safeParse(payload.input);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return errorResponse(400, "INPUT_SCHEMA_INVALID", issues);
  }

  try {
    const output = await entry.def.handler(parseResult.data);
    return { status: 200, body: { output } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 200, body: { error: { code: "HANDLER_ERROR", message } } };
  }
}

function errorResponse(status: number, code: string, message: string): DispatchResult {
  return { status, body: { error: { code, message } } };
}

/**
 * verifyHmac is exported for cross-language vector parity tests
 * (testdata/hmac_vectors.json, issue #595 S8). It is NOT part of the
 * public @ironflow/node/agent surface — production callers reach it
 * via handleAgentToolDispatch().
 */
export function verifyHmac(
  rawBody: string,
  ts: number,
  receivedHex: string,
  secretHex: string
): boolean {
  // Buffer.from(..., "hex") silently truncates at the first non-hex char
  // instead of throwing. Validate explicitly so a malformed secret/sig
  // can't quietly produce a partial buffer that passes timingSafeEqual.
  if (!isHex(secretHex) || !isHex(receivedHex)) {
    return false;
  }
  const secretBuf = Buffer.from(secretHex, "hex");
  const expectedHex = createHmac("sha256", secretBuf)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (receivedBuf.length !== expectedBuf.length || receivedBuf.length === 0) {
    return false;
  }
  return timingSafeEqual(receivedBuf, expectedBuf);
}

function isHex(s: string): boolean {
  return s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}
