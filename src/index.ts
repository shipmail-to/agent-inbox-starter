import { ShipMailClient } from "shipmail";

import { createAnthropicTriageModel } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { startWebhookServer } from "./webhook.ts";

const config = loadConfig();
const shipmail = new ShipMailClient(config.shipmailApiKey);
const server = startWebhookServer(config.port, {
  webhookSecret: config.webhookSecret,
  mailboxId: config.mailboxId,
  allowedSenders: config.allowedSenders,
  allowedUrlHosts: config.allowedUrlHosts,
  autoSend: config.autoSend,
  requireAuthenticatedSender: config.requireAuthenticatedSender,
  mailboxes: shipmail.mailboxes,
  model: createAnthropicTriageModel(config.anthropicApiKey),
});
console.info(`Shipmail agent inbox listening on ${server.url}`);
