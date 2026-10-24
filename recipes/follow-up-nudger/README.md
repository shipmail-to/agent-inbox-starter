# Follow-up nudger

Shipmail sends `reply.overdue` when you wrote last in a conversation and the other side has not
answered in time, three days by default. This recipe reads your last message, asks Claude for a
follow-up of two to four sentences, and saves it as a reply draft. It never sends: whether to chase someone is a
person's call.

The prompt holds only the text you sent, without quoted history. The recipe skips a conversation
nobody else has written in yet, because a reply draft answers the latest inbound message and there
is none.

## Run it

Set `SHIPMAIL_API_KEY`, `SHIPMAIL_MAILBOX_ID`, `SHIPMAIL_WEBHOOK_SECRET` and `ANTHROPIC_API_KEY`.
`SHIPMAIL_ALLOWED_URL_HOSTS` is optional.

```bash
bun run recipe:follow-up-nudger
bun run webhook:create -- --url https://your-host.example/webhook --events reply.overdue
```

The API key needs inbox read and draft write access.
