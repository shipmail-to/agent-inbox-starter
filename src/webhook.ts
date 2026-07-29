import type { InboxBodyPart, InboxFullMessage, InboxThread, InboxThreads } from "shipmail";
import { verifyWebhook } from "shipmail";
import { z } from "zod";

import {
  runAgent,
  type AgentResult,
  type EscalationHook,
  type InboxOperations,
  type Logger,
  type TriageModel,
} from "./agent.ts";
import { parseAuthenticationResults } from "./authentication.ts";
import { createMemoryEventStore, type EventStore } from "./event-store.ts";
import { secureInboundMessage, isSenderAllowed } from "./security.ts";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const SUPPORTED_WEBHOOK_VERSION = "2026-07-22";

const THREAD_PAGE_LIMIT = 100;
const MAX_THREAD_PAGES = 5;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUE_DEPTH = 64;
const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REPLIES_PER_THREAD = 3;

const addressSchema = z.looseObject({ address: z.email(), name: z.string().nullable() });

// Deliberately loose: a starter should not stop triaging mail the day Shipmail
// adds a field. Validate what we consume and ignore the rest.
const messageReceivedSchema = z.looseObject({
  version: z.string().min(1),
  event_id: z.string().min(1),
  event_type: z.literal("message.received"),
  created_at: z.iso.datetime(),
  test: z.boolean().default(false),
  data: z.looseObject({
    tracked_message_id: z.string().min(1),
    mailbox_id: z.string().min(1),
    email_id: z.string().nullable().default(null),
    from: addressSchema.nullable(),
    subject: z.string().nullable().default(null),
    thread_id: z.string().nullable(),
  }),
});

type MessageReceivedEvent = z.infer<typeof messageReceivedSchema>;

// The SDK does not declare authentication_results on inbox_message_full, though
// the API returns it. Read it through a schema rather than widening the SDK type
// by assertion, so a payload that does not match is treated as absent.
const authenticationCarrierSchema = z.looseObject({ authentication_results: z.unknown() });

function readAuthenticationResults(message: InboxFullMessage): ReturnType<
  typeof parseAuthenticationResults
