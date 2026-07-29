import type { InboxFullMessage, InboxThread, InboxThreads } from "shipmail";

import type { Logger } from "../src/agent.ts";
import type { EmailAuthenticationResults, EmailAuthVerdict } from "../src/authentication.ts";

export const silentLogger: Logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

export const MAILBOX_ID = "mailbox_123";
export const MAILBOX_ADDRESS = "agent@example.test";

type MessageOptions = {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  readonly auth?: EmailAuthenticationResults | null | undefined;
};

/** shipmail 0.4.6 does not declare authentication_results, so widen the fixture type. */
export type ThreadMessageFixture = InboxFullMessage & {
  readonly authentication_results?: EmailAuthenticationResults | null;
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

export function message(options: MessageOptions): ThreadMessageFixture {
  const hasText = options.text !== undefined;
  const value = options.text ?? options.html ?? "";
  return {
    object: "inbox_message_full",
    id: options.id,
    thread_id: "thread_123",
    mailbox_id: MAILBOX_ID,
    address: MAILBOX_ADDRESS,
    folder_ids: [],
    keywords: {},
    from: [{ name: null, email: options.from }],
    to: null,
    cc: null,
    reply_to: null,
    subject: options.subject,
    received_at: "2026-07-29T12:00:00.000Z",
    size: value.length,
    preview: value.slice(0, 40),
    has_attachment: false,
    message_id: null,
    in_reply_to: null,
    references: null,
    body_values: { part: { value, is_encoding_problem: false } },
    text_body: hasText ? [{ part_id: "part", type: "text/plain" }] : [],
    html_body: hasText ? [] : [{ part_id: "part", type: "text/html" }],
    attachments: [],
    ...(options.auth === undefined ? {} : { authentication_results: options.auth }),
  };
}

export function thread(
  threadId: string,
  messages: readonly ThreadMessageFixture[],
  address: string = MAILBOX_ADDRESS,
): InboxThread {
  return {
    object: "inbox_thread",
    mailbox_id: MAILBOX_ID,
    address,
    thread_id: threadId,
    data: messages,
  };
}

export function threadPage(
  entries: readonly { readonly thread_id: string; readonly reply_version: number }[],
  nextCursor: string | null = null,
): InboxThreads {
  return {
    object: "inbox_threads",
    mailbox_id: MAILBOX_ID,
    data: entries.map((entry) => ({
      object: "inbox_thread_summary",
      id: `sum_${entry.thread_id}`,
      thread_id: entry.thread_id,
      reply_state: "needs_reply",
      reply_version: entry.reply_version,
      needs_reply_since: null,
      subject: null,
      latest_from_address: null,
      message_count: 1,
      first_message_at: "2026-07-29T12:00:00.000Z",
      last_message_at: "2026-07-29T12:00:00.000Z",
      latest_message_id: null,
      latest_email_id: null,
      latest_inbound_message_id: null,
      latest_inbound_email_id: null,
      latest_inbound_at: null,
      latest_outbound_message_id: null,
      latest_outbound_email_id: null,
      latest_outbound_at: null,
    })),
    summary: { needs_reply: 1, waiting_on_contact: 0, resolved: 0, no_reply_expected: 0 },
    pagination: {
      limit: 100,
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
      snapshot_at: "2026-07-29T12:00:00.000Z",
    },
  };
}

type EventOptions = {
  readonly eventId: string;
  readonly threadId: string;
  readonly from: string;
  readonly emailId?: string | null | undefined;
  readonly trackedMessageId?: string | undefined;
  readonly subject?: string | undefined;
  readonly test?: boolean | undefined;
};

export function receivedEvent(options: EventOptions): Record<string, unknown> {
  return {
    version: "2026-07-22",
    event_id: options.eventId,
    event_type: "message.received",
    created_at: "2026-07-29T12:00:00.000Z",
    test: options.test ?? false,
    data: {
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
      thread_id: options.threadId,
      received_at: "2026-07-29T12:00:00.000Z",
    },
  };
}

export function webhookRequest(payload: unknown): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
