import type { ContextLoader } from "../../src/triage.ts";
import type { BookingLinksApi, CalendarApi } from "../../src/shipmail.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLOTS = 6;

export const SCHEDULING_POLICY = `Scheduling policy:
- When the sender asks to meet or call, use needs_reply and offer two or three of the open slots
  from the trusted context, or the booking link when one is listed.
- Never invent a time that is not listed, and never say a meeting is booked or confirmed.
- If no slot fits a constraint the sender states, say you will check and get back to them.`;

export type SchedulingOptions = {
  readonly calendar: CalendarApi;
  readonly bookingLinks?: BookingLinksApi | undefined;
  readonly bookingLinkId?: string | undefined;
  readonly timezone: string;
  readonly durationMinutes: number;
  readonly days: number;
  readonly now?: (() => Date) | undefined;
};

export function formatSlot(start: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(start));
}

/**
 * Open slots and the booking link, read from the owner's own calendar. This is
 * trusted context: nothing in it comes from the email, so the sender cannot
 * steer which times are offered.
 */
export function schedulingContext(options: SchedulingOptions): ContextLoader {
  return async ({ mailboxAddress }) => {
    const now = options.now?.() ?? new Date();
    const [availability, link] = await Promise.all([
      options.calendar.availability({
        mailbox: mailboxAddress,
        from: now.toISOString(),
        to: new Date(now.getTime() + options.days * DAY_MS).toISOString(),
        duration: options.durationMinutes,
        timezone: options.timezone,
      }),
      options.bookingLinkId === undefined || options.bookingLinks === undefined
        ? null
        : options.bookingLinks.get(options.bookingLinkId),
    ]);
    const lines = availability.slots
      .slice(0, MAX_SLOTS)
      .map((slot) => `- ${formatSlot(slot.start, options.timezone)}`);
    const slots =
      lines.length === 0
        ? "No open slots in the next days."
        : `Open ${options.durationMinutes}-minute slots:\n${lines.join("\n")}`;
    const booking =
      link?.status === "open" && link.url !== null ? `\nBooking link: ${link.url}` : "";
    return `${slots}${booking}`;
  };
}

/** The booking link's host must be allowlisted, or the outbound link check rejects the draft. */
export function bookingHost(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  return new URL(url).hostname.toLowerCase();
}
