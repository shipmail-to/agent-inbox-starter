/**
 * Retry and loop protection for inbound webhooks.
 *
 * Shipmail retries a delivery it did not get a 2xx for, and a signed request can
 * be replayed inside the signature's timestamp window. Without a record of which
 * events have been seen, every retry re-runs the whole pipeline, including a
 * fresh model call. Idempotency keys on the Shipmail writes do not prevent that
 * spend, and do not cover the reply-state update.
 *
 * The in-memory implementation below is correct for a single process. Swap it
 * for Redis or Postgres before running more than one instance: two processes
 * with separate maps will both process the same retry.
 */

export type EventClaim = "new" | "duplicate";

export type EventStore = {
  /**
   * Marks an event as in flight. Returns "duplicate" if it was already claimed,
   * including by a delivery still being processed, so concurrent retries collapse.
   */
  readonly claim: (eventId: string) => Promise<EventClaim>;
  /** Releases a claim so a retryable failure can be retried by the provider. */
  readonly release: (eventId: string) => Promise<void>;
  /** Records that a reply went out on a thread, for the auto-send loop guard. */
  readonly recordReply: (threadId: string) => Promise<void>;
  readonly repliesInWindow: (threadId: string) => Promise<number>;
};

export type MemoryEventStoreOptions = {
  /** How long a processed event is remembered. Must exceed the provider's retry window. */
  readonly eventTtlMs?: number | undefined;
  /** Sliding window for the per-thread reply cap. */
  readonly replyWindowMs?: number | undefined;
  readonly now?: (() => number) | undefined;
};

const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPLY_WINDOW_MS = 60 * 60 * 1000;

export function createMemoryEventStore(options: MemoryEventStoreOptions = {}): EventStore {
  const eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS;
  const replyWindowMs = options.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();
  const replies = new Map<string, number[]>();

  function sweep(current: number): void {
    for (const [eventId, claimedAt] of seen) {
      if (current - claimedAt > eventTtlMs) seen.delete(eventId);
    }
    for (const [threadId, timestamps] of replies) {
      const fresh = timestamps.filter((at) => current - at <= replyWindowMs);
      if (fresh.length === 0) replies.delete(threadId);
      else replies.set(threadId, fresh);
    }
  }

  return {
    async claim(eventId: string): Promise<EventClaim> {
      const current = now();
      sweep(current);
      if (seen.has(eventId)) return "duplicate";
      seen.set(eventId, current);
      return "new";
    },
    async release(eventId: string): Promise<void> {
      seen.delete(eventId);
    },
    async recordReply(threadId: string): Promise<void> {
      const current = now();
      replies.set(threadId, [...(replies.get(threadId) ?? []), current]);
    },
    async repliesInWindow(threadId: string): Promise<number> {
      const current = now();
      const timestamps = replies.get(threadId) ?? [];
      return timestamps.filter((at) => current - at <= replyWindowMs).length;
    },
  };
}
