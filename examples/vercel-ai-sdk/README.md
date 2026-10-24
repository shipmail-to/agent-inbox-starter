# Vercel AI SDK example

A `StructuredModel` backed by the AI SDK's `generateText` with `Output.object`. Pass it as `model`
to `triageHandler` or any recipe. Replace `anthropic(...)` with another AI SDK provider to change
vendors.

```bash
bun install --ignore-scripts
ANTHROPIC_API_KEY=sk-ant-replace_me bun start
```
