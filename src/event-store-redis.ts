import type { EventClaim, EventStore } from "./event-store.ts";

/**
 * A shared EventStore, so more than one process can run safely.
 *
 * The in-memory store in event-store.ts is per-process: two instances keep
 * separate maps, both claim the same retry, and the deduplication it exists to
 * provide quietly stops working. This backs the same interface with Redis.
 *
 * Claiming is a single `SET NX EX`, so the check and the write cannot interleave
 * between processes. Anything built on read-then-write instead would let two
 * concurrent retries both pass the check.
 */

/**
 * The subset of a Redis client this needs. Bun's built-in `RedisClient`
 * satisfies it, and so do ioredis and node-redis, which keeps the store usable
 * without committing the starter to one client.
 */
export type RedisLike = {
  // args is mutable because that is what real clients declare: Bun's RedisClient,
  // ioredis, and node-redis all take string[]. A readonly parameter here would be
  // stricter than any of them can satisfy.
  readonly send: (command: string, args: string[]) => Promise<unknown>;
};

export type RedisEventStoreOptions = {
  readonly redis: RedisLike;
  /** Prefix for every key, so one Redis instance can serve several mailboxes. */
  readonly keyPrefix?: string | undefined;
  /** How long a processed event is remembered. Must exceed the provider's retry window. */
  readonly eventTtlSeconds?: number | undefined;
  /** Window for the per-thread reply cap. */
  readonly replyWindowSeconds?: number | undefined;
};

const DEFAULT_EVENT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_REPLY_WINDOW_SECONDS = 60 * 60;
const DEFAULT_KEY_PREFIX = "agent-inbox";

function toCount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function createRedisEventStore(options: RedisEventStoreOptions): EventStore {
  const { redis } = options;
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const eventTtl = String(options.eventTtlSeconds ?? DEFAULT_EVENT_TTL_SECONDS);
  const replyWindow = String(options.replyWindowSeconds ?? DEFAULT_REPLY_WINDOW_SECONDS);
  const eventKey = (eventId: string): string => `${prefix}:event:${eventId}`;
  const replyKey = (threadId: string): string => `${prefix}:replies:${threadId}`;

  return {
    async claim(eventId: string): Promise<EventClaim> {
      // NX makes this the atomic test-and-set that dedup depends on: exactly one
      // caller gets "OK", every concurrent retry gets nil.
      const result = await redis.send("SET", [eventKey(eventId), "1", "NX", "EX", eventTtl]);
      return result === null ? "duplicate" : "new";
    },
    async release(eventId: string): Promise<void> {
      await redis.send("DEL", [eventKey(eventId)]);
    },
    async recordReply(threadId: string): Promise<void> {
      const key = replyKey(threadId);
      const count = toCount(await redis.send("INCR", [key]));
      // Only the first reply sets the expiry, so the window runs from that reply
      // rather than sliding forward on every subsequent one.
      if (count === 1) await redis.send("EXPIRE", [key, replyWindow]);
    },
    async repliesInWindow(threadId: string): Promise<number> {
      return toCount(await redis.send("GET", [replyKey(threadId)]));
    },
  };
}
