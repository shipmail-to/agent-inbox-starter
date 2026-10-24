import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createMemoryEventStore } from "../src/event-store.ts";
import { messageReceivedSchema } from "../src/events.ts";
import {
  createWebhookHandler,
  MAX_WEBHOOK_BODY_BYTES,
  on,
  TerminalEventError,
  type WebhookServerOptions,
} from "../src/server.ts";
import { envelope, silentLogger, webhookRequest } from "./fixtures.ts";

const pingSchema = z.looseObject({ value: z.string() });

function server(
  payload: unknown,
  run: (value: string) => Promise<void>,
  overrides: Partial<WebhookServerOptions> = {},
) {
  return createWebhookHandler({
    webhookSecret: "test-secret",
    logger: silentLogger,
    verify: async () => payload,
    handlers: { "message.received": on(pingSchema, (data) => run(data.value)) },
    ...overrides,
  });
}

const ping = (eventId: string, test = false) =>
  envelope(eventId, "message.received", { value: "hello" }, test);

describe("webhook server", () => {
  test("answers the health check", async () => {
    const handler = server({}, async () => {});
    const response = await handler.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
  });

  test("acknowledges first, then runs the handler", async () => {
    const seen: string[] = [];
    const handler = server(ping("evt_1"), async (value) => {
      seen.push(value);
    });

    const response = await handler.handle(webhookRequest({}));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, ignored: false });
    await handler.drain();
    expect(seen).toEqual(["hello"]);
  });

  test("rejects a delivery whose signature does not verify", async () => {
    const handler = server({}, async () => {}, {
      verify: async () => {
        throw new Error("bad signature");
      },
    });
    const response = await handler.handle(webhookRequest({}));
    expect(response.status).toBe(401);
  });

  test("acknowledges an event type nobody handles without running anything", async () => {
    let runs = 0;
    const handler = server(envelope("evt_2", "booking.created", {}), async () => {
      runs += 1;
    });
    const response = await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(await response.json()).toEqual({ accepted: true, ignored: true });
    expect(runs).toBe(0);
  });

  test("acknowledges a test delivery without running the handler", async () => {
    let runs = 0;
    const handler = server(ping("evt_3", true), async () => {
      runs += 1;
    });
    const response = await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(await response.json()).toEqual({ accepted: true, ignored: true });
    expect(runs).toBe(0);
  });

  test("accepts a valid sender address that a strict email regex would reject", () => {
    const data = messageReceivedSchema.safeParse({
      tracked_message_id: "msg_1",
      mailbox_id: "mbx_1",
      from: { address: "info=sales@acme.example", name: null },
      thread_id: "thread_1",
    });
    expect(data.success).toBe(true);
  });

  test("rejects data that does not match the handler's schema", async () => {
    const handler = server(envelope("evt_4", "message.received", { value: 1 }), async () => {});
    const response = await handler.handle(webhookRequest({}));
    expect(response.status).toBe(400);
  });

  test("processes a replayed delivery only once", async () => {
    let runs = 0;
    const handler = server(ping("evt_5"), async () => {
      runs += 1;
    });
    await handler.handle(webhookRequest({}));
    await handler.drain();
    const replay = await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(replay.status).toBe(202);
    expect(runs).toBe(1);
  });

  test("retries a failed event in process, because Shipmail already got its 202", async () => {
    let runs = 0;
    const handler = server(
      ping("evt_6"),
      async () => {
        runs += 1;
        if (runs === 1) throw new Error("model overloaded");
      },
      { sleep: async () => {} },
    );
    await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(runs).toBe(2);
  });

  test("releases the claim after the last retry so a replay from Shipmail runs", async () => {
    let runs = 0;
    const handler = server(
      ping("evt_6b"),
      async () => {
        runs += 1;
        throw new Error("still failing");
      },
      { retryDelaysMs: [], sleep: async () => {} },
    );
    await handler.handle(webhookRequest({}));
    await handler.drain();
    await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(runs).toBe(2);
  });

  test("runs every queued event when more arrive than the concurrency limit", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let eventNumber = 0;
    let finished = 0;
    const handler = createWebhookHandler({
      webhookSecret: "test-secret",
      logger: silentLogger,
      maxConcurrency: 2,
      verify: async () => ping(`evt_burst_${(eventNumber += 1)}`),
      handlers: {
        "message.received": on(pingSchema, async () => {
          await gate;
          finished += 1;
        }),
      },
    });
    for (let index = 0; index < 6; index += 1) await handler.handle(webhookRequest({}));
    release();
    await handler.drain();
    expect(finished).toBe(6);
  });

  test("keeps the claim after a permanent failure so retries are dropped", async () => {
    let runs = 0;
    const handler = server(ping("evt_7"), async () => {
      runs += 1;
      throw new TerminalEventError("unresolvable");
    });
    await handler.handle(webhookRequest({}));
    await handler.drain();
    await handler.handle(webhookRequest({}));
    await handler.drain();
    expect(runs).toBe(1);
  });

  test("sheds load when the queue is full", async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let eventNumber = 0;
    const store = createMemoryEventStore();
    const handler = createWebhookHandler({
      webhookSecret: "test-secret",
      logger: silentLogger,
      eventStore: store,
      maxConcurrency: 1,
      maxQueueDepth: 1,
      verify: async () => ping(`evt_queue_${(eventNumber += 1)}`),
      handlers: { "message.received": on(pingSchema, () => blocked) },
    });
    expect((await handler.handle(webhookRequest({}))).status).toBe(202);
    expect((await handler.handle(webhookRequest({}))).status).toBe(503);
    // The shed event's claim was released, so Shipmail's retry is accepted.
    expect(await store.claim("evt_queue_2")).toBe("new");
    release();
    await handler.drain();
  });

  test("rejects a declared oversized body before signature verification", async () => {
    let verifyCount = 0;
    const handler = server({}, async () => {}, {
      verify: async () => {
        verifyCount += 1;
        return {};
      },
    });
    const response = await handler.handle(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Length": String(MAX_WEBHOOK_BODY_BYTES + 1) },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(verifyCount).toBe(0);
  });

  test("caps streamed bodies without a content length before signature verification", async () => {
    let verifyCount = 0;
    const handler = server({}, async () => {}, {
      verify: async () => {
        verifyCount += 1;
        return {};
      },
    });
    const chunkSize = MAX_WEBHOOK_BODY_BYTES / 2 + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(chunkSize));
        controller.enqueue(new Uint8Array(chunkSize));
        controller.close();
      },
    });
    const response = await handler.handle(
      new Request("http://localhost/webhook", { method: "POST", body }),
    );
    expect(response.status).toBe(413);
    expect(verifyCount).toBe(0);
  });
});
