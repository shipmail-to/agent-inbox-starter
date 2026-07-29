const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 12_000;
const MAX_DRAFT_LENGTH = 4_000;
const TRUNCATION_MARKER = "\n[content truncated]";
const REMOVED_INSTRUCTION = "[removed: instruction-like content]";
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

// A best-effort signal that a line is trying to steer the model, not a boundary.
// Any wrapping, encoding, or translation defeats these patterns, so a hit escalates
// the message for human review rather than being treated as a fix. See README.
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\b.{0,40}\b(previous|prior|above|system|developer)\b/i,
  /\b(ignore|disregard|override|bypass)\b.{0,40}\b(instruction|rule|policy|guardrail)\b/i,
  /\b(system|developer|assistant)\s*(prompt|message|instruction|role)\b/i,
  /^\s*(system|developer|assistant|tool)\s*:/i,
  /\b(you are now|act as|pretend to be|new role)\b/i,
  /\b(follow|obey|execute|run)\b.{0,30}\b(instruction|command|code|script|tool)\b/i,
  /\b(do not|don'?t)\b.{0,30}\b(classify|triage|escalate|ignore)\b/i,
  /\b(classify|mark|label)\b.{0,30}\b(needs.reply|ignore|escalate)\b/i,
  /\b(output|respond|reply)\b.{0,30}\b(exactly|only|with)\b/i,
  /\b(call|invoke|use)\b.{0,30}\b(tool|function|api|shell|terminal)\b/i,
  /\b(click|open|visit|fetch|download)\b.{0,20}\b(link|url|file|attachment)\b/i,
  /\b(reveal|print|return|send|forward)\b.{0,30}\b(secret|password|credential|token|api key|env)\b/i,
  /<\s*\/?\s*(system|developer|assistant|tool|instructions?)\b/i,
  /\bprompt\s*injection\b/i,
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
  readonly body: string;
  readonly bodyIsHtml: boolean;
};
export type SecuredInboundMessage = {
  readonly sender: string;
  readonly subject: string;
  readonly body: string;
  readonly removedInstructionLines: number;
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

function decodeBasicEntities(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  };
  return value.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (entity) => {
    return entities[entity.toLowerCase()] ?? "";
  });
}

export function stripHtml(value: string): string {
  return decodeBasicEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template|noscript|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
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

function neutralizeInstructions(value: string) {
  let removed = 0;
  const text = value
    .split(/\r?\n/u)
    .map((line) => {
      const normalized = line.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (normalized.length === 0) return "";
      if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
        removed += 1;
        return REMOVED_INSTRUCTION;
      }
      return normalized;
    })
    .join("\n");
  return { text, removed };
}

function sanitizeInbound(
  value: string,
  maxLength: number,
  allowedUrlHosts: readonly string[],
  isHtml: boolean,
) {
  const plain = (isHtml ? stripHtml(value) : value).replace(DANGEROUS_CHARS_REGEX, "");
  const instructions = neutralizeInstructions(plain);
  const urls = rewriteUrls(instructions.text, allowedUrlHosts);
  return {
    text: truncate(urls.text.trim(), maxLength),
    removedInstructionLines: instructions.removed,
    removedUrls: urls.removed,
  };
}

export function secureInboundMessage(
  input: RawInboundMessage,
  policy: SenderPolicy,
): SecurityResult {
  const sender = normalizeAddress(input.sender);
  if (!isSenderAllowed(sender, policy.allowedSenders)) {
    return { ok: false, reason: "sender_not_allowed" };
  }
  const subject = sanitizeInbound(input.subject, MAX_SUBJECT_LENGTH, policy.allowedUrlHosts, false);
  const body = sanitizeInbound(
    input.body,
    MAX_BODY_LENGTH,
    policy.allowedUrlHosts,
    input.bodyIsHtml,
  );
  if (subject.text.length === 0 && body.text.length === 0) {
    return { ok: false, reason: "empty_content" };
  }
  return {
    ok: true,
    message: {
      sender,
      subject: subject.text,
      body: body.text,
      removedInstructionLines: subject.removedInstructionLines + body.removedInstructionLines,
      removedUrls: subject.removedUrls + body.removedUrls,
    },
  };
}

/**
 * Outbound drafts get a narrower pass than inbound mail. The instruction
 * patterns exist to spot an attacker steering the model; running them over the
 * model's own reply rejects ordinary support prose ("click the link in your
 * welcome email"). Here we only enforce the URL allowlist and strip control
 * characters, and we preserve the draft's line structure for the recipient.
 */
export function secureGeneratedReply(
  draft: string,
  allowedUrlHosts: readonly string[],
): { readonly safe: boolean; readonly text: string } {
  const cleaned = draft.replace(DANGEROUS_CHARS_REGEX, "");
  const urls = rewriteUrls(cleaned, allowedUrlHosts);
  const text = truncate(urls.text.trim(), MAX_DRAFT_LENGTH);
  return { safe: text.length > 0 && urls.removed === 0, text };
}
