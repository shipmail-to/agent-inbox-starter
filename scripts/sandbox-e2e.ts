import { ShipMailClient } from "shipmail";
import { z } from "zod";

const env = z
  .object({
    SHIPMAIL_API_KEY: z.string().min(1),
    SHIPMAIL_MAILBOX_ID: z.string().min(1),
    SANDBOX_FROM: z.string().email().default("sandbox-sender@example.com"),
  })
  .parse(process.env);

const client = new ShipMailClient(env.SHIPMAIL_API_KEY);
const message = await client.mailboxes.injectSandboxInbound(env.SHIPMAIL_MAILBOX_ID, {
  from: env.SANDBOX_FROM,
  subject: "Shipmail agent inbox sandbox check",
  text: "Hello. Can you confirm that the agent inbox webhook received this sandbox message?",
});
console.info("Sandbox inbound message injected", {
  id: message.id,
  mailboxId: message.mailbox_id,
  threadId: message.thread_id,
  status: message.status,
});
