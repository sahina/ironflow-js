import { describe, it, expect } from "vitest";
import {
  filterWaitStreamFrames,
  type WaitStreamFrameLike,
  type WaitStreamFrameKinds,
} from "./projection-stream.js";
import { assertDefined } from "./internal/assert-defined.js";

// Mirror the generated WaitStreamFrameKind numeric values.
const KINDS: WaitStreamFrameKinds = {
  UNSPECIFIED: 0,
  PROGRESS: 1,
  HEARTBEAT: 2,
  DONE: 3,
};

// Helper: make an async iterable from a plain array.
async function* fromFrames(
  frames: WaitStreamFrameLike[]
): AsyncIterable<WaitStreamFrameLike> {
  for (const f of frames) {
    yield f;
  }
}

// Helper: collect every yielded value.
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("filterWaitStreamFrames", () => {
  it("filters heartbeat frames from the output", async () => {
    const frames: WaitStreamFrameLike[] = [
      {
        kind: KINDS.PROGRESS,
        currentSeq: 10n,
        targetSeq: 100n,
        behindByEvents: 90n,
        caughtUp: false,
        timedOut: false,
      },
      { kind: KINDS.HEARTBEAT, currentSeq: 0n, targetSeq: 100n, behindByEvents: 0n, caughtUp: false, timedOut: false },
      { kind: KINDS.HEARTBEAT, currentSeq: 0n, targetSeq: 100n, behindByEvents: 0n, caughtUp: false, timedOut: false },
      {
        kind: KINDS.PROGRESS,
        currentSeq: 50n,
        targetSeq: 100n,
        behindByEvents: 50n,
        caughtUp: false,
        timedOut: false,
      },
      {
        kind: KINDS.DONE,
        currentSeq: 100n,
        targetSeq: 100n,
        behindByEvents: 0n,
        caughtUp: true,
        timedOut: false,
      },
    ];
    const result = await collect(filterWaitStreamFrames(fromFrames(frames), KINDS));

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ currentSeq: 10n, terminal: false });
    expect(result[1]).toMatchObject({ currentSeq: 50n, terminal: false });
    expect(result[2]).toMatchObject({ currentSeq: 100n, terminal: true, caughtUp: true });
  });

  it("skips UNSPECIFIED frames (forward compat)", async () => {
    const frames: WaitStreamFrameLike[] = [
      { kind: KINDS.UNSPECIFIED, currentSeq: 0n, targetSeq: 1n, behindByEvents: 0n, caughtUp: false, timedOut: false },
      {
        kind: KINDS.DONE,
        currentSeq: 1n,
        targetSeq: 1n,
        behindByEvents: 0n,
        caughtUp: true,
        timedOut: false,
      },
    ];
    const result = await collect(filterWaitStreamFrames(fromFrames(frames), KINDS));

    expect(result).toHaveLength(1);
    expect(assertDefined(result[0]).terminal).toBe(true);
  });

  it("terminates iteration on DONE frame (short-circuits remainder)", async () => {
    const frames: WaitStreamFrameLike[] = [
      {
        kind: KINDS.DONE,
        currentSeq: 42n,
        targetSeq: 42n,
        behindByEvents: 0n,
        caughtUp: true,
        timedOut: false,
      },
      // These must never be observed.
      {
        kind: KINDS.PROGRESS,
        currentSeq: 999n,
        targetSeq: 42n,
        behindByEvents: 0n,
        caughtUp: false,
        timedOut: false,
      },
    ];
    const result = await collect(filterWaitStreamFrames(fromFrames(frames), KINDS));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ caughtUp: true, currentSeq: 42n });
  });

  it("surfaces error string on DONE terminal", async () => {
    const frames: WaitStreamFrameLike[] = [
      {
        kind: KINDS.DONE,
        currentSeq: 5n,
        targetSeq: 100n,
        behindByEvents: 95n,
        caughtUp: false,
        timedOut: false,
        error: "projection paused",
      },
    ];
    const [doneRaw] = await collect(filterWaitStreamFrames(fromFrames(frames), KINDS));
    const done = assertDefined(doneRaw);
    expect(done.terminal).toBe(true);
    expect(done.error).toBe("projection paused");
    expect(done.caughtUp).toBe(false);
  });

  it("preserves bigint precision for uint64 seq fields above 2^53", async () => {
    // 2^60 — comfortably above Number.MAX_SAFE_INTEGER (2^53-1). Any
    // conversion through number would lose precision here.
    const big = 1n << 60n;
    const frames: WaitStreamFrameLike[] = [
      {
        kind: KINDS.PROGRESS,
        currentSeq: big,
        targetSeq: big + 100n,
        behindByEvents: 100n,
        caughtUp: false,
        timedOut: false,
      },
      { kind: KINDS.DONE, currentSeq: big + 100n, targetSeq: big + 100n, behindByEvents: 0n, caughtUp: true, timedOut: false },
    ];
    const [progressRaw] = await collect(filterWaitStreamFrames(fromFrames(frames), KINDS));
    const progress = assertDefined(progressRaw);
    expect(typeof progress.currentSeq).toBe("bigint");
    expect(progress.currentSeq).toBe(big);
    expect(progress.targetSeq).toBe(big + 100n);
  });

  it("aborts cleanly when the underlying iterable throws (AbortSignal path)", async () => {
    const frames: WaitStreamFrameLike[] = [
      {
        kind: KINDS.PROGRESS,
        currentSeq: 1n,
        targetSeq: 100n,
        behindByEvents: 99n,
        caughtUp: false,
        timedOut: false,
      },
    ];
    async function* withAbort(): AsyncIterable<WaitStreamFrameLike> {
      for (const f of frames) yield f;
      throw new DOMException("aborted", "AbortError");
    }

    const iter = filterWaitStreamFrames(withAbort(), KINDS);
    const first = await iter[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);

    // Next iteration should propagate the abort error.
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/abort/i);
  });
});
