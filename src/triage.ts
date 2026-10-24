import type { InboxFullMessage } from "shipmail";

import { escalate, runAgent, type AgentResult, type EscalationHook } from "./agent.ts";
import type { EventStore } from "./event-store.ts";
import { messageReceivedSchema, type MessageReceived } from "./events.ts";
import type { StructuredModel } from "./model.ts";
import {
  isSenderAllowed,
  secureInboundMessage,
  securityHold,
  type SecuredInboundMessage,
} from "./security.ts";
import { on, TerminalEventError, type EventHandler, type Logger } from "./server.ts";
import type { InboxApi } from "./shipmail.ts";

const DEFAULT_MAX_REPLIES_PER_THREAD = 3;

/** Supplies trusted facts for the prompt, such as open meeting slots. */
export type ContextLoader = (input: {
  readonly mailboxAddress: string;
  readonly message: SecuredInboundMessage;
}) => Promise<string | null>;

export type TriageOptions = {
  readonly mailboxId: string;
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
  readonly autoSend: boolean;
  readonly requireAuthenticatedSender: boolean;
  readonly inbox: InboxApi;
  readonly model: StructuredModel;
  /** The same store the webhook server uses, so the reply cap is shared across instances. */
  readonly eventStore: EventStore;
  readonly loadContext?: ContextLoader | undefined;
  readonly policy?: string | undefined;
  readonly logger?: Logger | undefined;
  readonly onEscalate?: EscalationHook | undefined;
  readonly maxRepliesPerThread?: number | undefined;
};

export type TriageOutcome = AgentResult | "ignored";

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
  return messages.findLast((message) =>
    message.from?.some((address) => address.email?.toLowerCase() === normalizedSender),
  );
}

export async function triageMessage(
  event: MessageReceived,
  eventId: string,
  options: TriageOptions,
): Promise<TriageOutcome> {
  const logger = options.logger ?? console;
  if (event.mailbox_id !== options.mailboxId) return "ignored";
  const sender = event.from?.address;
  const conversationKey = event.conversation_id ?? event.thread_id;
  if (sender === undefined || conversationKey === null) return "ignored";

  // Checked before the body is fetched, so a blocked sender costs one log line.
  if (!isSenderAllowed(sender, options.allowedSenders)) {
    logger.warn("Blocked inbound sender", { eventId, sender });
    return "ignored";
  }

  const thread = await options.inbox.getInboxThread(event.mailbox_id, conversationKey);
  const conversationId = thread.conversation_id ?? conversationKey;

  // Never reply to ourselves: an allowlisted autoresponder plus AUTO_SEND is a
  // mail loop, and the agent's own address can appear in its own thread.
  if (sender.trim().toLowerCase() === thread.address.trim().toLowerCase()) {
    logger.warn("Skipped a message from the agent mailbox itself", { eventId, conversationId });
    return "ignored";
  }

  const message = selectMessage(thread.data, event.email_id, event.tracked_message_id, sender);
  if (message === undefined || thread.version === null) {
    throw new TerminalEventError(
      "Could not resolve the inbound message or the conversation version",
    );
  }

  const escalation = { eventId, conversationId, sender };
  // Only a DMARC pass counts. SPF alone authenticates the envelope sender, not
  // the From header a person reads, which is the gap a spoofer walks through.
  // Missing results mean unknown, never fine.
  const auth = message.authentication_results;
  if (options.requireAuthenticatedSender && auth?.dmarc !== "pass") {
    logger.warn("Sender authentication did not pass", {
      eventId,
      verdicts: { spf: auth?.spf ?? null, dkim: auth?.dkim ?? null, dmarc: auth?.dmarc ?? null },
    });
    const reason =
      auth === null
        ? "Sender authentication results are missing"
        : "Sender authentication failed because DMARC did not pass";
    return escalate({ ...escalation, reason }, { logger, onEscalate: options.onEscalate });
  }

  const held = securityHold(message.security);
  if (held !== null) {
    return escalate({ ...escalation, reason: held }, { logger, onEscalate: options.onEscalate });
  }

  const secured = secureInboundMessage(
    { sender, subject: message.subject ?? event.subject ?? "", body: message.reply_text ?? "" },
    { allowedSenders: options.allowedSenders, allowedUrlHosts: options.allowedUrlHosts },
  );
  if (!secured.ok) return "ignored";

  const maxReplies = options.maxRepliesPerThread ?? DEFAULT_MAX_REPLIES_PER_THREAD;
  const autoSend =
    options.autoSend && (await options.eventStore.repliesInWindow(conversationId)) < maxReplies;
  if (options.autoSend && !autoSend) {
    logger.warn("Auto-send paused: reply cap reached for this conversation", {
      eventId,
      conversationId,
      maxReplies,
    });
  }

  const context =
    options.loadContext === undefined
      ? null
      : await options.loadContext({ mailboxAddress: thread.address, message: secured.message });

  const result = await runAgent(
    {
      eventId,
      mailboxId: event.mailbox_id,
      conversationId,
      version: thread.version,
      message: secured.message,
      context,
    },
    {
      model: options.model,
      inbox: options.inbox,
      autoSend,
      allowedUrlHosts: options.allowedUrlHosts,
      policy: options.policy,
      logger,
      onEscalate: options.onEscalate,
    },
  );
  if (result.classification === "needs_reply" && result.sent) {
    await options.eventStore.recordReply(conversationId);
  }
  return result;
}

/** The `message.received` handler: triage, then draft, and send only with AUTO_SEND. */
export function triageHandler(options: TriageOptions): EventHandler {
  const logger = options.logger ?? console;
  return on(messageReceivedSchema, async (event, envelope) => {
    const outcome = await triageMessage(event, envelope.event_id, options);
    logger.info("Webhook event processed", {
      eventId: envelope.event_id,
      outcome: outcome === "ignored" ? "ignored" : outcome.classification,
    });
  });
}
