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
});
