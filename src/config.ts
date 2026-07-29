import { z } from "zod";

// Domains where a *@domain allowlist entry would let anyone with a free account
// through, which defeats the point of allowlisting.
const PUBLIC_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "yandex.com",
  "mail.com",
];

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const csvSchema = z.string().transform(parseCsv);
const optionalCsvSchema = z.string().default("").transform(parseCsv);

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

function assertUsableAllowlist(entries: readonly string[]): void {
  const publicWildcards = entries.filter(
    (entry) => entry.startsWith("*@") && PUBLIC_MAIL_DOMAINS.includes(entry.slice(2)),
  );
  if (publicWildcards.length > 0) {
    throw new Error(
      `SHIPMAIL_ALLOWED_SENDERS cannot use a wildcard for a public mail provider (${publicWildcards.join(", ")}). List individual addresses instead.`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  assertUsableAllowlist(parsed.SHIPMAIL_ALLOWED_SENDERS);
  return {
    shipmailApiKey: parsed.SHIPMAIL_API_KEY,
    mailboxId: parsed.SHIPMAIL_MAILBOX_ID,
    webhookSecret: parsed.SHIPMAIL_WEBHOOK_SECRET,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    port: parsed.PORT,
    allowedSenders: parsed.SHIPMAIL_ALLOWED_SENDERS,
    allowedUrlHosts: parsed.SHIPMAIL_ALLOWED_URL_HOSTS,
    autoSend: parsed.AUTO_SEND,
    // Defaults on whenever AUTO_SEND is on: an unauthenticated sender that can
    // trigger an outbound reply is the case that actually matters.
    requireAuthenticatedSender:
      parsed.REQUIRE_AUTHENTICATED_SENDER === undefined
        ? parsed.AUTO_SEND
        : parsed.REQUIRE_AUTHENTICATED_SENDER === "true",
  };
}
