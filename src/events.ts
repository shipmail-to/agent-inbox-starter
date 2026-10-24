import { z } from "zod";

/** The webhook contract version these schemas were written against. */
export const SUPPORTED_WEBHOOK_VERSION = "2026-09-10";

// Deliberately loose: a starter should not stop working the day Shipmail adds a
// field. Validate what the handlers consume and ignore the rest.
export const envelopeSchema = z.looseObject({
  version: z.string().min(1),
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  created_at: z.iso.datetime(),
  test: z.boolean().default(false),
  data: z.unknown(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

// Shipmail already parsed these addresses. A strict email regex here would reject valid ones,
// such as "info=sales@acme.example", and answer 400 for mail that should be processed.
const emailSchema = z.string().min(3).includes("@");
const addressSchema = z.looseObject({ address: emailSchema, name: z.string().nullable() });

export const messageReceivedSchema = z.looseObject({
  tracked_message_id: z.string().min(1),
  mailbox_id: z.string().min(1),
  email_id: z.string().nullable().default(null),
  from: addressSchema.nullable(),
  subject: z.string().nullable().default(null),
  thread_id: z.string().nullable(),
  conversation_id: z.string().nullable().default(null),
});

export type MessageReceived = z.infer<typeof messageReceivedSchema>;

export const replyOverdueSchema = z.looseObject({
  mailbox_id: z.string().min(1),
  mailbox_address: emailSchema,
  conversation_id: z.string().min(1),
  subject: z.string().nullable(),
  after_days: z.number().int(),
});

export type ReplyOverdue = z.infer<typeof replyOverdueSchema>;

export const calendarEventStartingSchema = z.looseObject({
  mailbox_id: z.string().min(1),
  mailbox_address: emailSchema,
  event_id: z.string().min(1),
  title: z.string(),
  starts_at: z.iso.datetime(),
  minutes_before: z.number().int(),
});

export type CalendarEventStarting = z.infer<typeof calendarEventStartingSchema>;
