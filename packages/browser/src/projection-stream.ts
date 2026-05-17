/**
 * Frame-filter logic for waitForProjectionCatchupStream (#476).
 *
 * Extracted from IronflowClient.waitForProjectionCatchupStream so the
 * heartbeat-filter and terminal-short-circuit behavior can be unit
 * tested with a mock async iterable, without loading the @connectrpc
 * transport modules or the generated ProjectionService client.
 */

import type { WaitProgress } from "@ironflow/core";

/**
 * Minimal shape of a streaming response frame. Matches the generated
 * WaitProjectionCatchupStreamResponse type without importing it, so this
 * file stays free of @bufbuild/protobuf/@ironflow/core/gen dependencies.
 */
export interface WaitStreamFrameLike {
  kind: number;
  currentSeq: number | bigint;
  targetSeq: number | bigint;
  behindByEvents: number | bigint;
  caughtUp: boolean;
  timedOut: boolean;
  error?: string;
  mode?: string;
}

/**
 * Enum-value lookup. The caller supplies the numeric values from the
 * generated WaitStreamFrameKind enum so this file doesn't import the
 * generated code.
 */
export interface WaitStreamFrameKinds {
  readonly UNSPECIFIED: number;
  readonly PROGRESS: number;
  readonly HEARTBEAT: number;
  readonly DONE: number;
}

/** Coerce bigint-or-number-or-string into bigint without truncation. */
function toBigInt(v: number | bigint | string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return BigInt(v);
  // number case — safe only up to 2^53-1; callers shouldn't hit this path
  // because protobuf-es decodes uint64 to bigint, but guard defensively.
  return BigInt(v);
}

/**
 * Filter a stream of server frames into user-visible WaitProgress
 * values. Heartbeat and UNSPECIFIED frames are skipped; DONE frames
 * are emitted once and terminate the iteration.
 */
export async function* filterWaitStreamFrames(
  stream: AsyncIterable<WaitStreamFrameLike>,
  kinds: WaitStreamFrameKinds
): AsyncIterable<WaitProgress> {
  for await (const frame of stream) {
    if (frame.kind === kinds.HEARTBEAT || frame.kind === kinds.UNSPECIFIED) {
      // Transport-only keepalive + defensive unknown-kind skip.
      continue;
    }
    const p: WaitProgress = {
      // Preserve bigint precision — Number() would silently truncate
      // seqs above 2^53-1.
      currentSeq: toBigInt(frame.currentSeq),
      targetSeq: toBigInt(frame.targetSeq),
      behindByEvents: toBigInt(frame.behindByEvents),
      terminal: frame.kind === kinds.DONE,
      caughtUp: frame.caughtUp,
      timedOut: frame.timedOut,
      mode: frame.mode || undefined,
    };
    if (frame.error) p.error = frame.error;
    yield p;
    if (p.terminal) return;
  }
}
