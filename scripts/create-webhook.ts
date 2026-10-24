import { parseArgs } from "node:util";

import { ShipmailClient, WEBHOOK_EVENT_TYPES } from "shipmail";
import { z } from "zod";

// Usage: bun run webhook:create -- --url https://agent.example/webhook [--events message.received,reply.overdue]
// Creates a webhook scoped to SHIPMAIL_MAILBOX_ID. When SHIPMAIL_ALLOWED_SENDERS is
// set, Shipmail itself drops other senders before anything reaches this server.
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    events: { type: "string", default: "message.received" },
    "authenticated-only": { type: "boolean", default: false },
  },
});
const args = z
  .object({
    url: z.url({ protocol: /^https$/ }),
    events: z
      .string()
      .transform((value) => value.split(",").map((event) => event.trim()))
      .pipe(z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1)),
    "authenticated-only": z.boolean(),
  })
  .parse(values);
const env = z
  .object({
    SHIPMAIL_API_KEY: z.string().min(1),
    SHIPMAIL_MAILBOX_ID: z.string().min(1),
    SHIPMAIL_ALLOWED_SENDERS: z.string().optional(),
  })
  .parse(process.env);

// The webhook takes exact addresses or bare domains, so "*@example.com" becomes "example.com".
const allowedSenders = env.SHIPMAIL_ALLOWED_SENDERS?.split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0)
  .map((entry) => (entry.startsWith("*@") ? entry.slice(2) : entry));

const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);
const webhook = await shipmail.webhooks.create({
  url: args.url,
  events: args.events,
  description: "Shipmail agent inbox starter",
  mailbox_ids: [env.SHIPMAIL_MAILBOX_ID],
  include_reply_text: true,
  authenticated_senders_only: args["authenticated-only"],
  allowed_senders:
    allowedSenders === undefined || allowedSenders.length === 0 ? null : allowedSenders,
});
console.info(`Created webhook ${webhook.id} for ${webhook.events.join(", ")}.`);
console.info("Set this as SHIPMAIL_WEBHOOK_SECRET. Shipmail shows it only once:");
console.info(webhook.secret);
