import { describe, expect, test } from "bun:test";
import type { CalendarAvailability, InboxFullMessage, InboxMessages, InboxThread } from "shipmail";

import {
  extractVerificationCode,
  waitForVerificationCode,
} from "../recipes/agent-signup-inbox/verification.ts";
import { draftFollowUp } from "../recipes/follow-up-nudger/nudger.ts";
import { qualifyLead, type LeadRecord } from "../recipes/lead-qualifier/qualifier.ts";
import { sendMeetingBrief } from "../recipes/meeting-brief/brief.ts";
import { schedulingContext } from "../recipes/meeting-scheduler/scheduling.ts";
import { sendMorningDigest } from "../recipes/morning-digest/digest.ts";
import { messageReceivedSchema } from "../src/events.ts";
import type { StructuredModel, StructuredRequest } from "../src/model.ts";
import type { InboxApi, SendApi, ThreadSummary } from "../src/shipmail.ts";
import {
  authenticationResults,
  CLEAN_SCAN,
  CONVERSATION_ID,
  MAILBOX_ADDRESS,
  MAILBOX_ID,
  message,
  receivedEvent,
  silentLogger,
  thread,
} from "./fixtures.ts";

const flagged = {
  ...CLEAN_SCAN,
  status: "flagged" as const,
  risk_codes: ["role_override" as const],
};

function fakeModel(answer: unknown) {
  const requests: StructuredRequest<unknown>[] = [];
  const model: StructuredModel = {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      requests.push(request);
      return request.schema.parse(answer);
    },
  };
  return { model, requests };
}

function fakeSend() {
  const sent: {
    readonly to: unknown;
    readonly subject: string;
    readonly text: string | undefined;
    readonly key: string | undefined;
  }[] = [];
  const messages: SendApi = {
    async send(params, options) {
      sent.push({
        to: params.to,
        subject: params.subject,
        text: params.text,
        key: options?.idempotencyKey,
      });
      return { id: "msg_sent" };
    },
  };
  return { messages, sent };
}

function draftingInbox(read: () => InboxThread) {
  const drafts: { readonly text: string | undefined; readonly version: number }[] = [];
  const inbox: InboxApi = {
    async getInboxThread() {
      return read();
    },
    async createInboxReplyDraft(_mailboxId, _conversationId, params) {
      drafts.push({ text: params.text, version: params.expected_version });
      return { id: "drf_1" };
    },
    async sendInboxReplyDraft() {
      throw new Error("recipes never send drafts");
    },
    async updateInboxThreadAttention() {
      return { attention_state: "done" };
    },
  };
  return { inbox, drafts };
}

describe("meeting scheduler", () => {
  const availability: CalendarAvailability = {
    object: "calendar_availability",
    mailbox: MAILBOX_ADDRESS,
    from: "2026-10-26T00:00:00.000Z",
    to: "2026-11-02T00:00:00.000Z",
    duration_minutes: 30,
    timezone: "Europe/Paris",
    slots: [{ start: "2026-10-27T09:00:00.000Z", end: "2026-10-27T09:30:00.000Z" }],
  };

  test("lists open slots in the owner's time zone and an open booking link", async () => {
    let asked: { readonly mailbox: string; readonly duration?: number | undefined } | undefined;
    const load = schedulingContext({
      calendar: {
        async availability(params) {
          asked = params;
          return availability;
        },
        events: {
          async get() {
            throw new Error("unused");
          },
        },
      },
      bookingLinks: {
        async get() {
          return { status: "open", url: "https://shipmail.to/book/abc" };
        },
      },
      bookingLinkId: "bkl_1",
      timezone: "Europe/Paris",
      durationMinutes: 30,
      days: 7,
      now: () => new Date("2026-10-26T00:00:00.000Z"),
    });
    const context = await load({
      mailboxAddress: MAILBOX_ADDRESS,
      message: { sender: "a@example.com", subject: "Call?", body: "Can we talk?", removedUrls: 0 },
    });
    expect(asked?.mailbox).toBe(MAILBOX_ADDRESS);
    expect(asked?.duration).toBe(30);
    expect(context).toContain("Tuesday 27 October at 10:00 CET");
    expect(context).toContain("Booking link: https://shipmail.to/book/abc");
  });
});

