import { z } from "zod";

const csvSchema = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0),
);
const optionalCsvSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );
const envSchema = z.object({
  SHIPMAIL_API_KEY: z.string().min(1),
  SHIPMAIL_MAILBOX_ID: z.string().min(1),
  SHIPMAIL_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SHIPMAIL_ALLOWED_SENDERS: csvSchema.pipe(z.array(z.string()).min(1)),
  SHIPMAIL_ALLOWED_URL_HOSTS: optionalCsvSchema,
  AUTO_SEND: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REQUIRE_AUTHENTICATED_SENDER: z.enum(["true", "false"]).optional(),
});
export type AppConfig = {
  readonly shipmailApiKey: string;
  readonly mailboxId: string;
  readonly webhookSecret: string;
  readonly anthropicApiKey: string;
  readonly port: number;
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
  readonly autoSend: boolean;
  readonly requireAuthenticatedSender: boolean;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    shipmailApiKey: parsed.SHIPMAIL_API_KEY,
    mailboxId: parsed.SHIPMAIL_MAILBOX_ID,
    webhookSecret: parsed.SHIPMAIL_WEBHOOK_SECRET,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    port: parsed.PORT,
    allowedSenders: parsed.SHIPMAIL_ALLOWED_SENDERS,
    allowedUrlHosts: parsed.SHIPMAIL_ALLOWED_URL_HOSTS,
    autoSend: parsed.AUTO_SEND,
    requireAuthenticatedSender:
      parsed.REQUIRE_AUTHENTICATED_SENDER === undefined
        ? parsed.AUTO_SEND
        : parsed.REQUIRE_AUTHENTICATED_SENDER === "true",
  };
}
