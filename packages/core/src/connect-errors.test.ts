import { describe, expect, it } from "vitest";
import { connectHTTPError, ERROR_REASON_HEADER, ERROR_REASON } from "./connect-errors.js";
import { UnauthenticatedError, UnauthorizedError, ConflictError, ContendedError, InjectionUnverifiedError, connectCodeForStatus, fileErrorFor } from "./errors.js";

describe("Connect error contract", () => {
  it.each([
    [401, "unauthenticated", UnauthenticatedError],
    [403, "permission_denied", UnauthorizedError],
    [409, "already_exists", ConflictError],
    [409, "aborted", ContendedError],
  ] as const)("keeps %s %s typed and permanent", (status, code, type) => {
    const error = connectHTTPError(status, "rejected", code);
    expect(error).toBeInstanceOf(type);
    expect(error.retryable).toBe(false);
  });
  it.each([[400, "invalid_argument", false], [429, "resource_exhausted", true], [503, "unavailable", true]] as const)(
    "classifies %s %s", (status, code, retryable) => {
      const error = connectHTTPError(status, "rejected", code);
      expect(error).toMatchObject({ status, code, retryable });
    }
  );
  it("does not retry 501 or code unimplemented: a missing route does not heal", () => {
    expect(connectHTTPError(501, "no route").retryable).toBe(false);
    expect(connectHTTPError(500, "no rpc", "unimplemented").retryable).toBe(false);
    expect(connectHTTPError(501, "no rpc", "unimplemented").retryable).toBe(false);
  });
});

describe("throttle retry classification (#1972 step 10)", () => {
  it("marks the rate cap retryable — it is shaped, and carries a Retry-After", () => {
    const err = connectHTTPError(429, "write rate limit exceeded", "resource_exhausted");
    expect(err.retryable).toBe(true);
  });

  it("marks the disk cap NOT retryable — only an operator can move that wall", () => {
    const err = connectHTTPError(400, "database size limit reached", "failed_precondition");
    expect(err.retryable).toBe(false);
  });
});

// #2074 split 409 by Connect code because `already_exists` and `aborted` want
// opposite things. `aborted` then stopped meaning one thing too:
// injectStepOutput answers it when the CAS lost and NOTHING was written, and
// also when the step write LANDED but the run moved under it (#2073). Both
// arrive as aborted/409, and this mapper collapsed both onto ContendedError,
// whose doc promises "nothing was applied" — a lie for the second, and in the
// dangerous direction: it invites a reissue over a durable write the caller
// has not read.
//
// The absent-reason row is the one that keeps this honest. Every other
// producer of `aborted` means contention, and a pre-#2093 server sends no
// header, so the default must stay ContendedError.
describe("aborted discriminates on the reason header (#2093)", () => {
  it.each([
    [ERROR_REASON.injectionUnverified, InjectionUnverifiedError, ContendedError],
    [ERROR_REASON.contended, ContendedError, InjectionUnverifiedError],
    [undefined, ContendedError, InjectionUnverifiedError],
  ] as const)("reason %s lands on the right class", (reason, want, other) => {
    const error = connectHTTPError(409, "inject step output", "aborted", { reason });
    expect(error).toBeInstanceOf(want);
    // The two must partition, not overlap: a caller checking ContendedError
    // first and reissuing would re-apply a landed write if both matched.
    expect(error).not.toBeInstanceOf(other);
    expect(error.retryable).toBe(false);
  });

  it("names the header the server actually sets", () => {
    expect(ERROR_REASON_HEADER).toBe("Ironflow-Error-Reason");
  });
});

// One condition, one code (#3054, #3066): the lowercase Connect code, from the
// body when it has one and from the status when it does not.
describe("generic error codes are the lowercase Connect codes", () => {
  it("keeps the Connect code on a not-found", () => {
    expect(connectHTTPError(404, "gone", "not_found")).toMatchObject({ code: "not_found", status: 404, retryable: false });
  });
  it("names a code-less status with its Connect code, not HTTP_<status>", () => {
    expect(connectHTTPError(404, "gone")).toMatchObject({ code: "not_found", status: 404 });
    expect(fileErrorFor(404, "gone")).toMatchObject({ code: "not_found", status: 404 });
    expect(fileErrorFor(404, "gone", "BUCKET_NOT_FOUND")).toMatchObject({ code: "BUCKET_NOT_FOUND" });
    expect(fileErrorFor(409, "not empty", "BUCKET_NOT_EMPTY")).toMatchObject({ code: "BUCKET_NOT_EMPTY", retryable: false });
    expect(fileErrorFor(409, "exists", "CONFLICT")).toMatchObject({ code: "already_exists" });
    expect(connectCodeForStatus(500, "constructor")).toBe("constructor");
  });
  it.each([
    [400, "invalid_argument"], [401, "unauthenticated"], [402, "failed_precondition"], [403, "permission_denied"],
    [404, "not_found"], [408, "deadline_exceeded"], [409, "already_exists"], [412, "failed_precondition"],
    [429, "resource_exhausted"], [500, "internal"], [501, "unimplemented"], [503, "unavailable"],
    [504, "deadline_exceeded"], [507, "failed_precondition"],
  ] as const)("maps status %s to %s", (status, code) => {
    expect(connectCodeForStatus(status)).toBe(code);
  });
  it("normalises a capitalised generic code from an older server and keeps a domain code", () => {
    expect(connectCodeForStatus(404, "NOT_FOUND")).toBe("not_found");
    expect(connectCodeForStatus(409, "CONFLICT")).toBe("already_exists");
    expect(connectCodeForStatus(409, "BUCKET_NOT_EMPTY")).toBe("BUCKET_NOT_EMPTY");
    expect(fileErrorFor(404, "gone", "NOT_FOUND")).toMatchObject({ code: "not_found" });
  });
  it("treats an empty code as absent", () => {
    expect(connectCodeForStatus(404, "")).toBe("not_found");
    expect(connectHTTPError(404, "gone", "")).toMatchObject({ code: "not_found" });
  });
  it("gives the typed auth and conflict errors the Connect codes", () => {
    expect(new UnauthenticatedError().code).toBe("unauthenticated");
    expect(new UnauthorizedError().code).toBe("permission_denied");
    expect(new ConflictError().code).toBe("already_exists");
  });
});
