# Shipmail AI agent inbox starter kit

A Bun and TypeScript starter for putting an AI agent on a [Shipmail](https://shipmail.to) inbox.
The core verifies Shipmail webhooks, checks who sent each message, and lets Claude triage it into a
reply draft. Six recipes reuse that core for scheduling, follow-ups, meeting briefs, a morning
digest, sign-up codes and lead capture. Sending is off by default.

> **Read the security model before you point this at a real mailbox.** Inbound email is
> attacker-controlled input, and an allowlisted `From` address is only meaningful when sender
> authentication is enforced.

## Pick a starting point

| Recipe | Trigger | What it does | Run |
| --- | --- | --- | --- |
| Support triage | `message.received` | Classifies mail and saves reply drafts | `bun run start` |
| [Meeting scheduler](recipes/meeting-scheduler) | `message.received` | Triage that offers open slots from your calendar | `bun run recipe:meeting-scheduler` |
| [Follow-up nudger](recipes/follow-up-nudger) | `reply.overdue` | Drafts a follow-up when someone has not answered | `bun run recipe:follow-up-nudger` |
| [Meeting brief](recipes/meeting-brief) | `calendar.event_starting` | Emails you a brief on the attendees before a meeting | `bun run recipe:meeting-brief` |
| [Morning digest](recipes/morning-digest) | A daily schedule | Emails you what waits on you, one line each | `bun run recipe:morning-digest` |
| [Agent sign-up inbox](recipes/agent-signup-inbox) | Polling | Gives an agent the verification code a service sent it | `bun run recipe:signup-code -- --from …` |
| [Lead qualifier](recipes/lead-qualifier) | `message.received` | Turns sales mail into a scored record in your CRM | `bun run recipe:lead-qualifier` |

No recipe sends mail to anyone but you. The triage server sends a reply only with `AUTO_SEND=true`.

If you want an assistant without running a server, skip to
[Use it from an AI assistant](#use-it-from-an-ai-assistant).

## What happens to an inbound message

1. Shipmail sends a signed `message.received` webhook. Created with `bun run webhook:create`, the
   webhook is scoped to one mailbox and Shipmail drops senders outside the allowlist before
   delivery.
2. The server rejects request bodies larger than 1 MB before signature verification, both for a
   declared `Content-Length` and for a streamed body.
3. The server verifies the signature and validates the envelope.
4. Test deliveries, duplicates of an event already seen, and event types without a handler are
   acknowledged and dropped.
5. The server returns `202` and runs the handler on a bounded background queue. Nothing waits on a
   model call inside the request.
6. The triage handler checks the visible `From` address before it reads the conversation.
7. It reads the conversation once. That gives the message, its `version` for stale-safe drafts,
   Shipmail's prompt-injection scan, and the sender authentication verdicts.
8. When sender authentication is required, the message must carry a DMARC `pass`. Anything else is
   escalated without calling Claude.
9. If Shipmail flagged the message, or could not scan it, it is escalated without calling Claude.
10. The handler takes `reply_text`, what the sender newly wrote without quoted history or
    signature, removes control characters and unapproved URLs, and wraps it in untrusted-data
    markers.
11. Claude classifies the message as `needs_reply`, `ignore`, or `escalate`.
12. A reply is saved with `createInboxReplyDraft` against the conversation `version`. An ignored
    conversation is marked done.
13. A draft is sent only when `AUTO_SEND=true`, and only until the per-conversation reply cap.

Escalated conversations stay in the queue and fire the `onEscalate` hook, which only logs until you
wire it to your own review queue.

## Five-minute quickstart

Requirements: [Bun](https://bun.sh), a [Shipmail account](https://shipmail.to), and an Anthropic
API key.

1. In Shipmail, create a mailbox for the agent.
2. Create a scoped API key. Start with inbox read and draft write access, plus webhook write access
   for step 6. Add send access only if you plan to enable `AUTO_SEND`.
3. Copy and fill the environment file:

   ```bash
   cp .env.example .env.local
   ```

4. Install and run the server. Bun loads `.env.local` automatically.

   ```bash
   bun install --ignore-scripts
   bun run dev
   ```

5. Expose the local server with a tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

6. Create the webhook, then put the printed secret in `SHIPMAIL_WEBHOOK_SECRET` and restart:

   ```bash
   bun run webhook:create -- --url https://your-tunnel.example/webhook
   ```

   Pass `--events reply.overdue` or `--events calendar.event_starting` for the recipes that need
   them, and `--authenticated-only` to have Shipmail drop mail that failed DMARC.

The health endpoint is `GET /health`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SHIPMAIL_API_KEY` | Scoped Shipmail API key |
| `SHIPMAIL_MAILBOX_ID` | The single mailbox this process accepts |
| `SHIPMAIL_WEBHOOK_SECRET` | Signing secret returned when the webhook is created |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5` |
| `PORT` | Local HTTP port, defaults to `3000` |
| `REDIS_URL` | Optional. Shared deduplication store. Required if you run more than one instance |
| `SHIPMAIL_ALLOWED_SENDERS` | Required for triage. Comma-separated addresses or entries like `*@example.com`. Wildcards for public mail providers are rejected at startup |
| `SHIPMAIL_ALLOWED_URL_HOSTS` | Optional exact hosts or entries like `*.example.com` |
| `AUTO_SEND` | Sends generated drafts when `true`. Defaults to `false` |
| `REQUIRE_AUTHENTICATED_SENDER` | Requires a DMARC `pass` before Claude is called. Defaults to the value of `AUTO_SEND` |

Each recipe README lists the variables it adds.

## Security model

Email is attacker-controlled input, so start with what this starter cannot do.

> **With `REQUIRE_AUTHENTICATED_SENDER=false`, the `From` address is not authenticated.** The
> allowlist then checks a header an attacker can set to anything, so a spoofed allowlisted sender
> walks straight through. Enforcement defaults to on whenever `AUTO_SEND` is on, which is the case
> that matters, but leaving it off in draft-only mode means a person is reviewing unauthenticated
> mail.

> **Prompt-injection scanning is a signal, not a boundary.** Shipmail scans every inbound message
> and reports `security.status` with risk codes. The starter escalates anything flagged or
> unscanned, but a scanner cannot catch every phrasing. The boundary is what the agent is allowed
> to do: draft by default, never send to a stranger, never follow a link.

The controls that hold:

- Shipmail-side filtering: the webhook is scoped to one mailbox, `allowed_senders` drops other
  senders before delivery, and `authenticated_senders_only` can drop DMARC failures
- A 1 MB webhook body limit enforced before signature verification
- HMAC signature verification with a timestamp window and a constant-time comparison, done on the
  raw body before parsing
- Mailbox pinning and `From` allowlisting in the app as well, before the conversation is read
- DMARC enforcement when `REQUIRE_AUTHENTICATED_SENDER` is on. Only a `pass` counts: SPF alone
  authenticates the envelope sender, which can differ from the address a person reads. Missing
  results escalate rather than being treated as a pass
- Shipmail's injection scan: flagged or unscanned messages never reach the model unless a person
  releases them in Shipmail
- Per-event deduplication, so a retry or a replay inside the signature window costs nothing
- A loop guard: the agent never replies to its own address, and each conversation has a reply cap
- `reply_text` instead of the raw body, so quoted history and hidden HTML text stay out of the
  prompt; control characters and Unicode bidirectional controls are removed
- URL host allowlisting, with all other URLs redacted, including non-`http` schemes
- A system policy plus untrusted-data delimiters the data cannot close
- Structured outputs plus Zod validation of every model answer
- An outbound link check: a draft that introduces a link outside the allowlist is escalated
- Draft-only behavior by default, and conversation `version` checks plus idempotency keys on every
  write

Turn on the mailbox's agent security hold as well. With it on, an API key without
`messages:review` gets flagged message bodies redacted, so a bug in your own code cannot pass them
to a model. Setting it needs a key with `mailboxes:write` and `messages:review`, so use an admin
key once rather than the agent's key:

```ts
await new ShipmailClient(adminKey).mailboxes.update(mailboxId, { agent_security_hold: true });
```

### What you still own

- **Attachments are not handled at all.** Nothing here reads them. If you add attachment
  processing, you own zip bombs, XXE, macro documents, and text embedded in images and PDFs.
- **The work queue is in memory.** Shipmail gets its `202` before the work runs, so it does not
  redeliver a failed event. The server retries a failed event twice, after 5 and 30 seconds, then
  logs its event ID and releases it, so you can replay the delivery from Shipmail. A crash or a
  deploy loses the events still in the queue. Put a durable queue behind the handlers if that
  matters.
- **Multi-process deployments need `REDIS_URL`.** Without it the `EventStore` is an in-memory map,
  correct for one process only. The process warns at startup when it is unset.
- **Rate limiting and cost.** There is no per-sender rate limit. An allowlisted sender, or anyone
  at all for the lead qualifier, can drive model spend.
- **Log retention.** Decisions are logged with the sender address and the classification. Message
  bodies are never logged. Escalation reasons are model-generated text, so they are flattened and
  truncated before logging, but they still reach your logs.
- **Secret rotation.** Rotating `SHIPMAIL_WEBHOOK_SECRET` requires a restart.
- **`isAllowlistableUrl` is not an SSRF control.** It is a syntactic check for redaction and does
  no DNS resolution. If you add a tool that fetches URLs, pin the resolved IP at fetch time.

## Use it from an AI assistant

Shipmail runs a hosted MCP server at `https://shipmail.to/api/mcp`. Any assistant that speaks MCP
can read the inbox, save drafts, check the calendar and send mail within the permissions you grant
at sign-in. No server from this repository is needed.

| Assistant | How to connect |
| --- | --- |
| Claude (web, desktop, mobile) | Add a custom connector with the URL above and sign in with OAuth |
| ChatGPT | Turn on developer mode, then add a connector with the URL above |
| Claude Code, Cursor, VS Code | Use [`examples/mcp-client/hosted-mcp.json`](examples/mcp-client/hosted-mcp.json) |
| OpenClaw, Hermes Agent, Grok, Muse, Dots | Follow the [Shipmail guides](https://shipmail.to/docs/guides/email-for-ai-agents) |

Grant read and draft permissions only, and leave sending to yourself. Then try prompts like these:

- "Every weekday at 8:00, list the conversations that need a reply, one line each, and save a
  reply draft for the routine ones." (Use the assistant's scheduled tasks.)
- "Before each meeting today, find my last emails with the attendees and tell me what is still
  open."
- "Find the threads where I am waiting on someone for more than three days and draft a short
  follow-up for each."

The server-based recipes do the same work unattended, with the checks above enforced in code
instead of in a prompt.

## Building on it

- **Handle another event.** `startWebhookServer` takes a map of event type to handler. Write a
  handler with `on(schema, run)` from `src/server.ts`, and register several in one process if you
  like:

  ```ts
  handlers: {
    "message.received": triageHandler({ ... }),
    "reply.overdue": followUpHandler({ ... }),
  }
  ```

- **Swap the model provider.** Every handler and recipe calls `StructuredModel.generate` from
  `src/model.ts` with a system prompt, a user prompt and a Zod schema. Implement it for another
  provider and pass it as `model`.
- **Give triage more facts.** Pass `loadContext` to `triageHandler` to add trusted context, such as
  calendar slots or order status, and `policy` to add rules. The meeting scheduler does both.
- **Route escalations somewhere.** Pass `onEscalate` to send them to Slack, a ticket, or a queue.
- **Replace the event store.** Set `REDIS_URL`, or implement `EventStore` from
  `src/event-store.ts`. `createRedisEventStore` takes any client exposing `send(command, args)`, so
  Bun's built-in client, ioredis, and node-redis all work.

The Shipmail calls are typed from the SDK in `src/shipmail.ts`. An SDK upgrade that renames a
parameter fails `bun run typecheck` instead of failing in production.

## Examples

- `examples/claude-agent-sdk`: a Claude agent on the hosted MCP server, limited to read and draft
  tools
- `examples/openai-agents`: the same agent with the OpenAI Agents SDK
- `examples/vercel-ai-sdk`: a `StructuredModel` backed by the AI SDK
- `examples/langgraph`: the starter's steps as LangGraph nodes
- `examples/mcp-client`: hosted HTTP and local stdio MCP configurations plus a tool-listing script

Each example has its own `package.json`, so root tests do not install example dependencies. Install
them with `--ignore-scripts` as well.

## Testing

The automated tests use fake Shipmail and model clients and make no network calls:

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

The servers run as long-lived processes, because the webhook acknowledges immediately and finishes
the work on a background queue. A serverless function has nowhere to keep that queue, so use
anything that runs a container or a persistent process. Railway is the example below; Fly, Render
and a plain Docker host work the same way.

Create a service from this repository, add the environment variables from `.env.example`, and use:

```text
bun install --ignore-scripts
bun run start
```

Use the recipe's script instead of `start` to run a recipe. Railway supplies `PORT`, which the
starter reads. Set the health check to `/health`, then create the webhook at
`https://your-service.example/webhook`.

A single instance needs nothing else. To run more than one, add Redis and set `REDIS_URL`, which
moves deduplication and the reply cap into shared state.

The morning digest is a script, not a server. Run it from cron, a scheduled job on your platform,
or a GitHub Actions schedule.

## Shipmail links

- [Documentation](https://shipmail.to/docs)
- [Email for AI agents guide](https://shipmail.to/docs/guides/email-for-ai-agents)
- [Webhooks](https://shipmail.to/docs/api/webhooks)
- [TypeScript SDK](https://shipmail.to/docs/sdks/typescript)
- [MCP guide](https://shipmail.to/docs/mcp)

## License

MIT. See `LICENSE`.
