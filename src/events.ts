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

const addressSchema = z.looseObject({ address: z.email(), name: z.string().nullable() });

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
  mailbox_address: z.email(),
  conversation_id: z.string().min(1),
  subject: z.string().nullable(),
  waiting_on: z.array(addressSchema),
  after_days: z.number().int(),
});

export type ReplyOverdue = z.infer<typeof replyOverdueSchema>;

export const calendarEventStartingSchema = z.looseObject({
  mailbox_id: z.string().min(1),
  mailbox_address: z.email(),
  event_id: z.string().min(1),
  title: z.string(),
  starts_at: z.iso.datetime(),
  minutes_before: z.number().int(),
});

export type CalendarEventStarting = z.infer<typeof calendarEventStartingSchema>;
