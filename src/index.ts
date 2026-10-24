import { ShipmailClient } from "shipmail";

import { loadConfig } from "./config.ts";
import { eventStoreFromUrl } from "./event-store-redis.ts";
import { createAnthropicModel } from "./model.ts";
import { startWebhookServer } from "./server.ts";
import { triageHandler } from "./triage.ts";

const config = loadConfig();
const eventStore = eventStoreFromUrl(config.redisUrl);
const shipmail = new ShipmailClient(config.shipmailApiKey);

const server = startWebhookServer(config.port, {
  webhookSecret: config.webhookSecret,
  eventStore,
  handlers: {
    "message.received": triageHandler({
      mailboxId: config.mailboxId,
      allowedSenders: config.allowedSenders,
      allowedUrlHosts: config.allowedUrlHosts,
      autoSend: config.autoSend,
      requireAuthenticatedSender: config.requireAuthenticatedSender,
      inbox: shipmail.mailboxes,
      model: createAnthropicModel(config.anthropicApiKey, config.anthropicModel),
      eventStore,
    }),
  },
});
console.info(`Shipmail agent inbox listening on ${server.url}`);