describe("follow-up nudger", () => {
  const overdue = {
    mailbox_id: MAILBOX_ID,
    mailbox_address: MAILBOX_ADDRESS,
    conversation_id: CONVERSATION_ID,
    subject: "Proposal",
    waiting_on: [{ address: "client@example.com", name: null }],
    after_days: 3,
  };

  test("drafts a follow-up from the owner's last sent message and never sends", async () => {
    const { inbox, drafts } = draftingInbox(() =>
      thread([
        message({
          id: "m1",
          from: "client@example.com",
          subject: "Proposal",
          text: "Send me a quote.",
        }),
        message({
          id: "m2",
          from: MAILBOX_ADDRESS,
          subject: "Re: Proposal",
          text: "Here is the quote. Shall we start?",
        }),
      ]),
    );
    const { model, requests } = fakeModel({ draft: "Just checking whether we can start." });
    const outcome = await draftFollowUp(overdue, "evt_f1", {
      mailboxId: MAILBOX_ID,
      allowedUrlHosts: [],
      inbox,
      model,
      logger: silentLogger,
    });
    expect(outcome).toBe("drafted");
    expect(requests[0]?.prompt).toContain("Shall we start?");
    expect(drafts).toEqual([{ text: "Just checking whether we can start.", version: 7 }]);
  });

  test("skips a conversation nobody else wrote in, because a reply draft needs a source", async () => {
    const { inbox, drafts } = draftingInbox(() =>
      thread([
        message({ id: "m1", from: MAILBOX_ADDRESS, subject: "Intro", text: "Hello there." }),
      ]),
    );
    const { model, requests } = fakeModel({ draft: "unused" });
    const outcome = await draftFollowUp(overdue, "evt_f2", {
      mailboxId: MAILBOX_ID,
      allowedUrlHosts: [],
      inbox,
      model,
      logger: silentLogger,
    });
    expect(outcome).toBe("skipped");
    expect(requests).toEqual([]);
    expect(drafts).toEqual([]);
  });
});

function messagesPage(data: readonly InboxFullMessage[]): InboxMessages {
  return {
    object: "inbox_messages",
    mailbox_id: MAILBOX_ID,
    address: MAILBOX_ADDRESS,
    data,
    junk_total: null,
    pagination: { limit: 10, total: data.length, has_more: false, next_cursor: null },
  };
}

describe("meeting brief", () => {
  test("briefs the owner on each attendee without quoting held messages", async () => {
    const { model, requests } = fakeModel({
      summary: "Ana asked about pricing.",
      open_questions: ["Which plan?"],
    });
    const { messages, sent } = fakeSend();
    const outcome = await sendMeetingBrief(
      {
        mailbox_id: MAILBOX_ID,
        mailbox_address: MAILBOX_ADDRESS,
        event_id: "evt_cal",
        title: "Pricing call",
        starts_at: "2026-10-27T09:00:00.000Z",
        minutes_before: 15,
      },
      "evt_b1",
      {
        mailboxId: MAILBOX_ID,
        briefTo: "owner@example.com",
        calendar: {
          async availability() {
            throw new Error("unused");
          },
          events: {
            async get() {
              return {
                title: "Pricing call",
                start: "2026-10-27T09:00:00.000Z",
                description: null,
                attendees: [
                  { email: MAILBOX_ADDRESS, name: null, status: "accepted" },
                  { email: "ana@example.com", name: "Ana", status: "accepted" },
                ],
              };
            },
          },
        },
        inbox: {
          async listInboxMessages() {
            return messagesPage([
              message({
                id: "m1",
                from: "ana@example.com",
                subject: "Pricing",
                text: "What does Pro cost?",
              }),
              message({
                id: "m2",
                from: "ana@example.com",
                subject: "Odd",
                text: "Secret payload",
                security: flagged,
              }),
            ]);
          },
        },
        messages,
        model,
        logger: silentLogger,
      },
    );
    expect(outcome).toBe("sent");
    expect(requests[0]?.prompt).toContain("What does Pro cost?");
    expect(requests[0]?.prompt).not.toContain("Secret payload");
    expect(sent).toEqual([
      {
        to: ["owner@example.com"],
        subject: "Brief: Pricing call",
        text: "Ana asked about pricing.\n\nOpen questions:\n- Which plan?\n\nStarts in 15 minutes.",
        key: "agent-inbox-brief:evt_b1",
      },
    ]);
  });
});

