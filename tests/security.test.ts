import { describe, expect, test } from "bun:test";

import {
  isAllowlistableUrl,
  isSenderAllowed,
  isUrlAllowed,
  secureGeneratedReply,
  secureInboundMessage,
  securityHold,
} from "../src/security.ts";

const policy = { allowedSenders: ["customer@example.com"], allowedUrlHosts: [] };

describe("sender allowlist", () => {
  test("matches exact addresses without case sensitivity", () => {
    expect(isSenderAllowed(" Customer@Example.com ", ["customer@example.com"])).toBe(true);
    expect(isSenderAllowed("other@example.com", ["customer@example.com"])).toBe(false);
  });
  test("supports an explicit domain wildcard", () => {
    expect(isSenderAllowed("person@example.com", ["*@example.com"])).toBe(true);
    expect(isSenderAllowed("person@sub.example.com", ["*@example.com"])).toBe(false);
  });
});

describe("content hardening", () => {
  test("removes control and bidirectional characters", () => {
    const result = secureInboundMessage(
      {
        sender: "customer@example.com",
        subject: "Account question",
        body: "Can you tell me when my order ships?\u202E\u0007",
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).toBe("Can you tell me when my order ships?");
  });

  test("keeps angle brackets in a plain-text body", () => {
    const result = secureInboundMessage(
      {
        sender: "customer@example.com",
        subject: "Quote",
        body: "Contact us at <sales@example.com> if 3 < 5 and x > y.",
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).toContain("<sales@example.com>");
  });

  test("rejects a sender before content is accepted", () => {
    expect(
      secureInboundMessage({ sender: "other@example.com", subject: "Hi", body: "Hello" }, policy),
    ).toEqual({ ok: false, reason: "sender_not_allowed" });
  });
});

describe("Shipmail security scan", () => {
  const scan = {
    status: "not_flagged" as const,
    risk_codes: [],
    scanner: "pattern_v1" as const,
    content_sha256: "0".repeat(64),
    review: null,
  };

  test("lets only a clean scan or a released message through", () => {
    expect(securityHold(scan)).toBeNull();
    expect(securityHold({ ...scan, status: "not_scanned" })).toBe(
      "Shipmail could not scan this message",
    );
    expect(
      securityHold({
        ...scan,
        status: "flagged",
        risk_codes: ["role_override", "covert_instruction"],
      }),
    ).toBe("Shipmail flagged this message (role_override, covert_instruction)");
    expect(
      securityHold({
        ...scan,
        status: "flagged",
        review: {
          decision: "released",
          released_at: "2026-10-24T12:00:00.000Z",
          released_by: "user",
        },
      }),
    ).toBeNull();
  });
});

describe("URL policy", () => {
  test("accepts only allowlistable HTTPS hostnames", () => {
    expect(isAllowlistableUrl("https://docs.shipmail.to/guide")).toBe(true);
    expect(isAllowlistableUrl("http://docs.shipmail.to/guide")).toBe(false);
    expect(isAllowlistableUrl("https://localhost/admin")).toBe(false);
    expect(isAllowlistableUrl("https://127.0.0.1/admin")).toBe(false);
    expect(isAllowlistableUrl("https://[::1]/admin")).toBe(false);
    expect(isAllowlistableUrl("https://user:pass@example.com/")).toBe(false);
  });

  test("requires an exact or explicit wildcard host entry", () => {
    expect(isUrlAllowed("https://docs.shipmail.to/guide", ["docs.shipmail.to"])).toBe(true);
    expect(isUrlAllowed("https://cdn.example.com/file", ["*.example.com"])).toBe(true);
    expect(isUrlAllowed("https://example.com/file", ["*.example.com"])).toBe(false);
    expect(isUrlAllowed("https://evil.example.net/file", ["*.example.com"])).toBe(false);
  });

  test("redacts URLs that are not allowlisted", () => {
    const result = secureInboundMessage(
      {
        sender: "customer@example.com",
        subject: "Question",
        body: "See https://127.0.0.1/admin and https://evil.example.net/payload.",
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).toBe("See [link removed] and [link removed].");
    expect(result.message.removedUrls).toBe(2);
  });

  test("redacts non-http schemes and bare hosts with a path", () => {
    const result = secureInboundMessage(
      {
        sender: "customer@example.com",
        subject: "Question",
        body: "Try mailto:x@evil.tld or evil.tld/pwn or data:text/html,x",
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).not.toContain("evil.tld");
    expect(result.message.body).not.toContain("data:text/html");
    expect(result.message.removedUrls).toBe(3);
  });
});

describe("outbound draft checks", () => {
  test("passes ordinary support prose that reads like an instruction", () => {
    const drafts = [
      "Please click the link in your welcome email to reset your password.",
      "Reply with your order number and we will take a look.",
      "Open the attachment I sent earlier for the invoice.",
      "Our support hours are 9-5 ET.",
    ];
    for (const draft of drafts) {
      expect(secureGeneratedReply(draft, []).safe).toBe(true);
    }
  });

  test("preserves paragraph structure", () => {
    const draft = "Thanks for reaching out.\n\nYour order ships Tuesday.";
    expect(secureGeneratedReply(draft, []).text).toBe(draft);
  });

  test("rejects a draft that introduces a link outside the allowlist", () => {
    const result = secureGeneratedReply("See https://evil.example.net/reset", []);
    expect(result.safe).toBe(false);
  });

  test("keeps an allowlisted link", () => {
    const result = secureGeneratedReply("See https://docs.shipmail.to/guide", ["docs.shipmail.to"]);
    expect(result.safe).toBe(true);
    expect(result.text).toContain("https://docs.shipmail.to/guide");
  });

  test("rejects an empty draft", () => {
    expect(secureGeneratedReply("   ", []).safe).toBe(false);
  });
});
