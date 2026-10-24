import type { InboxFullMessage } from "shipmail";
import { z } from "zod";

import { replyOverdueSchema, type ReplyOverdue } from "../../src/events.ts";
import { untrustedBlock, type StructuredModel } from "../../src/model.ts";
import { secureGeneratedReply } from "../../src/security.ts";
import { on, type EventHandler, type Logger } from "../../src/server.ts";
import type { InboxApi } from "../../src/shipmail.ts";

const MAX_FOLLOW_UP_LENGTH = 1_500;

const followUpSchema = z.object({ draft: z.string().min(1).max(MAX_FOLLOW_UP_LENGTH) }).strict();

export const FOLLOW_UP_SYSTEM_PROMPT = `You write follow-up emails for a business inbox.
The user message holds the last email the mailbox owner sent, which got no answer. Write a short,
polite plain-text follow-up of two to four sentences that restates the open question. Do not add
links, prices, dates or promises that are not in that email. Do not apologise for following up.`;

export type NudgerOptions = {
  readonly mailboxId: string;
  readonly allowedUrlHosts: readonly string[];
  readonly inbox: InboxApi;
  readonly model: StructuredModel;
  readonly logger?: Logger | undefined;
};

function sentBy(message: InboxFullMessage, address: string): boolean {
  return message.from?.some((from) => from.email?.toLowerCase() === address) ?? false;
}

export type NudgeOutcome = "drafted" | "skipped";

/**
 * Drafts a follow-up for a conversation that has waited too long for an answer.
 * It only ever saves a draft: a nudge is a judgement call a person should make.
 */
export async function draftFollowUp(
  event: ReplyOverdue,
  eventId: string,
  options: NudgerOptions,
): Promise<NudgeOutcome> {
  const logger = options.logger ?? console;
  if (event.mailbox_id !== options.mailboxId) return "skipped";

  const thread = await options.inbox.getInboxThread(event.mailbox_id, event.conversation_id);
  const own = thread.address.toLowerCase();
  const lastSent = thread.data.findLast((message) => sentBy(message, own));
  // A reply draft answers the latest inbound message, so a conversation the
  // owner started and nobody answered has nothing to reply to.
  const hasInbound = thread.data.some((message) => !sentBy(message, own));
  if (lastSent === undefined || !hasInbound || thread.version === null) {
    logger.info("Skipped a follow-up: no reply draft is possible here", { eventId });
    return "skipped";
  }

  const { draft } = await options.model.generate({
    system: FOLLOW_UP_SYSTEM_PROMPT,
    prompt: untrustedBlock("sent email", {
      subject: lastSent.subject,
      body: lastSent.reply_text,
      waiting_days: event.after_days,
    }),
    schema: followUpSchema,
  });
  const secured = secureGeneratedReply(draft, options.allowedUrlHosts, MAX_FOLLOW_UP_LENGTH);
  if (!secured.safe) {
    logger.warn("Skipped a follow-up that failed the outbound link check", { eventId });
    return "skipped";
  }
  const created = await options.inbox.createInboxReplyDraft(
    event.mailbox_id,
    event.conversation_id,
    { text: secured.text, expected_version: thread.version },
    { idempotencyKey: `agent-inbox-follow-up:${eventId}` },
  );
  logger.info("Follow-up saved as draft", { eventId, draftId: created.id });
  return "drafted";
}

export function followUpHandler(options: NudgerOptions): EventHandler {
  return on(replyOverdueSchema, async (event, envelope) => {
    await draftFollowUp(event, envelope.event_id, options);
  });
}
