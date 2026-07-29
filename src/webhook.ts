import { verifyWebhook } from "shipmail";
import { z } from "zod";

import {
  runAgent,
  type AgentResult,
  type InboxOperations,
  type Logger,
  type TriageModel,
} from "./agent.ts";
import { parseAuthenticationResults } from "./authentication.ts";
import { secureInboundMessage } from "./security.ts";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const addressSchema = z
  .object({ address: z.string().email(), name: z.string().nullable() })
  .strict();
const messageReceivedSchema = z
  .object({
    version: z.literal("2026-07-22"),
    event_id: z.string().min(1),
    event_type: z.literal("message.received"),
    created_at: z.string().datetime(),
    test: z.boolean(),
    data: z
      .object({
        tracked_message_id: z.string().min(1),
        mailbox_id: z.string().min(1),
        client_reference: z.string().nullable(),
        rfc_message_id: z.string().nullable(),
        email_id: z.string().nullable(),
        from: addressSchema.nullable(),
        to: z.array(addressSchema),
        cc: z.array(addressSchema),
        bcc: z.array(addressSchema),
        subject: z.string().nullable(),
        thread_id: z.string().nullable(),
        received_at: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

type ThreadMessage = {
  readonly id: string;
  // The API returns this field, but shipmail 0.4.10 does not declare it yet.
  readonly authentication_results?: unknown;
  readonly from: readonly { readonly email: string | null }[] | null;
  readonly subject: string | null;
  readonly body_values: Readonly<
    Record<string, { readonly value: string; readonly is_encoding_problem: boolean }>
  >;
  readonly text_body: readonly { readonly part_id: string; readonly type: string }[];
  readonly html_body: readonly { readonly part_id: string; readonly type: string }[];
};
type InboxReadOperations = {
  readonly getInboxThread: (
    mailboxId: string,
    threadId: string,
  ) => Promise<{ readonly data: readonly ThreadMessage[] }>;
  readonly listInboxThreads: (
    mailboxId: string,
    params: {
      readonly sort_by: "last_message_at";
      readonly order: "desc";
      readonly limit: number;
    },
  ) => Promise<{
    readonly data: readonly { readonly thread_id: string; readonly reply_version: number }[];
  }>;
};
export type WebhookMailboxes = InboxOperations & InboxReadOperations;
export type WebhookVerifier = (
  body: string,
  headers: Headers,
  secret: string,
) => Promise<unknown>;
export type WebhookHandlerDependencies = {
  readonly webhookSecret: string;
  readonly mailboxId: string;
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
  readonly autoSend: boolean;
  readonly requireAuthenticatedSender: boolean;
  readonly mailboxes: WebhookMailboxes;
  readonly model: TriageModel;
  readonly verify?: WebhookVerifier | undefined;
  readonly logger?: Logger | undefined;
};

function responseJson(status: number, body: Readonly<Record<string, string | boolean>>): Response {
  return Response.json(body, { status });
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Webhook request body exceeds the 1 MB limit");
    this.name = "RequestBodyTooLargeError";
  }
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
      if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) {
        throw new RequestBodyTooLargeError();
      }
      textParts.push(decoder.decode(result.value, { stream: true }));
    }
    textParts.push(decoder.decode());
    return textParts.join("");
  } finally {
    reader.releaseLock();
  }
}

