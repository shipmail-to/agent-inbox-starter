import type { InboxFullMessage } from "shipmail";

import type { InboxSearchApi } from "../../src/shipmail.ts";

const NEAR_KEYWORD = /\b(?:code|otp|pin|passcode|password)\b\D{0,40}?\b(\d{4,8})\b/iu;
const SIX_DIGITS = /\b(\d{6})\b/u;

/** A code next to a word like "code", else the first six-digit number. No model involved. */
export function extractVerificationCode(text: string): string | null {
  return NEAR_KEYWORD.exec(text)?.[1] ?? SIX_DIGITS.exec(text)?.[1] ?? null;
}

export type WaitOptions = {
  readonly inbox: InboxSearchApi;
  readonly mailboxId: string;
  /** The exact sender address the service mails codes from. */
  readonly from: string;
  /** Ignore mail received before this instant, such as codes from an earlier attempt. */
  readonly after: Date;
  readonly timeoutMs: number;
  readonly pollMs?: number | undefined;
  /**
   * Requires a DMARC pass. Leave it on: without it anyone can send a message
   * with the service's From address and choose the code the agent submits.
   */
  readonly requireAuthenticatedSender?: boolean | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type VerificationCode = { readonly code: string; readonly messageId: string };

function trusted(message: InboxFullMessage, from: string, requireAuth: boolean): boolean {
  // The list filter matches names and substrings, so check the address exactly.
  const exact = message.from?.some((address) => address.email?.toLowerCase() === from) ?? false;
  return exact && (!requireAuth || message.authentication_results?.dmarc === "pass");
}

/**
 * Polls the mailbox until the service's verification email arrives, for an
 * agent that signs up to a service with its own Shipmail address.
 */
export async function waitForVerificationCode(
  options: WaitOptions,
): Promise<VerificationCode | null> {
  const from = options.from.trim().toLowerCase();
  const requireAuth = options.requireAuthenticatedSender ?? true;
  const pollMs = options.pollMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    const page = await options.inbox.listInboxMessages(options.mailboxId, {
      from,
      after: options.after.toISOString(),
      limit: 10,
    });
    const newestFirst = [...page.data].sort((a, b) => b.received_at.localeCompare(a.received_at));
    for (const message of newestFirst) {
      if (!trusted(message, from, requireAuth)) continue;
      const code = extractVerificationCode(`${message.subject ?? ""}\n${message.reply_text ?? ""}`);
      if (code !== null) return { code, messageId: message.id };
    }
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}
