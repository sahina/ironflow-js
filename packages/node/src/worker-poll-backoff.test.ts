import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorker } from "./worker.js";
import { assertDefined } from "./internal/assert-defined.js";

// Job-poll retry cadence. Two gaps met here at once: the loop had no rate assertion anywhere,
// and worker.test.ts exercises a hand-rolled TestWorker rather than the real pollForJobs — so
// the shipped loop had no test driving it at all. A flat 5s retry against an engine that is
// simply down logs a warning per attempt forever; the log this came from held 371k lines.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const testFn = {
  config: { id: "fn" },
  handler: async () => ({ ok: true }),
} as unknown as Parameters<typeof createWorker>[0]["functions"][number];

/**
 * Drive the real worker's poll loop over a faked clock, returning the clock time of every
 * GET /jobs it attempted. `jobsResponse` decides what each poll gets — throw to model an
 * unreachable engine.
 */
async function pollTimes(
  jobsResponse: (attempt: number) => { ok: boolean; status: number },
  forMs: number
): Promise<number[]> {
  const attemptedAt: number[] = [];
  mockFetch.mockImplementation(async (url: string) => {
    const target = String(url);
    // Registration and the heartbeat interval are not under test; they always succeed.
    if (target.includes("/register") || target.includes("/heartbeat"))
      return { ok: true, status: 200 };
    if (target.includes("/jobs")) {
      attemptedAt.push(Date.now());
      return jobsResponse(attemptedAt.length);
    }
    return { ok: true, status: 200 };
  });

  const worker = createWorker({
    serverUrl: "http://localhost:9123",
    functions: [testFn],
    logger: noopLogger,
  });
  void worker.start();
  // Flush registration, then walk the clock through the ladder.
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(forMs);
  worker.stop();
  return attemptedAt;
}

const gapsBetween = (times: number[]): number[] =>
  times.slice(1).map((at, i) => at - assertDefined(times[i]));

describe("job poll backoff", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("doubles the retry delay and caps it, instead of retrying flat forever", async () => {
    const attemptedAt = await pollTimes(() => {
      throw new Error("fetch failed");
    }, 300_000);

    // Literals, not a re-derivation of the code's formula: 5s base, doubling, ceiling 60s.
    expect(gapsBetween(attemptedAt).slice(0, 6)).toEqual([
      5000, 10000, 20000, 40000, 60000, 60000,
    ]);
    // Five minutes of a flat 5s cadence would be 60 attempts.
    expect(attemptedAt.length).toBeLessThan(10);
  });

  it("resets the ladder once a poll reaches the server, so a blip costs one delay", async () => {
    // Fail, fail, then answer 204 (no jobs — the state a healthy idle worker sits in), then fail
    // again. The delay after that last failure must be the FIRST rung, not the third.
    const attemptedAt = await pollTimes(
      (attempt) => {
        if (attempt === 3) return { ok: true, status: 204 };
        throw new Error("fetch failed");
      },
      60_000
    );

    const gaps = gapsBetween(attemptedAt);
    expect(gaps.slice(0, 2)).toEqual([5000, 10000]); // two failures climb the ladder
    expect(gaps[2]).toBe(1000); // the 204 path's own idle delay
    expect(gaps[3]).toBe(5000); // back to the first rung, not 20000
  });
});
