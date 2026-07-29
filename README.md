# Shipmail AI agent inbox starter kit

A standalone Bun and TypeScript starter for triaging a Shipmail inbox with Claude. It verifies
Shipmail webhooks, blocks unapproved senders, classifies mail, and creates stale-safe reply drafts.
Sending is off by default.

> **Read the security model before you point this at a real mailbox.** Inbound email is
> attacker-controlled input, and an allowlisted `From` address is only meaningful when sender
> authentication is enforced.

## What happens to an inbound message

1. Shipmail sends a signed `message.received` webhook.
2. The server rejects request bodies larger than 1 MB before signature verification. This applies
   both to declared `Content-Length` values and streamed request bodies.
3. The server verifies the signature and validates the payload.
4. Deliveries flagged `test`, duplicates of an event already seen, and events for another mailbox
   are acknowledged and dropped.
5. The server returns `202` and processes the message on a bounded background queue. Nothing waits
   on a model call inside the request.
6. The visible `From` address is checked before the inbox body is fetched.
7. The webhook `email_id` selects the provider message in the thread. If it is absent or not found,
   the tracked message ID is tried next, followed by the newest message from the sender.
8. When sender authentication is required, the message must carry a DMARC `pass` verdict. Anything
   else is escalated without calling Claude or creating a draft.
9. The message is converted to plain text. Control characters and unapproved URLs are removed. If
   the message contains instruction-like lines, it is escalated without ever reaching the model.
10. Claude classifies the message as `needs_reply`, `ignore`, or `escalate`.
11. Routine replies are saved with `createInboxReplyDraft` and the current `reply_version`.
12. A draft is sent only when `AUTO_SEND=true`, and only until the per-thread reply cap is hit.

Ignored threads are marked `no_reply_expected`. Escalated threads stay in the reply queue and fire
the `onEscalate` hook, which does nothing but log until you wire it to your own review queue.

## Five-minute quickstart

