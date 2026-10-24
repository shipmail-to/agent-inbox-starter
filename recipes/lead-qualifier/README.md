# Lead qualifier

Turns sales email into a scored record and posts it to your CRM. Claude extracts the company,
contact, need, budget and timeline, and rates the fit from 1 to 5. Mail that is not a lead (spam,
job applications, vendors, support requests) is dropped.

Leads come from strangers, so this recipe has no sender allowlist. That is safe only because it
never replies: every field it produces is data for your CRM, never an instruction, and links are
removed from it. A message Shipmail flagged is posted with `held` set and no model call.

Anyone can make this recipe call the model, so watch your spend. Run it on a dedicated sales
address rather than your main inbox.

## Run it

Set `SHIPMAIL_API_KEY`, `SHIPMAIL_MAILBOX_ID`, `SHIPMAIL_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` and
`CRM_WEBHOOK_URL` (HTTPS). `CRM_WEBHOOK_TOKEN` is sent as a bearer token when set.

```bash
bun run recipe:lead-qualifier
bun run webhook:create -- --url https://your-host.example/webhook
```

Leave `SHIPMAIL_ALLOWED_SENDERS` unset when you create this webhook, or Shipmail filters out the
leads. Each POST carries an `Idempotency-Key` header, and a non-2xx answer makes Shipmail redeliver
the event.

The record:

```json
{
  "conversation_id": "thd_...",
  "sender": "ana@acme.example",
  "subject": "Pricing for 12 people",
  "dmarc": "pass",
  "held": null,
  "lead": {
    "is_lead": true,
    "company": "Acme",
    "contact_name": "Ana",
    "need": "Shared inbox for 12 people",
    "budget": null,
    "timeline": "Next month",
    "fit_score": 4,
    "summary": "Acme wants a shared inbox for its support team."
  }
}
```
