import { ShipMailClient } from "shipmail";

import { createAnthropicTriageModel } from "../src/agent.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { createWebhookHandler } from "../src/webhook.ts";

function buildHandler(): (request: Request) => Promise<Response> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error("Agent inbox configuration is invalid", { error: detail });
    throw error;
  }
  const shipmail = new ShipMailClient(config.shipmailApiKey);
  const handler = createWebhookHandler({
    webhookSecret: config.webhookSecret,
    mailboxId: config.mailboxId,
    allowedSenders: config.allowedSenders,
    allowedUrlHosts: config.allowedUrlHosts,
    autoSend: config.autoSend,
    requireAuthenticatedSender: config.requireAuthenticatedSender,
    mailboxes: shipmail.mailboxes,
    model: createAnthropicTriageModel(config.anthropicApiKey),
  });

  // Serverless has nowhere to keep background work: the sandbox can be frozen
  // the moment the response is returned. So we ack, then wait for the queued
  // work before finishing the invocation. That reinstates the timeout coupling
  // the queue exists to avoid, which is why maxDuration is set generously in
  // vercel.json. The long-running deployment in src/index.ts does not do this.
  return async (request: Request): Promise<Response> => {
    const response = await handler.handle(request);
    await handler.drain();
    return response;
  };
}

const handle = buildHandler();

export function POST(request: Request): Promise<Response> {
  return handle(request);
}
