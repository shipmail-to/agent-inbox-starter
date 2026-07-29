import { isIP } from "node:net";

const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 12_000;
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
const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/giu;

export type SenderPolicy = {
  readonly allowedSenders: readonly string[];
  readonly allowedUrlHosts: readonly string[];
};
export type RawInboundMessage = {
  readonly sender: string;
  readonly subject: string;
  readonly body: string;
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

function ipv4ToOctets(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIPv4(address: string): boolean {
  const octets = ipv4ToOctets(address);
  if (octets === null) return true;
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && (second === 0 || second === 168)) return true;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
  if (first === 203 && second === 0) return true;
  return false;
}

function expandIPv6(address: string): readonly string[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  function expandMixed(parts: readonly string[]): string[] | null {
    if (parts.length === 0) return [];
    const last = parts.at(-1) ?? "";
    if (!last.includes(".")) return [...parts];
    const octets = ipv4ToOctets(last);
    if (octets === null) return null;
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    return [...parts.slice(0, -1), high, low];
  }
  const leftRaw = halves[0] ?? "";
  const rightRaw = halves[1] ?? "";
  const left = expandMixed(leftRaw.length === 0 ? [] : leftRaw.split(":"));
  const right = expandMixed(rightRaw.length === 0 ? [] : rightRaw.split(":"));
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const fillCount = 8 - left.length - right.length;
  if (fillCount < 1) return null;
  return [...left, ...Array.from({ length: fillCount }, () => "0"), ...right];
}

function isPrivateIPv6(address: string): boolean {
  const segments = expandIPv6(address);
  if (segments === null || segments.length !== 8) return true;
  const values = segments.map((segment) => Number.parseInt(segment, 16));
  if (values.some((segment) => Number.isNaN(segment))) return true;
  const first = values[0] ?? 0;
  const leadingZero = values.slice(0, 7).every((segment) => segment === 0);
  if (leadingZero && ((values[7] ?? 0) === 0 || (values[7] ?? 0) === 1)) return true;
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  if (first >= 0xff00) return true;
  if ((values[0] ?? 0) === 0x2001 && (values[1] ?? 0) === 0x0db8) return true;
  if ((values[0] ?? 0) === 0x0064 && (values[1] ?? 0) === 0xff9b) return true;
  const mapped =
    values.slice(0, 5).every((segment) => segment === 0) && (values[5] ?? 0) === 0xffff;
  if (mapped) {
    const high = values[6] ?? 0;
    const low = values[7] ?? 0;
    return isPrivateIPv4(
      `${(high >>> 8) & 0xff}.${high & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`,
    );
  }
  return values.slice(0, 6).every((segment) => segment === 0);
}

export function isPublicHttpsUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0 || PRIVATE_HOST_NAME_PATTERNS.some((pattern) => pattern.test(host))) {
    return false;
  }
  const addressKind = isIP(host);
  if (addressKind === 4) return !isPrivateIPv4(host);
  if (addressKind === 6) return !isPrivateIPv6(host);
  if (/^[0-9]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false;
  return true;
}

export function isUrlAllowed(rawUrl: string, allowedHosts: readonly string[]): boolean {
  if (!isPublicHttpsUrl(rawUrl)) return false;
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

function sanitizeContent(value: string, maxLength: number, allowedUrlHosts: readonly string[]) {
  const plain = stripHtml(value).replace(DANGEROUS_CHARS_REGEX, "");
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
  const subject = sanitizeContent(input.subject, MAX_SUBJECT_LENGTH, policy.allowedUrlHosts);
  const body = sanitizeContent(input.body, MAX_BODY_LENGTH, policy.allowedUrlHosts);
  if (subject.text.length === 0 && body.text.length === 0) {
    return { ok: false, reason: "empty_content" };
  }
  return {
    ok: true,
    message: {
      sender,
      subject: subject.text,
      body: body.text,
      removedInstructionLines:
        subject.removedInstructionLines + body.removedInstructionLines,
      removedUrls: subject.removedUrls + body.removedUrls,
    },
  };
}

export function secureGeneratedReply(
  draft: string,
  allowedUrlHosts: readonly string[],
): { readonly safe: boolean; readonly text: string } {
  const result = sanitizeContent(draft, 4_000, allowedUrlHosts);
  return {
    safe: result.text.length > 0 && result.removedInstructionLines === 0,
    text: result.text,
  };
}
