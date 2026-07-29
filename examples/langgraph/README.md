# LangGraph example

This example puts a single triage node behind the same inbound security filter used by the root
starter.

```bash
bun install
ANTHROPIC_API_KEY=sk-ant-replace_me bun start
```

Add review and drafting nodes only after the security boundary. Keep sending outside the graph so
the final action remains deterministic and auditable.
