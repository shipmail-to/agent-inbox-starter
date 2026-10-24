# Meeting scheduler

Support triage that can answer "can we meet?". Before Claude sees a message, the recipe reads the
mailbox owner's open slots from the Shipmail calendar and, if configured, a booking link. Those
facts go into the prompt as trusted context, apart from the untrusted email, and a policy line
tells Claude to offer only listed times. Nothing is booked: the reply is a draft, and the person
who answers confirms.

The sender cannot steer which times are offered, because the availability query never reads the
email. The booking link's host is added to the URL allowlist at startup so drafts can include it.

## Run it

Set the triage variables from the main README, then optionally:

| Variable              | Default | Purpose                                  |
| --------------------- | ------- | ---------------------------------------- |
| `SCHEDULING_TIMEZONE` | `UTC`   | Time zone the slots are written in       |
| `MEETING_MINUTES`     | `30`    | Meeting length                           |
| `SCHEDULING_DAYS`     | `7`     | How many days ahead to look              |
| `BOOKING_LINK_ID`     | none    | A Shipmail booking link to offer as well |

```bash
bun run recipe:meeting-scheduler
bun run webhook:create -- --url https://your-host.example/webhook
```

The API key also needs calendar read access, and booking link read access when
`BOOKING_LINK_ID` is set.
