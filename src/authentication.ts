import type { EmailAuthenticationResults, EmailAuthVerdict } from "shipmail";
import { z } from "zod";

/**
 * Sender authentication verdicts as Shipmail reports them on an inbox message.
 *
 * The types come from the SDK. They are still parsed defensively here because
 * this decides whether a message reaches the model, so a payload that does not
 * match the declared shape is treated as absent rather than trusted.
 */
export const EMAIL_AUTH_VERDICTS = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
  "unknown",
] as const satisfies readonly EmailAuthVerdict[];

// Typed against EmailAuthenticationResults so the schema cannot drift from the type.
const authenticationResultsSchema: z.ZodType<EmailAuthenticationResults> = z.object({
  spf: z.enum(EMAIL_AUTH_VERDICTS),
  dkim: z.enum(EMAIL_AUTH_VERDICTS),
  dmarc: z.enum(EMAIL_AUTH_VERDICTS),
  spam: z.object({
    isSpam: z.boolean().nullable(),
    scoreMilli: z.number().nullable(),
  }),
  raw: z.object({
    authenticationResults: z.string().nullable(),
    receivedSpf: z.string().nullable(),
    spamStatus: z.string().nullable(),
  }),
});

/**
 * Returns null when the field is absent, null, or does not match the contract.
 * Callers must treat null as "unknown", never as "fine": an older mail server or
 * a changed payload shape would otherwise silently disable enforcement.
 */
export function parseAuthenticationResults(value: unknown): EmailAuthenticationResults | null {
  const parsed = authenticationResultsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type { EmailAuthenticationResults, EmailAuthVerdict };
