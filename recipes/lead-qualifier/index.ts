import { ShipmailClient } from "shipmail";
import { z } from "zod";

import { webhookEnvSchema } from "../../src/config.ts";
import { eventStoreFromUrl } from "../../src/event-store-redis.ts";
import { createAnthropicModel } from "../../src/model.ts";
import { startWebhookServer } from "../../src/server.ts";
import { leadHandler, postTo } from "./qualifier.ts";

const env = webhookEnvSchema
  .extend({
    CRM_WEBHOOK_URL: z.url({ protocol: /^https$/ }),
    CRM_WEBHOOK_TOKEN: z.string().min(1).optional(),
  })
  .parse(process.env);
const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);

const server = startWebhookServer(env.PORT, {
  webhookSecret: env.SHIPMAIL_WEBHOOK_SECRET,
  eventStore: eventStoreFromUrl(env.REDIS_URL),
  handlers: {
    "message.received": leadHandler({
      mailboxId: env.SHIPMAIL_MAILBOX_ID,
      inbox: shipmail.mailboxes,
      model: createAnthropicModel(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL),
      deliver: postTo(env.CRM_WEBHOOK_URL, env.CRM_WEBHOOK_TOKEN),
    }),
  },
});
console.info(`Lead qualifier listening on ${server.url}`);
