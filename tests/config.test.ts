import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";

const requiredEnvironment = {
  SHIPMAIL_API_KEY: "sm_test",
  SHIPMAIL_MAILBOX_ID: "mailbox_test",
  SHIPMAIL_WEBHOOK_SECRET: "whsec_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  SHIPMAIL_ALLOWED_SENDERS: "customer@example.com",
};

describe("configuration", () => {
  test("keeps sending off unless it is explicitly enabled", () => {
    expect(loadConfig(requiredEnvironment).autoSend).toBe(false);
  });

  test("keeps authenticated-sender enforcement off in draft-only mode by default", () => {
    expect(loadConfig(requiredEnvironment).requireAuthenticatedSender).toBe(false);
  });

  test("enables authenticated-sender enforcement by default when AUTO_SEND is true", () => {
    expect(
      loadConfig({ ...requiredEnvironment, AUTO_SEND: "true" }).requireAuthenticatedSender,
    ).toBe(true);
  });

  test("allows an explicit authenticated-sender policy in either mode", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        AUTO_SEND: "true",
        REQUIRE_AUTHENTICATED_SENDER: "false",
      }).requireAuthenticatedSender,
    ).toBe(false);
    expect(
      loadConfig({ ...requiredEnvironment, REQUIRE_AUTHENTICATED_SENDER: "true" })
        .requireAuthenticatedSender,
    ).toBe(true);
  });

  test("rejects a wildcard allowlist entry for a public mail provider", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, SHIPMAIL_ALLOWED_SENDERS: "*@gmail.com" }),
    ).toThrow("wildcard for a public mail provider");
  });

  test("allows a wildcard for a domain the operator controls", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      SHIPMAIL_ALLOWED_SENDERS: "*@acme.com,person@example.com",
    });
    expect(config.allowedSenders).toEqual(["*@acme.com", "person@example.com"]);
  });
});
