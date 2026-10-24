import { ShipmailClient } from "shipmail";
import { z } from "zod";

import { blankAsUnset, loadConfig } from "../../src/config.ts";
import { eventStoreFromUrl } from "../../src/event-store-redis.ts";
import { createAnthropicModel } from "../../src/model.ts";
import { startWebhookServer } from "../../src/server.ts";
import { triageHandler } from "../../src/triage.ts";
import { bookingHost, SCHEDULING_POLICY, schedulingContext } from "./scheduling.ts";

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const config = loadConfig();
const scheduling = z
  .object({
    SCHEDULING_TIMEZONE: blankAsUnset(
      z.string().default("UTC").refine(isTimeZone, { message: "Unknown time zone" }),
    ),
    MEETING_MINUTES: blankAsUnset(z.coerce.number().int().min(5).max(480).default(30)),
    SCHEDULING_DAYS: blankAsUnset(z.coerce.number().int().min(1).max(30).default(7)),
    BOOKING_LINK_ID: blankAsUnset(z.string().optional()),
  })
  .parse(process.env);

const shipmail = new ShipmailClient(config.shipmailApiKey);
const eventStore = eventStoreFromUrl(config.redisUrl);

// Read the booking link once so its host can be allowlisted for drafts.
const link =
  scheduling.BOOKING_LINK_ID === undefined
    ? null
    : await shipmail.bookingLinks.get(scheduling.BOOKING_LINK_ID);
const linkHost = bookingHost(link?.url);

const server = startWebhookServer(config.port, {
  webhookSecret: config.webhookSecret,
  eventStore,
  handlers: {
    "message.received": triageHandler({
      mailboxId: config.mailboxId,
      allowedSenders: config.allowedSenders,
      allowedUrlHosts:
        linkHost === null ? config.allowedUrlHosts : [...config.allowedUrlHosts, linkHost],
      autoSend: config.autoSend,
      requireAuthenticatedSender: config.requireAuthenticatedSender,
      inbox: shipmail.mailboxes,
      model: createAnthropicModel(config.anthropicApiKey, config.anthropicModel),
      eventStore,
      policy: SCHEDULING_POLICY,
      loadContext: schedulingContext({
        calendar: shipmail.calendar,
        bookingLinks: shipmail.bookingLinks,
        bookingLinkId: scheduling.BOOKING_LINK_ID,
        timezone: scheduling.SCHEDULING_TIMEZONE,
        durationMinutes: scheduling.MEETING_MINUTES,
        days: scheduling.SCHEDULING_DAYS,
      }),
    }),
  },
});
console.info(`Meeting scheduler listening on ${server.url}`);
