# Agent sign-up inbox

Agents that sign up to services need an address that receives the verification email. Give the
agent its own Shipmail mailbox. Have it note the time, submit the sign-up form, then run:

```bash
bun run recipe:signup-code -- --from noreply@service.example --since 2026-10-24T12:00:00Z
```

`--since` keeps a code from an earlier attempt out of the result. Without it, mail from the last 60
seconds counts. `--timeout` defaults to 120 seconds.

It polls the mailbox, prints the code on stdout, and exits with status 1 if none arrives in time,
so an agent can call it as a tool. There is no model call: a regular expression takes the code
next to a word like "code", or else the first six-digit number.

The sender must match `--from` exactly and pass DMARC. Without that check, anyone could send a
message with the service's `From` address and choose the code the agent submits. The command
reads codes only, never links.

Set `SHIPMAIL_API_KEY` and `SHIPMAIL_MAILBOX_ID`. The API key needs inbox read access.

Use `waitForVerificationCode` from `verification.ts` to call it from your own code instead.
