import { ShipmailClient } from "shipmail";

import { optionalCsvSchema, webhookEnvSchema } from "../../src/config.ts";
import { eventStoreFromUrl } from "../../src/event-store-redis.ts";
import { createAnthropicModel } from "../../src/model.ts";
import { startWebhookServer } from "../../src/server.ts";
import { followUpHandler } from "./nudger.ts";

const env = webhookEnvSchema
  .extend({ SHIPMAIL_ALLOWED_URL_HOSTS: optionalCsvSchema })
  .parse(process.env);
const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);

const server = startWebhookServer(env.PORT, {
  webhookSecret: env.SHIPMAIL_WEBHOOK_SECRET,
  eventStore: eventStoreFromUrl(env.REDIS_URL),
  handlers: {
    "reply.overdue": followUpHandler({
      mailboxId: env.SHIPMAIL_MAILBOX_ID,
      allowedUrlHosts: env.SHIPMAIL_ALLOWED_URL_HOSTS,
      inbox: shipmail.mailboxes,
      model: createAnthropicModel(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL),
    }),
  },
});
console.info(`Follow-up nudger listening on ${server.url}`);
