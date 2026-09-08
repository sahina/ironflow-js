import type { WaitResult } from "./types.js";

/** ProtoJSON omits defaults and encodes 64-bit sequence fields as strings. */
export interface WaitWireResult {
  caughtUp?: boolean;
  timedOut?: boolean;
  currentSeq?: string | number;
  targetSeq?: string | number;
  behindByEvents?: string | number;
  rebuilding?: boolean;
  mode?: string;
}

/** Keep the unary SDK's numeric result contract across transports. */
export function waitResultFromWire(result: WaitWireResult): WaitResult {
  return {
    caughtUp: result.caughtUp ?? false,
    timedOut: result.timedOut ?? false,
    currentSeq: Number(result.currentSeq ?? 0),
    targetSeq: Number(result.targetSeq ?? 0),
    behindByEvents: Number(result.behindByEvents ?? 0),
    rebuilding: result.rebuilding ?? false,
    mode: result.mode ?? "",
  };
}
