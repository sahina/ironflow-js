/**
 * One SubscribeBidirectional stream of a consumer-group subscription, and the
 * errors its acks raise. Split from consumer-group-stream.ts; bundled into it.
 */

import { create } from "@bufbuild/protobuf";
import { IronflowError, TimeoutError } from "@ironflow/core";
import {
  AckMode,
  AckResultCode,
  AckType,
  SubscribeBidirectionalRequestSchema,
  SubscriptionAckSchema,
  type AckResult,
  type ConsumerGroupJoined,
  type SubscribeBidirectionalRequest,
  type SubscribeBidirectionalResponse,
} from "@ironflow/core/gen";

/**
 * The server rejected an ack, nak or term. `not_found`: the group or this
 * member is gone, so a retry cannot succeed. `internal`: a retry may succeed.
 */
export class AckError extends IronflowError {
  readonly eventId: string;
  declare readonly code: AckErrorCode;

  constructor(eventId: string, code: AckErrorCode, message: string) {
    super(`ack of event ${eventId} rejected (${code}): ${message}`, { code });
    this.name = "AckError";
    this.eventId = eventId;
  }
}

export type AckErrorCode = "invalid_argument" | "not_found" | "internal";

const ACK_ERROR_CODES: Partial<Record<AckResultCode, AckErrorCode>> = {
  [AckResultCode.INVALID_ARGUMENT]: "invalid_argument",
  [AckResultCode.NOT_FOUND]: "not_found",
};

/**
 * The event is not pending on the current stream: the stream ended, or this
 * stream has settled every copy of it already. The ack is never sent, as the
 * server would answer a false OK. An event of an ended stream is redelivered.
 */
export class StaleAckError extends IronflowError {
  constructor(message = "the stream reconnected; the event will be redelivered") {
    super(message, { code: "STALE_ACK" });
    this.name = "StaleAckError";
  }
}

/** `ack`, `nak` or `term` after `unsubscribe()` or a terminal stream error. */
export class SubscriptionClosedError extends IronflowError {
  constructor() {
    super("the subscription is closed", { code: "SUBSCRIPTION_CLOSED" });
    this.name = "SubscriptionClosedError";
  }
}

/**
 * An unsettled entry is dropped this long after its latest copy arrived, so
 * events a handler never settles do not grow the map forever. An object so
 * tests can shorten it.
 *
 * shortcut: a fixed age, as the server's AckWait is not known here. A late ack
 * of a pruned event fails with StaleAckError and the server redelivers it, so
 * delivery stays at-least-once. Upgrade if joined starts carrying the AckWait.
 */
export const deliveryMaxAge = { ms: 60 * 60 * 1000 };

interface PendingAck {
  eventId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(err: unknown): void;
}

/**
 * One SubscribeBidirectional stream. A reconnect makes a new one, so its
 * delivered set and ack_id counter die with the stream.
 */
export class GroupConn {
  readonly abort = new AbortController();
  responses!: AsyncIterator<SubscribeBidirectionalResponse>;
  subId = "";
  pattern = "";
  manual = false;
  ended = false;

  private nextAck = 0n;
  private pending = new Map<bigint, PendingAck>();
  // MANUAL groups only: the copies of each event delivered on this stream and
  // not yet settled. A count, so a redelivery that arrives before the first
  // copy's result keeps its own entry.
  private delivered = new Map<string, { copies: number; at: number }>();
  private lastPrune = 0;
  private outbox: SubscribeBidirectionalRequest[] = [];
  private wake?: () => void;
  private closing = false;

  constructor(private join: SubscribeBidirectionalRequest) {}

  init(joined: ConsumerGroupJoined) {
    this.subId = joined.subscriptionId;
    this.pattern = joined.pattern;
    this.manual = joined.ackMode === AckMode.MANUAL;
  }

  /** The request stream: join first, then queued acks until half-close. */
  async *requests(): AsyncGenerator<SubscribeBidirectionalRequest> {
    yield this.join;
    for (;;) {
      const next = this.outbox.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closing) return; // ending the generator half-closes the stream
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  halfClose() {
    this.closing = true;
    this.wake?.();
  }

  /** Half-close, then reset: a cancelled read alone can leave an idle stream open. */
  teardown() {
    this.halfClose();
    this.abort.abort();
  }

  markDelivered(id: string) {
    if (!this.manual) return;
    const now = Date.now();
    if (now - this.lastPrune >= deliveryMaxAge.ms) {
      for (const [k, d] of this.delivered) if (now - d.at >= deliveryMaxAge.ms) this.delivered.delete(k);
      this.lastPrune = now;
    }
    const d = this.delivered.get(id);
    this.delivered.set(id, { copies: (d?.copies ?? 0) + 1, at: now });
  }

  get deliveredCount(): number {
    return this.delivered.size;
  }

  /** Fails every pending ack and marks the stream ended. */
  finish() {
    this.ended = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new StaleAckError());
    }
    this.pending.clear();
  }

  resolveAck(res: AckResult) {
    const p = this.pending.get(res.ackId);
    if (!p) return; // timed out already
    this.pending.delete(res.ackId);
    clearTimeout(p.timer);
    if (res.code !== AckResultCode.OK) {
      p.reject(new AckError(p.eventId, ACK_ERROR_CODES[res.code] ?? "internal", res.message));
      return;
    }
    // One copy is settled. A NAK's redelivery adds its own copy when it arrives.
    const d = this.delivered.get(p.eventId);
    if (d && d.copies > 1) d.copies--;
    else this.delivered.delete(p.eventId);
    p.resolve();
  }

  settle(eventId: string, ackType: AckType, delayMs: number, timeoutMs: number): Promise<void> {
    if (this.ended) return Promise.reject(new StaleAckError());
    if (this.manual && !this.delivered.has(eventId)) {
      return Promise.reject(
        new StaleAckError("the event is not pending on this stream (settled already, or delivered before a reconnect)"),
      );
    }
    const ackId = ++this.nextAck;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackId);
        reject(new TimeoutError(`no ack result for event ${eventId} within ${timeoutMs}ms`, timeoutMs));
      }, timeoutMs);
      this.pending.set(ackId, { eventId, timer, resolve, reject });
      this.outbox.push(
        create(SubscribeBidirectionalRequestSchema, {
          payload: {
            case: "ack",
            value: create(SubscriptionAckSchema, { eventId, ackType, redeliverDelayMs: delayMs, ackId }),
          },
        }),
      );
      this.wake?.();
    });
  }
}

