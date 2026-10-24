# Meeting brief

Shipmail sends `calendar.event_starting` 15 minutes before an event. This recipe reads the event,
finds the last five emails from each attendee, and emails you a short brief: what each person last
discussed and the questions still open.

The brief goes only to `BRIEF_TO`, your own address. Messages Shipmail's scan flagged are listed
but not quoted, and links are removed from the brief.

## Run it

Set `SHIPMAIL_API_KEY`, `SHIPMAIL_MAILBOX_ID`, `SHIPMAIL_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` and
`BRIEF_TO`.

```bash
bun run recipe:meeting-brief
bun run webhook:create -- --url https://your-host.example/webhook --events calendar.event_starting
```

The API key needs calendar read, inbox read and send access.
