# Vercel AI SDK example

This example runs the shared security filter before sending an email to Claude through the `ai`
package.

```bash
bun install
ANTHROPIC_API_KEY=sk-ant-replace_me bun start
```

Keep the security filter in front of every model call. This example only prints a classification.
Use the root starter when you need verified Shipmail webhooks and reply drafts.
