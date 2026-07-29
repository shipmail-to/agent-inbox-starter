import { z } from "zod";

/**
 * Sender authentication verdicts as Shipmail reports them on an inbox message.
 *
 * The shape mirrors the `authentication_results` field on `inbox_message_full`.
 * The SDK does not declare it yet, so it is declared here and parsed defensively:
 * a payload that does not match is treated as absent rather than trusted.
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
] as const;
export type EmailAuthVerdict = (typeof EMAIL_AUTH_VERDICTS)[number];

export type EmailAuthenticationResults = {
  readonly spf: EmailAuthVerdict;
  readonly dkim: EmailAuthVerdict;
  readonly dmarc: EmailAuthVerdict;
  readonly spam: {
    readonly isSpam: boolean | null;
    readonly scoreMilli: number | null;
  };
  readonly raw: {
    readonly authenticationResults: string | null;
    readonly receivedSpf: string | null;
    readonly spamStatus: string | null;
  };
};

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
