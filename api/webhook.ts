import { ShipMailClient } from "shipmail";

import { createAnthropicTriageModel } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { createWebhookHandler } from "../src/webhook.ts";

const config = loadConfig();
const shipmail = new ShipMailClient(config.shipmailApiKey);
const handler = createWebhookHandler({
  webhookSecret: config.webhookSecret,
  mailboxId: config.mailboxId,
  allowedSenders: config.allowedSenders,
  allowedUrlHosts: config.allowedUrlHosts,
  autoSend: config.autoSend,
  mailboxes: shipmail.mailboxes,
  model: createAnthropicTriageModel(config.anthropicApiKey),
});

export default {
  fetch(request: Request): Promise<Response> {
    return handler(request);
  },
};
