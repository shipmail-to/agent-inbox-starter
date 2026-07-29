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
  test("keeps the reserved authenticated-sender policy disabled by default", () => {
    expect(loadConfig(requiredEnvironment).requireAuthenticatedSender).toBe(false);
  });

  test("fails closed when the unavailable authenticated-sender policy is enabled", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, REQUIRE_AUTHENTICATED_SENDER: "true" }),
    ).toThrow("Shipmail inbox messages do not expose authentication results");
  });
});
