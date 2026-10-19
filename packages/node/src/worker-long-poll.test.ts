import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorker } from "./worker.js";
import { assertDefined } from "./internal/assert-defined.js";

// ADR 0124: the REST job poll is held by the server. The worker must poll again at once only
// when the server says it held the poll, or a new SDK would spin against an old server.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const testFn = {
  config: { id: "fn" },
  handler: async () => ({ ok: true }),
} as unknown as Parameters<typeof createWorker>[0]["functions"][number];

interface PollResult {
  urls: string[];
  times: number[];
  worker: ReturnType<typeof createWorker>;
}

/** Run the real poll loop for `forMs` of faked time; every GET /jobs answers 204 at once with `header`. */
async function run(
  header: string | null,
  forMs: number,
  config: { pollWaitSeconds?: number } = {}
): Promise<PollResult> {
  const urls: string[] = [];
  const times: number[] = [];
  mockFetch.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.includes("/jobs")) {
      urls.push(target);
      times.push(Date.now());
      const headers = new Headers(header === null ? {} : { "Ironflow-Poll-Wait": header });
      return new Response(null, { status: 204, headers });
    }
    return { ok: true, status: 200 };
  });

  const worker = createWorker({
    serverUrl: "http://localhost:9123",
    functions: [testFn],
    logger: noopLogger,
    ...config,
  });
  void worker.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(forMs);
  worker.stop();
  return { urls, times, worker };
}

describe("job long poll", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls again without sleeping when the server held the poll", async () => {
    // The mock answers instantly, so with no sleep the loop would spin forever on the faked
    // clock; bound it by making the second answer drop the header.
    let n = 0;
    const times: number[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/jobs")) {
        times.push(Date.now());
        n += 1;
        const headers = new Headers(n < 4 ? { "Ironflow-Poll-Wait": "20" } : {});
        return new Response(null, { status: 204, headers });
      }
      return { ok: true, status: 200 };
    });
    const worker = createWorker({
      serverUrl: "http://localhost:9123",
      functions: [testFn],
      logger: noopLogger,
    });
    void worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    worker.stop();

    // Polls 1-3 were held (no gap); poll 4 had no header, so the 1 s sleep precedes poll 5.
    expect(times.slice(1, 4).every((t) => t === times[0])).toBe(true);
    expect(times[4]).toBe(assertDefined(times[3]) + 1000);
  });

  it("keeps the 1 s sleep when the header is absent (older server)", async () => {
    const { times } = await run(null, 3_500);
    expect(times.slice(1).map((t, i) => t - assertDefined(times[i]))).toEqual([1000, 1000, 1000]);
  });

  it('keeps the 1 s sleep when the header is "0" (server did not hold the poll)', async () => {
    const { times } = await run("0", 2_500);
    expect(times.slice(1).map((t, i) => t - assertDefined(times[i]))).toEqual([1000, 1000]);
  });

  it("sends wait=20 by default", async () => {
    const { urls } = await run(null, 0);
    expect(urls[0]).toMatch(/\/jobs\?available=10&wait=20$/);
  });

  it("omits wait when pollWaitSeconds is 0", async () => {
    const { urls } = await run(null, 0, { pollWaitSeconds: 0 });
    expect(urls[0]).not.toContain("wait=");
  });

  it("sends a custom pollWaitSeconds", async () => {
    const { urls } = await run(null, 0, { pollWaitSeconds: 7 });
    expect(urls[0]).toContain("&wait=7");
  });

  // The server answers 400 to a wait it cannot parse, so a bad option must never
  // reach the wire: above 25 is capped, below 0 is off, non-finite is the default.
  it.each([
    [40, "&wait=25"],
    [-5, null],
    [Number.POSITIVE_INFINITY, "&wait=20"],
    [Number.NaN, "&wait=20"],
  ])("normalizes pollWaitSeconds %s", async (value, expected) => {
    const { urls } = await run(null, 0, { pollWaitSeconds: value });
    if (expected) expect(urls[0]).toMatch(new RegExp(`${expected}$`));
    else expect(urls[0]).not.toContain("wait=");
  });

  describe("held poll abort", () => {
    // A fetch that never answers until its signal aborts, like a server holding the poll.
    function holdPolls(): { aborted: () => boolean } {
      let aborted = false;
      mockFetch.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (!String(url).includes("/jobs")) return Promise.resolve({ ok: true, status: 200 });
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });
      return { aborted: () => aborted };
    }

    it("stop() aborts the in-flight poll without logging an error", async () => {
      const held = holdPolls();
      const worker = createWorker({
        serverUrl: "http://localhost:9123",
        functions: [testFn],
        logger: noopLogger,
      });
      const started = worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(held.aborted()).toBe(false);

      worker.stop();
      await started;

      expect(held.aborted()).toBe(true);
      expect(noopLogger.warn).not.toHaveBeenCalled();
      expect(noopLogger.error).not.toHaveBeenCalled();
    });

    it("drain() aborts the in-flight poll while a job is still running", async () => {
      // With no active job drain() calls stop() at once, so a running job is what makes this
      // test cover the drain path itself.
      const slowFn = {
        config: { id: "fn" },
        handler: () => new Promise(() => {}),
      } as unknown as typeof testFn;
      let aborted = false;
      let served = false;
      mockFetch.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
        if (!String(url).includes("/jobs?")) return Promise.resolve({ ok: true, status: 200 });
        if (!served) {
          served = true;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              jobs: [{
                job_id: "job-1", run_id: "run-1", function_id: "fn", attempt: 1,
                event: { id: "event-1", name: "job.started", data: {}, timestamp: new Date().toISOString() },
                completed_steps: [], execution_seq: 1, lease_token: "lease-1",
              }],
            }),
          });
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });
      const worker = createWorker({
        serverUrl: "http://localhost:9123",
        functions: [slowFn],
        logger: noopLogger,
      });
      const started = worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(aborted).toBe(false);

      const drained = worker.drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      await drained;
      await started;
      expect(noopLogger.warn).not.toHaveBeenCalledWith("Job polling error", expect.anything());
    });
  });
});
