import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../client.js";

// One condition, one code on every transport (#3054, #3066): the lowercase
// Connect code. Before, request() dropped the body, so a Connect not_found
// reached the caller as UNKNOWN_ERROR.

const reply = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers(),
      statusText: "",
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    })
  );

const noRetry = { retry: { maxAttempts: 1 } };
const caught = (p: Promise<unknown>) => p.catch((e: unknown) => e as { code: string; status?: number; retryable: boolean });

describe("error codes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("request() (Connect) answers not_found", async () => {
    reply(404, { code: "not_found", message: "run not found" });
    const err = await caught(createClient(noRetry).getRun("run_x"));
    expect(err).toMatchObject({ code: "not_found", status: 404, retryable: false });
  });

  it("restRequest() (REST) answers not_found", async () => {
    reply(404, { error: "no such worker", message: "no such worker", code: "not_found", retryable: false });
    const err = await caught(createClient(noRetry).apiKeys.get("key_x"));
    expect(err).toMatchObject({ code: "not_found", status: 404, retryable: false });
  });

  it("restRequest() names a code-less 404 not_found, not UNKNOWN_ERROR", async () => {
    reply(404, { error: "no such worker" });
    const err = await caught(createClient(noRetry).apiKeys.get("key_x"));
    expect(err).toMatchObject({ code: "not_found", status: 404 });
  });

  // retryable: a non-retryable and a retryable Connect code, over the one path
  // every call shares.
  it("a non-retryable Connect code stays retryable=false", async () => {
    reply(400, { code: "invalid_argument", message: "bad input" });
    expect(await caught(createClient(noRetry).getRun("run_x"))).toMatchObject({ code: "invalid_argument", retryable: false });
  });

  it("a retryable Connect code stays retryable=true", async () => {
    reply(503, { code: "unavailable", message: "engine restarting" });
    expect(await caught(createClient(noRetry).getRun("run_x"))).toMatchObject({ code: "unavailable", status: 503, retryable: true });
  });

  // The 16 Connect codes at their Connect HTTP statuses, with a Connect body
  // (no `retryable` key): the SDK's retry set is the one in ADR 0110.
  it.each([
    ["canceled", 499, false], ["unknown", 500, true], ["invalid_argument", 400, false],
    ["deadline_exceeded", 504, true], ["not_found", 404, false], ["already_exists", 409, false],
    ["permission_denied", 403, false], ["resource_exhausted", 429, true], ["failed_precondition", 400, false],
    ["aborted", 409, false], ["out_of_range", 400, false], ["unimplemented", 501, false],
    ["internal", 500, true], ["unavailable", 503, true], ["data_loss", 500, true], ["unauthenticated", 401, false],
  ] as const)("Connect %s at %s: retryable=%s", async (code, status, retryable) => {
    reply(status, { code, message: "x" });
    const err = (await caught(createClient(noRetry).getRun("run_x"))) as { retryable: boolean; code: string };
    expect(err.retryable).toBe(retryable);
    // A typed class (401, 403, 409) keeps its Connect code too.
    if (![401, 403, 409].includes(status)) expect(err.code).toBe(code);
  });

  // The one retryable change (#3066): a body that carries `retryable` now wins on
  // request() too, as it already did on REST routes. Only a REST-shaped body
  // (middleware, not a Connect handler) carries the flag, and only two statuses
  // disagree with the status rule.
  it.each([
    [408, "deadline_exceeded", true],
    [507, "failed_precondition", false],
  ] as const)("a %s body that says retryable=%s wins over the status rule", async (status, code, retryable) => {
    reply(status, { error: "x", message: "x", code, retryable });
    expect(await caught(createClient(noRetry).getRun("run_x"))).toMatchObject({ code, status, retryable });
  });
});
