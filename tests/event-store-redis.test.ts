import { describe, expect, test } from "bun:test";

import { createRedisEventStore, type RedisLike } from "../src/event-store-redis.ts";

/**
 * A Redis stand-in that implements only the semantics the store relies on:
 * SET NX (write only when absent), DEL, INCR, EXPIRE, GET. Testing against this
 * rather than a live server keeps `bun test` network-free, and still catches the
 * mistake that matters, which is issuing a command that does not do what the
 * dedup logic assumes.
 */
function fakeRedis(): RedisLike & {
  readonly calls: string[][];
  readonly store: Map<string, string>;
  readonly ttls: Map<string, string>;
} {
  const store = new Map<string, string>();
  const ttls = new Map<string, string>();
  const calls: string[][] = [];
  return {
    calls,
    store,
    ttls,
    async send(command: string, args: string[]): Promise<unknown> {
      calls.push([command, ...args]);
      const key = args[0] ?? "";
      switch (command) {
        case "SET": {
          const nx = args.includes("NX");
          if (nx && store.has(key)) return null;
          store.set(key, args[1] ?? "");
          const ttlIndex = args.indexOf("EX");
          if (ttlIndex >= 0) ttls.set(key, args[ttlIndex + 1] ?? "");
          return "OK";
        }
        case "DEL":
          store.delete(key);
          ttls.delete(key);
          return 1;
        case "INCR": {
          const next = Number.parseInt(store.get(key) ?? "0", 10) + 1;
          store.set(key, String(next));
          return next;
        }
        case "EXPIRE":
          ttls.set(key, args[1] ?? "");
          return 1;
        case "GET":
          return store.get(key) ?? null;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    },
  };
}

describe("redis event store", () => {
  test("claims an event once and reports every replay as a duplicate", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    expect(await store.claim("evt_1")).toBe("new");
    expect(await store.claim("evt_1")).toBe("duplicate");
    expect(await store.claim("evt_1")).toBe("duplicate");
  });

  test("claims atomically with SET NX EX rather than a read then a write", async () => {
    const redis = fakeRedis();
    await createRedisEventStore({ redis }).claim("evt_2");

    // A GET-then-SET pair would let two concurrent retries both pass the check.
    expect(redis.calls).toEqual([
      ["SET", "agent-inbox:event:evt_2", "1", "NX", "EX", String(24 * 60 * 60)],
    ]);
  });

  test("collapses concurrent claims of the same event to a single winner", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.claim("evt_race")),
    );

    expect(results.filter((result) => result === "new")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(4);
  });

  test("releasing a claim allows the provider's retry to be processed", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    expect(await store.claim("evt_3")).toBe("new");
    await store.release("evt_3");
    expect(await store.claim("evt_3")).toBe("new");
  });

  test("counts replies per thread and keeps threads independent", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    expect(await store.repliesInWindow("thread_a")).toBe(0);
    await store.recordReply("thread_a");
    await store.recordReply("thread_a");
    await store.recordReply("thread_b");

    expect(await store.repliesInWindow("thread_a")).toBe(2);
    expect(await store.repliesInWindow("thread_b")).toBe(1);
  });

  test("sets the reply window on the first reply only, so it does not slide", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    await store.recordReply("thread_c");
    await store.recordReply("thread_c");

    const expires = redis.calls.filter((call) => call[0] === "EXPIRE");
    expect(expires).toEqual([["EXPIRE", "agent-inbox:replies:thread_c", String(60 * 60)]]);
  });

  test("namespaces keys so one Redis instance can serve several mailboxes", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis, keyPrefix: "mailbox-42" });

    await store.claim("evt_4");
    await store.recordReply("thread_d");

    expect([...redis.store.keys()]).toEqual([
      "mailbox-42:event:evt_4",
      "mailbox-42:replies:thread_d",
    ]);
  });

  test("honors custom TTLs", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({
      redis,
      eventTtlSeconds: 60,
      replyWindowSeconds: 120,
    });

    await store.claim("evt_5");
    await store.recordReply("thread_e");

    expect(redis.ttls.get("agent-inbox:event:evt_5")).toBe("60");
    expect(redis.ttls.get("agent-inbox:replies:thread_e")).toBe("120");
  });

  test("treats a missing reply counter as zero rather than NaN", async () => {
    const redis = fakeRedis();
    const store = createRedisEventStore({ redis });

    expect(await store.repliesInWindow("never_seen")).toBe(0);
  });
});