Requirements: [Bun](https://bun.sh), a [Shipmail account](https://shipmail.to), and an Anthropic
API key.

1. In Shipmail, create a mailbox for the agent.
2. Create a scoped API key. Start with inbox read and draft write access. Add send access only if
   you plan to enable `AUTO_SEND`.
3. Copy and fill the environment file:

   ```bash
   cp .env.example .env.local
   ```

4. Install and run the server:

   ```bash
   bun install --ignore-scripts
   bun run dev
   ```

   Bun loads `.env.local` automatically.

5. Expose the local server with either tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   ```bash
   ngrok http 3000
   ```

6. Create a Shipmail webhook for `message.received` at
   `https://your-tunnel.example/webhook`. Put the webhook's signing secret in
   `SHIPMAIL_WEBHOOK_SECRET`.

The health endpoint is `GET /health`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SHIPMAIL_API_KEY` | Scoped Shipmail API key |
| `SHIPMAIL_MAILBOX_ID` | The single mailbox this process accepts |
| `SHIPMAIL_WEBHOOK_SECRET` | Signing secret returned when the webhook is created |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `PORT` | Local HTTP port, defaults to `3000` |
| `REDIS_URL` | Optional. Shared deduplication store. Required if you run more than one instance |
| `SHIPMAIL_ALLOWED_SENDERS` | Required comma-separated addresses or entries like `*@example.com`. Wildcards for public mail providers are rejected at startup |
| `SHIPMAIL_ALLOWED_URL_HOSTS` | Optional exact hosts or entries like `*.example.com` |
| `AUTO_SEND` | Sends generated drafts when `true`. Defaults to `false` |
| `REQUIRE_AUTHENTICATED_SENDER` | Requires a DMARC `pass` before Claude is called. Defaults to the value of `AUTO_SEND`, so it is on by default when automatic sending is on |

The model is fixed to `claude-sonnet-5` in `src/agent.ts`.

## Security model

Email is attacker-controlled input, so start with what this starter cannot do.

> **With `REQUIRE_AUTHENTICATED_SENDER=false`, the `From` address is not authenticated.** The
> allowlist then checks a header an attacker can set to anything, so a spoofed allowlisted sender
> walks straight through. Everything else below reduces blast radius; none of it establishes who
> sent the message. Enforcement defaults to on whenever `AUTO_SEND` is on, which is the case that
> matters, but leaving it off in draft-only mode means a person is reviewing unauthenticated mail.

> **Instruction filtering is a signal, not a boundary.** `INSTRUCTION_PATTERNS` in `src/security.ts`
> is an English, line-based regex list. Spacing out the words, base64, or writing in another
> language all defeat it. Because it cannot be relied on to neutralize anything, a hit escalates the
> message to a human instead of being treated as a fix.

With that said, the controls that do hold:

- A 1 MB webhook body limit enforced before signature verification
- HMAC signature verification with a timestamp window and a constant-time comparison, done on the
  raw body before parsing
- Mailbox ID pinning, and `From` address allowlisting before the inbox body is fetched
- DMARC enforcement when `REQUIRE_AUTHENTICATED_SENDER` is on, which ties the visible `From` domain
  to an aligned SPF or DKIM result. Only a `pass` counts: SPF alone authenticates the envelope
  sender, which can differ from the address a person reads. Missing, malformed, or null results
  escalate rather than being treated as a pass
- Per-event deduplication, so a retry or a replay inside the signature window costs nothing
- A loop guard: the agent never replies to its own address, and each thread has a reply cap
- HTML, scripts, comments, control characters, and Unicode bidirectional controls removed from HTML
  bodies. Plain-text bodies are left intact
- URL host allowlisting, with all other URLs redacted, including non-`http` schemes
- A system policy plus JSON and XML-style untrusted-data delimiters
- Structured outputs plus Zod validation of the model's three allowed decisions
- An outbound link check on generated drafts: a draft that introduces a link outside the allowlist
  is escalated rather than saved
- Draft-only behavior by default
- Shipmail `reply_version` checks and event-based idempotency keys on every write

### What you still own

- **Attachments are not handled at all.** Nothing in `src/` reads them. If you add attachment
  processing, you own zip bombs, XXE, macro documents, and text embedded in images and PDFs.
- **Multi-process deployments need `REDIS_URL`.** Without it the `EventStore` is an in-memory map,
  which is correct for one process only: two instances keep separate maps and both process the same
  retry. Set `REDIS_URL` and deduplication becomes shared. The process logs a warning at startup
  when it is unset, so this is visible rather than silent.
- **Rate limiting and cost.** There is no per-sender rate limit. An allowlisted sender can drive
  model spend.
- **Log retention.** Decisions are logged with the sender address and the classification. Message
  bodies are never logged. Escalation reasons are model-generated text, so they are flattened and
  truncated before logging, but they still reach your logs.
- **Secret rotation.** Rotating `SHIPMAIL_WEBHOOK_SECRET` requires a restart.
- **`isAllowlistableUrl` is not an SSRF control.** It is a syntactic check for redaction and does
  no DNS resolution. If you add a tool that fetches URLs, pin the resolved IP at fetch time.

Review the policy, sender list, model output, and operational logs for your use case. Sensitive,
security, legal, account-access, and financial messages are designed to escalate.

## Testing

The automated tests use fake Shipmail and Anthropic clients and make no network calls:

```bash
bun test
bun run typecheck
```

Shipmail sandbox inbound injection exercises the real mailbox and webhook path without sending mail
over SMTP:

```bash
bun run sandbox:e2e
```

The script calls `mailboxes.injectSandboxInbound`. Its default sender is
`sandbox-sender@example.com`, so add that exact address to `SHIPMAIL_ALLOWED_SENDERS` for the test.
Override it with `SANDBOX_FROM` when needed. The script is not part of `bun test` and requires a
real Shipmail API key.

## Deploy

This runs as a long-lived process, which is what the shape needs: the webhook
acknowledges immediately and finishes the work on a background queue. A serverless
function has nowhere to keep that queue, so use anything that runs a container or a
persistent process. Railway is used below as an example; Fly, Render, and a plain
Docker host work the same way.

Running a single instance needs nothing else. To run more than one, add a Redis
instance and set `REDIS_URL`, which moves deduplication and the per-thread reply cap
into shared state.

Create a service from this repository, add the environment variables from `.env.example`, and use:

```text
bun install --ignore-scripts
bun run start
```

Railway supplies `PORT`, which the starter reads. Set the health check to `/health`, then create the
Shipmail webhook at `https://your-service.example/webhook`.

A serverless platform additionally needs `REDIS_URL`, not just for multiple instances:
a function frozen between invocations cannot remember which events it already handled,
so every retry would be reprocessed.

## Extending it

- **Swap the model provider.** Implement `TriageModel` and pass it to `createWebhookHandler`.
  Nothing else changes. Both examples in `examples/` do exactly this, against the same prompt and
  schema the built-in Anthropic model uses.
- **Route escalations somewhere.** Pass `onEscalate` to send them to Slack, a ticket, or a queue.
- **Replace the event store.** Set `REDIS_URL` to use the Redis implementation, or implement
  `EventStore` from `src/event-store.ts` against something else. `createRedisEventStore` takes any
  client exposing `send(command, args)`, so Bun's built-in client, ioredis, and node-redis all work.

## Examples

- `examples/vercel-ai-sdk`: a `TriageModel` backed by the `ai` package and `@ai-sdk/anthropic`
- `examples/langgraph`: a `TriageModel` backed by a small LangGraph node
- `examples/mcp-client`: hosted HTTP and local stdio MCP configurations plus a tool-listing script

Each example has its own `package.json`, so root tests do not install example dependencies. Install
them with `--ignore-scripts` as well.

## Shipmail links

- [Documentation](https://shipmail.to/docs)
- [Email for AI agents guide](https://shipmail.to/docs/guides/email-for-ai-agents)
- [TypeScript SDK](https://shipmail.to/docs/sdks/typescript)
- [MCP guide](https://shipmail.to/docs/mcp)
- Hosted MCP endpoint: `https://shipmail.to/api/mcp`

## License

MIT. See `LICENSE`.
