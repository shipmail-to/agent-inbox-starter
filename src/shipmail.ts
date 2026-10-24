import type {
  BookingLink,
  CalendarEvent,
  InboxReplyDraftSend,
  InboxThreads,
  InboxThreadSummary,
  InboxReplyDraftWrite,
  InboxThreadAttentionResult,
  ShipmailClient,
} from "shipmail";

/**
 * The Shipmail calls the starter makes, typed from the SDK itself. Parameters
 * come straight from `ShipmailClient`, so an SDK upgrade that renames a field
 * fails `bun run typecheck` instead of failing in production. Return types are
 * narrowed to the fields the starter reads, which keeps test fakes small.
 */
type Mailboxes = ShipmailClient["mailboxes"];
type Call<F, R> = F extends (...args: infer A) => unknown ? (...args: A) => Promise<R> : never;

export type InboxApi = {
  readonly getInboxThread: Mailboxes["getInboxThread"];
  readonly createInboxReplyDraft: Call<
    Mailboxes["createInboxReplyDraft"],
    Pick<InboxReplyDraftWrite, "id">
  >;
  readonly sendInboxReplyDraft: Call<
    Mailboxes["sendInboxReplyDraft"],
    Pick<InboxReplyDraftSend, "status">
  >;
  readonly updateInboxThreadAttention: Call<
    Mailboxes["updateInboxThreadAttention"],
    Pick<InboxThreadAttentionResult, "attention_state">
  >;
};

export type InboxSearchApi = {
  readonly listInboxMessages: Mailboxes["listInboxMessages"];
};

export type ThreadSummary = Pick<
  InboxThreadSummary,
  | "conversation_id"
  | "attention_state"
  | "attention_since"
  | "subject"
  | "latest_from_address"
  | "latest_inbound_email_id"
>;

export type ThreadListApi = {
  readonly listInboxThreads: Call<
    Mailboxes["listInboxThreads"],
    { readonly data: readonly ThreadSummary[]; readonly summary: InboxThreads["summary"] }
  >;
};

type Messages = ShipmailClient["messages"];

export type SendApi = {
  readonly send: Call<Messages["send"], { readonly id: string }>;
};

type Calendar = ShipmailClient["calendar"];

export type CalendarApi = {
  readonly availability: Calendar["availability"];
  readonly events: {
    readonly get: Call<
      Calendar["events"]["get"],
      Pick<CalendarEvent, "title" | "start" | "description" | "attendees">
    >;
  };
};

export type BookingLinksApi = {
  readonly get: Call<ShipmailClient["bookingLinks"]["get"], Pick<BookingLink, "status" | "url">>;
};
