# Shipmail AI agent inbox starter kit

A standalone Bun and TypeScript starter for triaging a Shipmail inbox with Claude. It verifies
Shipmail webhooks, blocks unapproved senders, removes common prompt-injection content, classifies
mail, and creates stale-safe reply drafts. Sending is off by default.

## What happens to an inbound message

1. Shipmail sends a signed `message.received` webhook.
2. The server rejects request bodies larger than 1 MB before signature verification. This applies
   both to declared `Content-Length` values and streamed request bodies.
3. The server verifies the signature and validates the current webhook contract.
4. The visible `From` address is checked before the inbox body is fetched.
5. The webhook `email_id` selects the provider message in the thread. If it is absent or not found,
   the tracked message ID is tried next, followed by the newest message from the sender.
6. The message is converted to plain text. Control characters, instruction-like lines, and
   unapproved URLs are removed.
7. Claude classifies the message as `needs_reply`, `ignore`, or `escalate`.
8. Routine replies are saved with `createInboxReplyDraft` and the current `reply_version`.
9. A draft is sent only when `AUTO_SEND=true`. Draft creation and sending use separate stable
   idempotency keys derived from the webhook event ID.

Ignored threads are marked `no_reply_expected`. Escalated threads remain in the reply queue for a
person to review.

## Five-minute quickstart

Requirements: [Bun](https://bun.sh), a
[Shipmail account](https://shipmail.to), and an Anthropic API key.

1. In Shipmail, create a mailbox for the agent.
2. Create a scoped API key. Start with inbox read and draft write access. Add send access only if
   you plan to enable `AUTO_SEND`.
3. Copy and fill the environment file:

   ```bash
   cp .env.example .env.local
   ```

4. Install and run the server:

   ```bash
   bun install
   bun --env-file .env.local run dev
   ```

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

The health endpoint is `GET /health`. Decisions are logged without the message body.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SHIPMAIL_API_KEY` | Scoped Shipmail API key |
| `SHIPMAIL_MAILBOX_ID` | The single mailbox this process accepts |
| `SHIPMAIL_WEBHOOK_SECRET` | Signing secret returned when the webhook is created |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `PORT` | Local HTTP port, defaults to `3000` |
| `SHIPMAIL_ALLOWED_SENDERS` | Required comma-separated addresses or entries like `*@example.com` |
| `SHIPMAIL_ALLOWED_URL_HOSTS` | Optional exact hosts or entries like `*.example.com` |
| `AUTO_SEND` | `false` by default. Keep it false while sender authentication results are unavailable |
| `REQUIRE_AUTHENTICATED_SENDER` | Reserved for future SPF, DKIM, and DMARC enforcement. It defaults to `false`; setting it to `true` currently fails startup |

The model is fixed to `claude-sonnet-5` in `src/agent.ts`.

## Sandbox testing

Shipmail sandbox inbound injection exercises the real mailbox and webhook path without sending mail
over SMTP:

```bash
bun --env-file .env.local run sandbox:e2e
```

The script calls `mailboxes.injectSandboxInbound`. Its default sender is
`sandbox-sender@example.com`, so add that exact address to `SHIPMAIL_ALLOWED_SENDERS` for the test.
Override it with `SANDBOX_FROM` when needed. The script is not part of `bun test` and requires a
real Shipmail API key.

The automated pipeline test uses fake Shipmail and Anthropic clients. It makes no network calls:

```bash
bun test
```

## Security model

Email is attacker-controlled input. This starter applies several independent controls before a
model can influence an action:

- A 1 MB webhook body limit enforced before signature verification
- Visible `From` address allowlisting, with optional explicit `*@domain` entries
- Signature verification and strict Zod validation of `message.received`
- Mailbox ID pinning
- HTML, scripts, comments, control characters, and Unicode bidirectional controls removed
- Common prompt-injection and role-manipulation lines replaced before model input
- Public HTTPS URL checks that reject credentials, localhost, private, link-local, reserved, and
  unusual numeric IP forms
- URL host allowlisting, with all other URLs redacted
- A system policy plus JSON and XML-style untrusted-data delimiters
- Zod validation of the model's three allowed decisions
- A second safety pass over generated drafts
- Draft-only behavior by default
- Shipmail `reply_version` checks and event-based idempotency keys for both draft creation and send

> **Sender authentication limitation:** Shipmail SDK 0.4.6 inbox message and thread responses do not
> expose SPF, DKIM, DMARC, or alignment results. This starter therefore cannot prove that the
> visible `From` address is authentic. An attacker may spoof an allowlisted address. The
> `REQUIRE_AUTHENTICATED_SENDER` flag is reserved for API support and cannot be enabled yet. Setting
> it to `true` fails startup so it cannot be mistaken for an active control.

Keep `AUTO_SEND=false` while sender authentication results are unavailable. Allowlisting reduces
exposure but does not make a sender trustworthy. Model defenses are not a proof against every future
prompt-injection technique. Review the policy, sender list, model output, and operational logs for
your use case. Sensitive, security, legal, account-access, and financial messages are designed to
escalate.

## Deploy to Railway

Create a service from this repository, add the environment variables from `.env.example`, and use:

```text
bun install --ignore-scripts
bun run start
```

Railway supplies `PORT`, which the starter reads. Set the health check to `/health`, then create the
Shipmail webhook at `https://your-service.example/webhook`.

## Deploy to Vercel

The `api/webhook.ts` adapter exports the same Web Request handler as a Vercel Function. Import the
repository, add all required environment variables, and deploy. Create the Shipmail webhook at:

```text
https://your-project.vercel.app/api/webhook
```

The Vercel route does not start `Bun.serve`. The local and Railway entrypoint still uses
`src/index.ts`.

## Examples

- `examples/vercel-ai-sdk`: minimal triage through the `ai` package and `@ai-sdk/anthropic`
- `examples/langgraph`: a small LangGraph triage node
- `examples/mcp-client`: hosted HTTP and local stdio MCP configurations plus a tool-listing script

Each example has its own `package.json`, so root tests do not install example dependencies.

## Shipmail links

- [Documentation](https://shipmail.to/docs)
- [Email for AI agents guide](https://shipmail.to/docs/guides/email-for-ai-agents)
- [TypeScript SDK](https://shipmail.to/docs/sdks/typescript)
- [MCP guide](https://shipmail.to/docs/mcp)
- Hosted MCP endpoint: `https://shipmail.to/api/mcp`

## License

MIT. See `LICENSE`.
