import { RedisClient } from "bun";
import { ShipMailClient } from "shipmail";

import { createAnthropicTriageModel } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createRedisEventStore } from "./event-store-redis.ts";
import type { EventStore } from "./event-store.ts";
import { startWebhookServer } from "./webhook.ts";

const config = loadConfig();

// Without REDIS_URL the handler falls back to its in-memory store, which is
// correct for exactly one process. Warn rather than fail: a single instance is a
// reasonable way to run this, but silently deduplicating per-process across
// several instances is not.
let eventStore: EventStore | undefined;
if (config.redisUrl === undefined) {
  console.warn(
    "REDIS_URL is not set. Deduplication is in-memory and per-process, so do not run more than one instance.",
  );
} else {
  eventStore = createRedisEventStore({ redis: new RedisClient(config.redisUrl) });
}
const shipmail = new ShipMailClient(config.shipmailApiKey);
const server = startWebhookServer(config.port, {
  webhookSecret: config.webhookSecret,
  mailboxId: config.mailboxId,
  allowedSenders: config.allowedSenders,
  allowedUrlHosts: config.allowedUrlHosts,
  autoSend: config.autoSend,
  requireAuthenticatedSender: config.requireAuthenticatedSender,
  eventStore,
  mailboxes: shipmail.mailboxes,
  model: createAnthropicTriageModel(config.anthropicApiKey),
});
console.info(`Shipmail agent inbox listening on ${server.url}`);
