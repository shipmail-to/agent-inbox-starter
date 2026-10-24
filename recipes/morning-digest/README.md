# Morning digest

A script, not a server. It lists the conversations whose attention state is `needs_reply` or
`follow_up_due`, asks Claude for a one-line summary and a next step for each, and emails the
digest to `DIGEST_TO`. If nothing is waiting, it sends nothing.

Flagged messages are named but not quoted, and links are removed from the digest. The idempotency
key includes the date, so running it twice in one day sends one digest.

## Run it

Set `SHIPMAIL_API_KEY`, `SHIPMAIL_MAILBOX_ID`, `ANTHROPIC_API_KEY` and `DIGEST_TO`.

```bash
bun run recipe:morning-digest
```

Schedule it with cron (`0 8 * * 1-5 cd /srv/agent-inbox && bun run recipe:morning-digest`), your
platform's scheduled jobs, or a GitHub Actions `schedule` trigger. The API key needs inbox read and
send access.

To get the same result with no code, ask Claude or ChatGPT with the Shipmail connector to run the
digest as a scheduled task. See "Use it from an AI assistant" in the main README.
