# LangGraph example

`createLangChainModel` is a `StructuredModel` backed by a LangChain chat model. `createTriageGraph`
runs the starter's security pass and triage as two LangGraph nodes, and the model node runs only
when the security pass accepts the message. Add your own nodes after triage, such as a CRM lookup
or a human approval step.

```bash
bun install --ignore-scripts
ANTHROPIC_API_KEY=sk-ant-replace_me bun start
```