describe("morning digest", () => {
  function summary(state: "needs_reply" | "follow_up_due", subject: string): ThreadSummary {
    return {
      conversation_id: CONVERSATION_ID,
      attention_state: state,
      subject,
      latest_from_address: "client@example.com",
      attention_since: "2026-10-23T09:00:00.000Z",
      latest_inbound_email_id: "m1",
    };
  }
  const page = (data: readonly ThreadSummary[]) => ({ data });

  test("lists waiting conversations with the model's summary and removes links", async () => {
    const { model } = fakeModel({
      items: [
        {
          conversation_id: CONVERSATION_ID,
          summary: "Client wants a quote, see https://evil.example/x",
          suggested_action: "Send the quote",
        },
      ],
    });
    const { messages, sent } = fakeSend();
    const count = await sendMorningDigest({
      mailboxId: MAILBOX_ID,
      digestTo: "owner@example.com",
      inbox: {
        async listInboxThreads(_mailboxId, params) {
          return page(
            params?.attention_state === "needs_reply" ? [summary("needs_reply", "Quote")] : [],
          );
        },
        async getInboxThread() {
          return thread([
            message({
              id: "m1",
              from: "client@example.com",
              subject: "Quote",
              text: "Quote please.",
            }),
          ]);
        },
      },
      messages,
      model,
      now: () => new Date("2026-10-24T07:00:00.000Z"),
    });
    expect(count).toBe(1);
    expect(sent[0]?.subject).toBe("1 conversations waiting on you");
    expect(sent[0]?.text).toBe(
      "Needs a reply: Quote\nFrom client@example.com\nClient wants a quote, see [link removed]\nNext: Send the quote",
    );
    expect(sent[0]?.key).toBe(`agent-inbox-digest:${MAILBOX_ID}:2026-10-24`);
  });

  test("sends nothing when nothing is waiting", async () => {
    const { model, requests } = fakeModel({ items: [] });
    const { messages, sent } = fakeSend();
    const count = await sendMorningDigest({
      mailboxId: MAILBOX_ID,
      digestTo: "owner@example.com",
      inbox: {
        async listInboxThreads() {
          return page([]);
        },
        async getInboxThread() {
          throw new Error("unused");
        },
      },
      messages,
      model,
    });
    expect(count).toBe(0);
    expect(requests).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("agent sign-up inbox", () => {
  test("extracts the code next to a keyword before any other number", () => {
    expect(extractVerificationCode("Order 123456. Your verification code is 8841.")).toBe("8841");
    expect(extractVerificationCode("Use 482913 to sign in.")).toBe("482913");
    expect(extractVerificationCode("Welcome aboard.")).toBeNull();
  });

  test("accepts only the exact sender with a DMARC pass", async () => {
    const spoofed = message({
      id: "m1",
      from: "noreply@service.example",
      subject: "Your code",
      text: "Your code is 111111",
      auth: authenticationResults("pass", "none", "fail"),
    });
    const lookalike = message({
      id: "m2",
      from: "noreply@service.example.evil.test",
      subject: "Your code",
      text: "Your code is 222222",
      auth: authenticationResults("pass", "pass", "pass"),
    });
    const genuine = message({
      id: "m3",
      from: "noreply@service.example",
      subject: "Your code",
      text: "Your code is 333333",
      auth: authenticationResults("pass", "pass", "pass"),
    });
    let polls = 0;
    const found = await waitForVerificationCode({
      inbox: {
        async listInboxMessages() {
          polls += 1;
          return messagesPage(polls === 1 ? [spoofed, lookalike] : [spoofed, lookalike, genuine]);
        },
      },
      mailboxId: MAILBOX_ID,
      from: "noreply@service.example",
      after: new Date("2026-10-24T11:00:00.000Z"),
      timeoutMs: 60_000,
      sleep: async () => {},
    });
    expect(found).toEqual({ code: "333333", messageId: "m3" });
    expect(polls).toBe(2);
  });
});

describe("lead qualifier", () => {
  const lead = {
    is_lead: true,
    company: "Acme",
    contact_name: "Ana",
    need: "Shared inbox for 12 people",
    budget: null,
    timeline: "Next month",
    fit_score: 4,
    summary: "Acme wants a shared inbox.",
  };
  const received = messageReceivedSchema.parse(
    receivedEvent({ eventId: "evt_l1", from: "ana@acme.example", emailId: "m1" })["data"],
  );

  function qualify(answer: unknown, security = CLEAN_SCAN) {
    const delivered: LeadRecord[] = [];
    const { model, requests } = fakeModel(answer);
    const result = qualifyLead(received, "evt_l1", {
      mailboxId: MAILBOX_ID,
      inbox: {
        async getInboxThread() {
          return thread([
            message({
              id: "m1",
              from: "ana@acme.example",
              subject: "Pricing",
              text: "We are 12 people.",
              security,
            }),
          ]);
        },
      },
      model,
      deliver: async (record) => {
        delivered.push(record);
      },
      logger: silentLogger,
    });
    return { result, delivered, requests };
  }

  test("delivers a structured lead from any sender", async () => {
    const { result, delivered } = qualify(lead);
    await result;
    expect(delivered[0]?.lead?.company).toBe("Acme");
    expect(delivered[0]?.conversation_id).toBe(CONVERSATION_ID);
  });

  test("delivers a held message without calling the model", async () => {
    const { result, delivered, requests } = qualify(lead, flagged);
    await result;
    expect(requests).toEqual([]);
    expect(delivered[0]?.held).toBe("Shipmail flagged this message (role_override)");
    expect(delivered[0]?.lead).toBeNull();
  });

  test("drops mail the model says is not a lead", async () => {
    const { result, delivered } = qualify({ ...lead, is_lead: false });
    expect(await result).toBeNull();
    expect(delivered).toEqual([]);
  });
});
