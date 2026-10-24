import { parseArgs } from "node:util";

import { ShipmailClient } from "shipmail";
import { z } from "zod";

import { waitForVerificationCode } from "./verification.ts";

// Usage: bun recipes/agent-signup-inbox/index.ts --from noreply@service.example
//          [--since 2026-10-24T12:00:00Z] [--timeout 120]
// Prints the code on stdout, so an agent can run it as a tool and read the result.
// Pass --since with the time just before the sign-up form was submitted, so a code
// from an earlier attempt is never returned. Without it, mail from the last 60 seconds counts.
const { values } = parseArgs({
  options: {
    from: { type: "string" },
    since: { type: "string" },
    timeout: { type: "string", default: "120" },
  },
});
const args = z
  .object({
    from: z.string().min(3).includes("@"),
    since: z.iso.datetime({ offset: true }).optional(),
    timeout: z.coerce.number().int().min(5).max(900),
  })
  .parse(values);
const env = z
  .object({ SHIPMAIL_API_KEY: z.string().min(1), SHIPMAIL_MAILBOX_ID: z.string().min(1) })
  .parse(process.env);

const shipmail = new ShipmailClient(env.SHIPMAIL_API_KEY);
const found = await waitForVerificationCode({
  inbox: shipmail.mailboxes,
  mailboxId: env.SHIPMAIL_MAILBOX_ID,
  from: args.from,
  after: args.since === undefined ? new Date(Date.now() - 60_000) : new Date(args.since),
  timeoutMs: args.timeout * 1000,
});
if (found === null) {
  console.error(`No verification code from ${args.from} within ${args.timeout} seconds.`);
  process.exit(1);
}
console.info(found.code);
