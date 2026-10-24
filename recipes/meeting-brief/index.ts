import { ShipmailClient } from "shipmail";
import { z } from "zod";

import { webhookEnvSchema } from "../../src/config.ts";
import { eventStoreFromUrl } from "../../src/event-store-redis.ts";
import { createAnthropicModel } from "../../src/model.ts";
import { startWebhookServer } from "../../src/server.ts";
import { meetingBriefHandler } from "./brief.ts";

const env = webhookEnvSchema.extend({ BRIEF_TO: z.email() }).parse(process.env);
const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);

const server = startWebhookServer(env.PORT, {
  webhookSecret: env.SHIPMAIL_WEBHOOK_SECRET,
  eventStore: eventStoreFromUrl(env.REDIS_URL),
  handlers: {
    "calendar.event_starting": meetingBriefHandler({
      mailboxId: env.SHIPMAIL_MAILBOX_ID,
      briefTo: env.BRIEF_TO,
      calendar: shipmail.calendar,
      inbox: shipmail.mailboxes,
      messages: shipmail.messages,
      model: createAnthropicModel(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL),
    }),
  },
});
console.info(`Meeting brief listening on ${server.url}`);