function bodyFromParts(message: ThreadMessage): string {
  const text = message.text_body
    .map((part) => message.body_values[part.part_id]?.value ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
  if (text.length > 0) return text;
  return message.html_body
    .map((part) => message.body_values[part.part_id]?.value ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
}
function selectMessage(
  messages: readonly ThreadMessage[],
  emailId: string | null,
  trackedMessageId: string,
  sender: string,
): ThreadMessage | undefined {
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

async function processMessageReceived(
  event: z.infer<typeof messageReceivedSchema>,
  dependencies: WebhookHandlerDependencies,
): Promise<AgentResult | "ignored"> {
  const logger = dependencies.logger ?? console;
  if (event.data.mailbox_id !== dependencies.mailboxId) return "ignored";
  const sender = event.data.from?.address;
  const threadId = event.data.thread_id;
  if (sender === undefined || threadId === null) return "ignored";
  const policy = {
    allowedSenders: dependencies.allowedSenders,
    allowedUrlHosts: dependencies.allowedUrlHosts,
  };
  const senderCheck = secureInboundMessage({
    sender,
    subject: event.data.subject ?? "",
    body: "sender preflight",
  }, policy);
  if (!senderCheck.ok) {
    logger.warn("Blocked inbound sender", { eventId: event.event_id, sender });
    return "ignored";
  }
  const [thread, summaries] = await Promise.all([
    dependencies.mailboxes.getInboxThread(event.data.mailbox_id, threadId),
    dependencies.mailboxes.listInboxThreads(event.data.mailbox_id, {
      sort_by: "last_message_at",
      order: "desc",
      limit: 100,
    }),
  ]);
  const message = selectMessage(
    thread.data,
    event.data.email_id,
    event.data.tracked_message_id,
    sender,
  );
  const summary = summaries.data.find((item) => item.thread_id === threadId);
  if (message === undefined || summary === undefined) {
    throw new Error("Could not resolve the inbound message and current reply version");
  }
  const authenticationResults = parseAuthenticationResults(message.authentication_results);
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
    return { classification: "escalate", reason };
  }
  const secured = secureInboundMessage(
    {
      sender,
      subject: message.subject ?? event.data.subject ?? "",
      body: bodyFromParts(message),
    },
    policy,
  );
  if (!secured.ok) return "ignored";
  return runAgent(
    {
      eventId: event.event_id,
      mailboxId: event.data.mailbox_id,
      threadId,
      replyVersion: summary.reply_version,
      message: secured.message,
    },
    {
      model: dependencies.model,
      mailboxes: dependencies.mailboxes,
      autoSend: dependencies.autoSend,
      allowedUrlHosts: dependencies.allowedUrlHosts,
      logger: dependencies.logger,
    },
  );
}

export function createWebhookHandler(
  dependencies: WebhookHandlerDependencies,
): (request: Request) => Promise<Response> {
  const verifier =
    dependencies.verify ??
    (async (body: string, headers: Headers, secret: string): Promise<unknown> => {
      return verifyWebhook(body, headers, secret);
    });
  const logger = dependencies.logger ?? console;
  return async (request: Request): Promise<Response> => {
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
      logger.warn("Could not read webhook body", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return responseJson(400, { error: "invalid_body" });
    }
    let verified: unknown;
    try {
      verified = await verifier(body, request.headers, dependencies.webhookSecret);
    } catch (error) {
      logger.warn("Webhook signature verification failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return responseJson(401, { error: "invalid_signature" });
    }
    const envelope = z.object({ event_type: z.string() }).passthrough().safeParse(verified);
    if (!envelope.success) return responseJson(400, { error: "invalid_payload" });
    if (envelope.data.event_type !== "message.received") {
      return responseJson(202, { accepted: true, ignored: true });
    }
    const parsed = messageReceivedSchema.safeParse(verified);
    if (!parsed.success) return responseJson(400, { error: "invalid_payload" });
    try {
      const result = await processMessageReceived(parsed.data, dependencies);
      return responseJson(200, { accepted: true, ignored: result === "ignored" });
    } catch (error) {
      logger.error("Webhook processing failed", {
        eventId: parsed.data.event_id,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return responseJson(500, { error: "processing_failed" });
    }
  };
}

export function startWebhookServer(
  port: number,
  dependencies: WebhookHandlerDependencies,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    maxRequestBodySize: MAX_WEBHOOK_BODY_BYTES,
    fetch: createWebhookHandler(dependencies),
  });
}