> {
  const carrier = authenticationCarrierSchema.safeParse(message);
  return parseAuthenticationResults(carrier.success ? carrier.data.authentication_results : null);
}
type InboxReadOperations = {
  readonly getInboxThread: (mailboxId: string, threadId: string) => Promise<InboxThread>;
  readonly listInboxThreads: (
    mailboxId: string,
    params: {
      readonly sort_by: "last_message_at";
      readonly order: "desc";
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ) => Promise<InboxThreads>;
};
export type WebhookMailboxes = InboxOperations & InboxReadOperations;
export type WebhookVerifier = (body: string, headers: Headers, secret: string) => Promise<unknown>;
export type WebhookHandlerDependencies = {
  readonly webhookSecret: string;
  readonly mailboxId: string;
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
  readonly autoSend: boolean;
  readonly requireAuthenticatedSender: boolean;
  readonly mailboxes: WebhookMailboxes;
  readonly model: TriageModel;
  readonly logger?: Logger | undefined;
  readonly onEscalate?: EscalationHook | undefined;
  readonly eventStore?: EventStore | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly processTimeoutMs?: number | undefined;
  readonly maxRepliesPerThread?: number | undefined;
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

/**
 * A permanent failure. Retrying re-runs the same work and fails the same way, so
 * the delivery is acknowledged and the event is dropped with a log line instead
 * of becoming a poison message the provider retries forever.
 */
class TerminalEventError extends Error {
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

function responseJson(status: number, body: Readonly<Record<string, string | boolean>>): Response {
  return Response.json(body, { status });
}

function errorMessage(error: unknown): string {
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

function partsToText(
  parts: readonly InboxBodyPart[],
  message: InboxFullMessage,
): string {
  return parts
    .map((part) => message.body_values[part.part_id]?.value ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
}

/**
 * Falling back to the HTML part is necessary but worth knowing about: CSS-hidden
 * text reaches the model while staying invisible to whoever reviews the thread.
 */
function bodyFromParts(message: InboxFullMessage): {
  readonly value: string;
  readonly isHtml: boolean;
} {
  const text = partsToText(message.text_body, message);
  if (text.length > 0) return { value: text, isHtml: false };
  return { value: partsToText(message.html_body, message), isHtml: true };
}

function selectMessage(
  messages: readonly InboxFullMessage[],
  emailId: string | null,
  trackedMessageId: string,
  sender: string,
): InboxFullMessage | undefined {
  if (emailId !== null) {
    const emailMatch = messages.find((message) => message.id === emailId);
    if (emailMatch !== undefined) return emailMatch;
  }
  const exact = messages.find((message) => message.id === trackedMessageId);
  if (exact !== undefined) return exact;
  const normalizedSender = sender.trim().toLowerCase();
  return [...messages]
    .reverse()
    .find((message) =>
      message.from?.some((address) => address.email?.toLowerCase() === normalizedSender),
    );
}

/**
 * The SDK has no single-thread reply_version read and no thread_id filter on the
 * list endpoint, so we page until the thread turns up. Bounded, because an
 * unbounded walk on a busy mailbox is worse than giving up and logging.
 */
async function findReplyVersion(
  mailboxes: InboxReadOperations,
  mailboxId: string,
  threadId: string,
): Promise<number | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const summaries = await mailboxes.listInboxThreads(mailboxId, {
      sort_by: "last_message_at",
      order: "desc",
      limit: THREAD_PAGE_LIMIT,
      cursor,
    });
    const match = summaries.data.find((item) => item.thread_id === threadId);
    if (match !== undefined) return match.reply_version;
    const next = summaries.pagination.next_cursor;
    if (next === null) return undefined;
    cursor = next;
  }
  return undefined;
}

async function processMessageReceived(
  event: MessageReceivedEvent,
  dependencies: WebhookHandlerDependencies,
): Promise<AgentResult | "ignored"> {
  const logger = dependencies.logger ?? console;
  if (event.data.mailbox_id !== dependencies.mailboxId) return "ignored";
  const sender = event.data.from?.address;
  const threadId = event.data.thread_id;
  if (sender === undefined || threadId === null) return "ignored";

  if (!isSenderAllowed(sender, dependencies.allowedSenders)) {
    logger.warn("Blocked inbound sender", { eventId: event.event_id, sender });
    return "ignored";
  }

  const [thread, replyVersion] = await Promise.all([
    dependencies.mailboxes.getInboxThread(event.data.mailbox_id, threadId),
    findReplyVersion(dependencies.mailboxes, event.data.mailbox_id, threadId),
  ]);

  // Never reply to ourselves: an allowlisted autoresponder plus AUTO_SEND is a
  // mail loop, and the agent's own address can appear in its own thread.
  if (sender.trim().toLowerCase() === thread.address.trim().toLowerCase()) {
    logger.warn("Skipped a message from the agent mailbox itself", {
      eventId: event.event_id,
      threadId,
    });
    return "ignored";
  }

  const message = selectMessage(
    thread.data,
    event.data.email_id,
    event.data.tracked_message_id,
    sender,
  );
  if (message === undefined || replyVersion === undefined) {
    throw new TerminalEventError(
      "Could not resolve the inbound message or the current reply version",
    );
  }

  // Only a DMARC pass counts. SPF alone authenticates the envelope sender, not
  // the From header a person reads, which is the gap a spoofer walks through.
  // Null results mean unknown, never fine: an unparseable payload must not
  // silently disable enforcement.
  const authenticationResults = readAuthenticationResults(message);
  if (dependencies.requireAuthenticatedSender && authenticationResults?.dmarc !== "pass") {
    const reason =
      authenticationResults === null
        ? "Sender authentication results are missing or malformed"
        : "Sender authentication failed because DMARC did not pass";
    logger.warn("Email requires human review", {
      eventId: event.event_id,
      threadId,
      reason,
      authenticationVerdicts: {
        spf: authenticationResults?.spf ?? null,
        dkim: authenticationResults?.dkim ?? null,
        dmarc: authenticationResults?.dmarc ?? null,
      },
    });
    await dependencies.onEscalate?.({
      eventId: event.event_id,
      threadId,
      sender,
      reason,
    });
    return { classification: "escalate", reason };
  }

  const body = bodyFromParts(message);
  if (body.isHtml && body.value.length > 0) {
    logger.info("Using the HTML part; no plain-text alternative was present", {
      eventId: event.event_id,
      threadId,
    });
  }
  const secured = secureInboundMessage(
    {
      sender,
      subject: message.subject ?? event.data.subject ?? "",
      body: body.value,
      bodyIsHtml: body.isHtml,
    },
    { allowedSenders: dependencies.allowedSenders, allowedUrlHosts: dependencies.allowedUrlHosts },
  );
  if (!secured.ok) return "ignored";

  const store = dependencies.eventStore ?? createMemoryEventStore();
  const maxReplies = dependencies.maxRepliesPerThread ?? DEFAULT_MAX_REPLIES_PER_THREAD;
  const autoSend =
    dependencies.autoSend && (await store.repliesInWindow(threadId)) < maxReplies;
  if (dependencies.autoSend && !autoSend) {
    logger.warn("Auto-send paused: reply cap reached for this thread", {
      eventId: event.event_id,
      threadId,
      maxReplies,
    });
  }

  const result = await runAgent(
    {
      eventId: event.event_id,
      mailboxId: event.data.mailbox_id,
      threadId,
      replyVersion,
      message: secured.message,
    },
    {
      model: dependencies.model,
      mailboxes: dependencies.mailboxes,
      autoSend,
      allowedUrlHosts: dependencies.allowedUrlHosts,
      logger: dependencies.logger,
      onEscalate: dependencies.onEscalate,
    },
  );
  if (result.classification === "needs_reply" && result.sent) {
    await store.recordReply(threadId);
  }
  return result;
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

export function createWebhookHandler(
  dependencies: WebhookHandlerDependencies,
): WebhookHandler {
  if (dependencies.verify !== undefined && process.env["NODE_ENV"] === "production") {
    throw new Error("A custom webhook verifier cannot be used in production");
  }
  const verifier =
    dependencies.verify ??
    ((body: string, headers: Headers, secret: string): Promise<unknown> =>
      Promise.resolve(verifyWebhook(body, headers, secret)));
  const logger = dependencies.logger ?? console;
  const store = dependencies.eventStore ?? createMemoryEventStore();
  const maxConcurrency = dependencies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxQueueDepth = dependencies.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  const timeoutMs = dependencies.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const inFlight = new Set<Promise<void>>();
  let queued = 0;

  async function handleEvent(event: MessageReceivedEvent): Promise<void> {
    try {
      const result = await withTimeout(
        processMessageReceived(event, { ...dependencies, eventStore: store }),
        timeoutMs,
      );
      logger.info("Webhook event processed", {
        eventId: event.event_id,
        outcome: result === "ignored" ? "ignored" : result.classification,
      });
    } catch (error) {
      if (error instanceof TerminalEventError) {
        logger.error("Dropping event: permanent failure", {
          eventId: event.event_id,
          error: errorMessage(error),
        });
        return;
      }
      // Retryable. Release the claim so the provider's next delivery reprocesses it.
      logger.error("Webhook processing failed; awaiting provider retry", {
        eventId: event.event_id,
        error: errorMessage(error),
      });
      await store.release(event.event_id);
    }
  }

  function enqueue(event: MessageReceivedEvent): void {
    queued += 1;
    const task = (async () => {
      while (inFlight.size >= maxConcurrency) {
        await Promise.race(inFlight);
      }
      await handleEvent(event);
    })().finally(() => {
      queued -= 1;
    });
    const tracked = task.finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
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
      verified = await verifier(body, request.headers, dependencies.webhookSecret);
    } catch (error) {
      logger.warn("Webhook signature verification failed", { error: errorMessage(error) });
      return responseJson(401, { error: "invalid_signature" });
    }

    const envelope = z.looseObject({ event_type: z.string() }).safeParse(verified);
    if (!envelope.success) return responseJson(400, { error: "invalid_payload" });
    if (envelope.data.event_type !== "message.received") {
      return responseJson(202, { accepted: true, ignored: true });
    }

    const parsed = messageReceivedSchema.safeParse(verified);
    if (!parsed.success) return responseJson(400, { error: "invalid_payload" });
    const event = parsed.data;

    if (event.version !== SUPPORTED_WEBHOOK_VERSION) {
      logger.warn("Processing an unrecognized webhook contract version", {
        eventId: event.event_id,
        version: event.version,
        supported: SUPPORTED_WEBHOOK_VERSION,
      });
    }
    if (event.test) {
      logger.info("Acknowledged a test delivery without processing", { eventId: event.event_id });
      return responseJson(202, { accepted: true, ignored: true });
    }
    if ((await store.claim(event.event_id)) === "duplicate") {
      logger.info("Ignored a duplicate delivery", { eventId: event.event_id });
      return responseJson(202, { accepted: true, ignored: true });
    }
    if (queued >= maxQueueDepth) {
      await store.release(event.event_id);
      logger.warn("Shedding load: work queue is full", { eventId: event.event_id, queued });
      return responseJson(503, { error: "queue_full" });
    }

    enqueue(event);
    return responseJson(202, { accepted: true, ignored: false });
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  return { handle, drain };
}

export function startWebhookServer(
  port: number,
  dependencies: WebhookHandlerDependencies,
): ReturnType<typeof Bun.serve> {
  const handler = createWebhookHandler(dependencies);
  return Bun.serve({
    port,
    maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES,
    fetch: handler.handle,
  });
}
