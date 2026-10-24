import type { InboxMessageSecurity } from "shipmail";

const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 12_000;
const MAX_DRAFT_LENGTH = 4_000;
const TRUNCATION_MARKER = "\n[content truncated]";
const REMOVED_URL = "[link removed]";

const DANGEROUS_CHARS_REGEX =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const PRIVATE_HOST_NAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.intranet$/i,
  /\.lan$/i,
  /\.home\.arpa$/i,
];

// Anything scheme-prefixed, plus bare hosts that carry a path. Requiring the path
// keeps ordinary prose ("node.js", "v1.2") out of the match.
const URL_REGEX =
  /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s<>"'`]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`]*/giu;

export type SenderPolicy = {
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
};
export type RawInboundMessage = {
  readonly sender: string;
  readonly subject: string;
  /** Plain text. Use the message's `reply_text`, which Shipmail derives from the text or HTML part. */
  readonly body: string;
};
export type SecuredInboundMessage = {
  readonly sender: string;
  readonly subject: string;
  readonly body: string;
  readonly removedUrls: number;
};
export type SecurityResult =
  | { readonly ok: true; readonly message: SecuredInboundMessage }
  | { readonly ok: false; readonly reason: "sender_not_allowed" | "empty_content" };

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function isSenderAllowed(sender: string, allowlist: readonly string[]): boolean {
  const normalizedSender = normalizeAddress(sender);
  const atIndex = normalizedSender.lastIndexOf("@");
  const senderDomain = atIndex >= 0 ? normalizedSender.slice(atIndex + 1) : "";
  return allowlist.some((entry) => {
    const normalizedEntry = normalizeAddress(entry);
    if (normalizedEntry.startsWith("*@")) {
      return senderDomain.length > 0 && senderDomain === normalizedEntry.slice(2);
    }
    return normalizedSender === normalizedEntry;
  });
}

/**
 * Whether a URL is shaped like one an allowlist entry could name. This is a
 * syntactic check for redaction, not an SSRF control: nothing here resolves DNS,
 * so a public hostname pointing at a private address still passes. If you add a
 * tool that fetches URLs, pin the resolved IP at fetch time.
 */
export function isAllowlistableUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0 || host.startsWith("[")) return false;
  if (PRIVATE_HOST_NAME_PATTERNS.some((pattern) => pattern.test(host))) return false;
  // Reject bare IPs and numeric forms: allowlist entries name hostnames.
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host);
}

export function isUrlAllowed(rawUrl: string, allowedHosts: readonly string[]): boolean {
  if (!isAllowlistableUrl(rawUrl)) return false;
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (normalized.startsWith("*.")) {
      const root = normalized.slice(2);
      return hostname.endsWith(`.${root}`) && hostname !== root;
    }
    return hostname === normalized;
  });
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function rewriteUrls(value: string, allowedHosts: readonly string[]) {
  let removed = 0;
  const text = value.replace(URL_REGEX, (candidate) => {
    const trailing = candidate.match(/[),.;!?]+$/u)?.[0] ?? "";
    const url = trailing.length > 0 ? candidate.slice(0, -trailing.length) : candidate;
    if (isUrlAllowed(url, allowedHosts)) return candidate;
    removed += 1;
    return `${REMOVED_URL}${trailing}`;
  });
  return { text, removed };
}

function sanitizeInbound(value: string, maxLength: number, allowedUrlHosts: readonly string[]) {
  const plain = value.normalize("NFKC").replace(DANGEROUS_CHARS_REGEX, "");
  const urls = rewriteUrls(plain, allowedUrlHosts);
  return { text: truncate(urls.text.trim(), maxLength), removedUrls: urls.removed };
}

export function secureInboundMessage(
  input: RawInboundMessage,
  policy: SenderPolicy,
): SecurityResult {
  const sender = normalizeAddress(input.sender);
  if (!isSenderAllowed(sender, policy.allowedSenders)) {
    return { ok: false, reason: "sender_not_allowed" };
  }
  const subject = sanitizeInbound(input.subject, MAX_SUBJECT_LENGTH, policy.allowedUrlHosts);
  const body = sanitizeInbound(input.body, MAX_BODY_LENGTH, policy.allowedUrlHosts);
  if (subject.text.length === 0 && body.text.length === 0) {
    return { ok: false, reason: "empty_content" };
  }
  return {
    ok: true,
    message: {
      sender,
      subject: subject.text,
      body: body.text,
      removedUrls: subject.removedUrls + body.removedUrls,
    },
  };
}

/**
 * Model output that will reach a person: enforce the URL allowlist, strip
 * control characters, and keep the line structure. A draft that introduces a
 * link outside the allowlist is unsafe rather than silently rewritten.
 */
export function secureGeneratedReply(
  draft: string,
  allowedUrlHosts: readonly string[],
  maxLength: number = MAX_DRAFT_LENGTH,
): { readonly safe: boolean; readonly text: string } {
  const cleaned = draft.replace(DANGEROUS_CHARS_REGEX, "");
  const urls = rewriteUrls(cleaned, allowedUrlHosts);
  const text = truncate(urls.text.trim(), maxLength);
  return { safe: text.length > 0 && urls.removed === 0, text };
}

/**
 * Shipmail scans every inbound message for prompt injection. Only a clean scan,
 * or a person releasing a flagged message, lets it reach the model. A message
 * that could not be scanned is held too: unknown is never treated as clean.
 */
export function securityHold(security: InboxMessageSecurity): string | null {
  if (security.review !== null) return null;
  if (security.status === "not_flagged") return null;
  if (security.status === "not_scanned") return "Shipmail could not scan this message";
  return `Shipmail flagged this message (${security.risk_codes.join(", ") || "unspecified"})`;
}
