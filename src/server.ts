import type { WebhookEventType } from "shipmail";
import { verifyWebhook } from "shipmail";
import type { z } from "zod";

import { createMemoryEventStore, type EventStore } from "./event-store.ts";
import { envelopeSchema, SUPPORTED_WEBHOOK_VERSION, type Envelope } from "./events.ts";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUE_DEPTH = 64;
const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000];

export type Logger = Pick<Console, "info" | "warn" | "error">;

/** Returns the work for an event, or null when its data does not match the handler's schema. */
export type EventHandler = (envelope: Envelope) => (() => Promise<void>) | null;
export type EventHandlers = Readonly<Partial<Record<WebhookEventType, EventHandler>>>;

/** Pairs a data schema with the work to run once a delivery has been verified and parsed. */
export function on<T>(
  schema: z.ZodType<T>,
  run: (data: T, envelope: Envelope) => Promise<void>,
): EventHandler {
  return (envelope) => {
    const parsed = schema.safeParse(envelope.data);
    return parsed.success ? () => run(parsed.data, envelope) : null;
  };
}

/**
 * A permanent failure. Retrying re-runs the same work and fails the same way, so
 * the delivery is acknowledged and the event is dropped with a log line instead
 * of becoming a poison message the provider retries forever.
 */
export class TerminalEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalEventError";
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Webhook request body exceeds the 1 MB limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export type WebhookVerifier = (body: string, headers: Headers, secret: string) => Promise<unknown>;

export type WebhookServerOptions = {
  readonly webhookSecret: string;
  readonly handlers: EventHandlers;
  /** Shared with handlers that keep their own state, such as the triage reply cap. */
  readonly eventStore?: EventStore | undefined;
  readonly logger?: Logger | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly processTimeoutMs?: number | undefined;
  /** Waits between attempts of a failed event. Its length is the number of retries. */
  readonly retryDelaysMs?: readonly number[] | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Test-only override for signature verification. Refused when NODE_ENV is
   * "production" so it cannot silently disable the check in a deployment.
   */
  readonly verify?: WebhookVerifier | undefined;
};

export type WebhookHandler = {
  readonly handle: (request: Request) => Promise<Response>;
  /** Resolves once every accepted event has finished processing. */
  readonly drain: () => Promise<void>;
};

function responseJson(status: number, body: Readonly<Record<string, string | boolean>>): Response {
  return Response.json(body, { status });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function exceedsBodyLimit(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const normalized = contentLength.trim();
  if (!/^\d+$/u.test(normalized)) return false;
  return BigInt(normalized) > BigInt(MAX_WEBHOOK_BODY_BYTES);
}

async function readRequestBody(request: Request): Promise<string> {
  if (exceedsBodyLimit(request.headers.get("content-length"))) {
    throw new RequestBodyTooLargeError();
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const textParts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) throw new RequestBodyTooLargeError();
      textParts.push(decoder.decode(result.value, { stream: true }));
    }
    textParts.push(decoder.decode());
    return textParts.join("");
  } finally {
    reader.releaseLock();
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Processing exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/**
 * Verifies, deduplicates and queues webhook deliveries, then runs the handler
 * registered for the event type. It answers 202 before any handler runs, so
 * nothing waits on a model call inside the request.
 */
export function createWebhookHandler(options: WebhookServerOptions): WebhookHandler {
  if (options.verify !== undefined && process.env["NODE_ENV"] === "production") {
    throw new Error("A custom webhook verifier cannot be used in production");
  }
  const verifier = options.verify ?? verifyWebhook;
  const logger = options.logger ?? console;
  const store = options.eventStore ?? createMemoryEventStore();
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  const timeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pending = new Set<Promise<void>>();
  const waiting: (() => void)[] = [];
  let running = 0;

  async function acquireSlot(): Promise<void> {
    if (running < maxConcurrency) {
      running += 1;
      return;
    }
    // The slot is handed over by releaseSlot, so running never drops below the limit.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function releaseSlot(): void {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }

  /**
   * Shipmail has already received its 202, so it will not redeliver: a
   * retryable failure is retried here. After the last attempt the claim is
   * released, so replaying the delivery from Shipmail processes it again.
   */
  async function runTask(eventId: string, task: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await withTimeout(task(), timeoutMs);
        return;
      } catch (error) {
        if (error instanceof TerminalEventError) {
          logger.error("Dropping event: permanent failure", {
            eventId,
            error: errorMessage(error),
          });
          return;
        }
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) {
          logger.error("Event failed after every retry; replay it from Shipmail", {
            eventId,
            error: errorMessage(error),
          });
          await store.release(eventId);
          return;
        }
        logger.warn("Event failed; retrying", { eventId, attempt, error: errorMessage(error) });
        await sleep(delay);
      }
    }
  }

  function enqueue(eventId: string, task: () => Promise<void>): void {
    const work = (async () => {
      await acquireSlot();
      try {
        await runTask(eventId, task);
      } finally {
        releaseSlot();
      }
    })();
    const tracked = work.finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return responseJson(200, { ok: true });
    }
    const webhookPath = url.pathname === "/webhook" || url.pathname === "/api/webhook";
    if (request.method !== "POST" || !webhookPath) {
      return responseJson(404, { error: "not_found" });
    }

    let body: string;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return responseJson(413, { error: "payload_too_large" });
      }
      logger.warn("Could not read webhook body", { error: errorMessage(error) });
      return responseJson(400, { error: "invalid_body" });
    }

    let verified: unknown;
    try {
      verified = await verifier(body, request.headers, options.webhookSecret);
    } catch (error) {
      logger.warn("Webhook signature verification failed", { error: errorMessage(error) });
      return responseJson(401, { error: "invalid_signature" });
    }

    const parsed = envelopeSchema.safeParse(verified);
    if (!parsed.success) return responseJson(400, { error: "invalid_payload" });
    const envelope = parsed.data;

    const handler = handlerFor(envelope.event_type);
    if (handler === undefined) return responseJson(202, { accepted: true, ignored: true });

    if (envelope.version !== SUPPORTED_WEBHOOK_VERSION) {
      logger.warn("Processing an unrecognized webhook contract version", {
        eventId: envelope.event_id,
        version: envelope.version,
        supported: SUPPORTED_WEBHOOK_VERSION,
      });
    }
    if (envelope.test) {
      logger.info("Acknowledged a test delivery without processing", {
        eventId: envelope.event_id,
      });
      return responseJson(202, { accepted: true, ignored: true });
    }
    const task = handler(envelope);
    if (task === null) return responseJson(400, { error: "invalid_payload" });

    if ((await store.claim(envelope.event_id)) === "duplicate") {
      logger.info("Ignored a duplicate delivery", { eventId: envelope.event_id });
      return responseJson(202, { accepted: true, ignored: true });
    }
    if (pending.size >= maxQueueDepth) {
      await store.release(envelope.event_id);
      logger.warn("Shedding load: work queue is full", {
        eventId: envelope.event_id,
        pending: pending.size,
      });
      return responseJson(503, { error: "queue_full" });
    }

    enqueue(envelope.event_id, task);
    return responseJson(202, { accepted: true, ignored: false });
  }

  function handlerFor(eventType: string): EventHandler | undefined {
    const handlers: Readonly<Partial<Record<string, EventHandler>>> = options.handlers;
    return handlers[eventType];
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.race(pending);
    }
  }

  return { handle, drain };
}

export function startWebhookServer(
  port: number,
  options: WebhookServerOptions,
): ReturnType<typeof Bun.serve> {
  const handler = createWebhookHandler(options);
  return Bun.serve({ port, maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES, fetch: handler.handle });
}
