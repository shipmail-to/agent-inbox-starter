import type {
  EmailAuthenticationResults,
  EmailAuthVerdict,
  InboxFullMessage,
  InboxMessageSecurity,
  InboxThread,
} from "shipmail";

import { SUPPORTED_WEBHOOK_VERSION } from "../src/events.ts";
import type { Logger } from "../src/server.ts";

export const silentLogger: Logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

export const MAILBOX_ID = "mailbox_123";
export const MAILBOX_ADDRESS = "agent@example.test";
export const CONVERSATION_ID = "thd_123";

export const CLEAN_SCAN: InboxMessageSecurity = {
  status: "not_flagged",
  risk_codes: [],
  scanner: "pattern_v1",
  content_sha256: "0".repeat(64),
  review: null,
};

type MessageOptions = {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly auth?: EmailAuthenticationResults | null | undefined;
  readonly security?: InboxMessageSecurity | undefined;
};

export function authenticationResults(
  spf: EmailAuthVerdict,
  dkim: EmailAuthVerdict,
  dmarc: EmailAuthVerdict,
): EmailAuthenticationResults {
  return {
    spf,
    dkim,
    dmarc,
    spam: { isSpam: false, scoreMilli: 0 },
    raw: { authenticationResults: null, receivedSpf: null, spamStatus: null },
  };
}

export function message(options: MessageOptions): InboxFullMessage {
  return {
    object: "inbox_message_full",
    id: options.id,
    thread_id: "thread_123",
    conversation_id: CONVERSATION_ID,
    mailbox_id: MAILBOX_ID,
    address: MAILBOX_ADDRESS,
    folder_ids: [],
    keywords: {},
    from: [{ name: null, email: options.from }],
    to: null,
    cc: null,
    reply_to: null,
    subject: options.subject,
    received_at: "2026-10-24T12:00:00.000Z",
    size: options.text.length,
    preview: options.text.slice(0, 40),
    has_attachment: false,
    message_id: null,
    in_reply_to: null,
    references: null,
    body_values: { part: { value: options.text, is_encoding_problem: false } },
    text_body: [{ part_id: "part", type: "text/plain" }],
    html_body: [],
    attachments: [],
    reply_text: options.text,
    authentication_results: options.auth ?? null,
    security: options.security ?? CLEAN_SCAN,
  };
}

export function thread(
  messages: readonly InboxFullMessage[],
  options: { readonly address?: string; readonly version?: number | null } = {},
): InboxThread {
  return {
    object: "inbox_thread",
    mailbox_id: MAILBOX_ID,
    address: options.address ?? MAILBOX_ADDRESS,
    thread_id: "thread_123",
    conversation_id: CONVERSATION_ID,
    version: options.version === undefined ? 7 : options.version,
    data: messages,
  };
}

type EventOptions = {
  readonly eventId: string;
  readonly from: string;
  readonly emailId?: string | null | undefined;
  readonly trackedMessageId?: string | undefined;
  readonly subject?: string | undefined;
  readonly test?: boolean | undefined;
};

export function envelope(
  eventId: string,
  eventType: string,
  data: Readonly<Record<string, unknown>>,
  test = false,
): Record<string, unknown> {
  return {
    version: SUPPORTED_WEBHOOK_VERSION,
    event_id: eventId,
    event_type: eventType,
    created_at: "2026-10-24T12:00:00.000Z",
    test,
    data,
  };
}

export function receivedEvent(options: EventOptions): Record<string, unknown> {
  return envelope(
    options.eventId,
    "message.received",
    {
      tracked_message_id: options.trackedMessageId ?? "msg_123",
      mailbox_id: MAILBOX_ID,
      client_reference: null,
      rfc_message_id: null,
      email_id: options.emailId ?? null,
      from: { address: options.from, name: null },
      to: [{ address: MAILBOX_ADDRESS, name: null }],
      cc: [],
      bcc: [],
      subject: options.subject ?? "Question",
      thread_id: "thread_123",
      conversation_id: CONVERSATION_ID,
      received_at: "2026-10-24T12:00:00.000Z",
    },
    options.test ?? false,
  );
}

export function webhookRequest(payload: unknown): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
