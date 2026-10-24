import { ShipmailClient } from "shipmail";
import { z } from "zod";

import { recipeEnvSchema } from "../../src/config.ts";
import { createAnthropicModel } from "../../src/model.ts";
import { sendMorningDigest } from "./digest.ts";

// A script, not a server: run it once a day from cron, a scheduled job, or CI.
const env = recipeEnvSchema.extend({ DIGEST_TO: z.email() }).parse(process.env);
const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);

const count = await sendMorningDigest({
  mailboxId: env.SHIPMAIL_MAILBOX_ID,
  digestTo: env.DIGEST_TO,
  inbox: shipmail.mailboxes,
  messages: shipmail.messages,
  model: createAnthropicModel(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL),
});
console.info(
  count === 0 ? "Nothing is waiting. No digest sent." : `Digest sent with ${count} conversations.`,
);
