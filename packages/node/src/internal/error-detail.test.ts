import { describe, it, expect } from "vitest";
import { errorDetail } from "./error-detail.js";

// The three throw sites in worker.ts used to report `response.status` alone, so
// the server's explanation of WHICH rule an ID broke never reached the user
// (#1750). These pin the reading, the bound, and the two degrade paths.
describe("errorDetail", () => {
  it("appends the server's reason to the status", async () => {
    const body = JSON.stringify({ error: "function ID has an empty segment, whitespace, or a control character" });
    const detail = await errorDetail(new Response(body, { status: 400 }));

    expect(detail).toContain("400");
    expect(detail).toContain("empty segment");
  });

  it("degrades to the bare status on an empty body", async () => {
    expect(await errorDetail(new Response("", { status: 503 }))).toBe("503");
    // Whitespace-only is the same case — a body of "\n" is not a reason.
    expect(await errorDetail(new Response("\n  \n", { status: 503 }))).toBe("503");
  });

  it("degrades to the bare status when the body cannot be read", async () => {
    // A proxy that closes mid-body, or a body already consumed upstream.
    const rejecting = {
      status: 502,
      text: () => Promise.reject(new Error("stream closed")),
    } as unknown as Response;

    expect(await errorDetail(rejecting)).toBe("502");
  });

  it("degrades to the bare status when there is no text() at all", async () => {
    // Not hypothetical: every fetch double in this package's suite is a plain
    // `{ ok, status }` object. A `.catch()` handler cannot catch this — the
    // missing method throws before a promise exists — so it turned the whole
    // error path into a TypeError.
    const bare = { ok: false, status: 401 } as unknown as Response;

    expect(await errorDetail(bare)).toBe("401");
  });

  it("bounds the body so a proxy's HTML error page is not spliced in whole", async () => {
    const huge = "x".repeat(5000);
    const detail = await errorDetail(new Response(huge, { status: 502 }));

    // 200 body chars + the ellipsis + "502: ".
    expect(detail.length).toBeLessThan(220);
    expect(detail.endsWith("…")).toBe(true);
  });
});
