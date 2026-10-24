# OpenAI Agents SDK example

The same read-and-draft agent with the OpenAI Agents SDK. The MCP tool filter means the agent
never sees a tool that sends or deletes. Set `OPENAI_MODEL` to choose a model.

```bash
bun install --ignore-scripts
SHIPMAIL_API_KEY=sm_live_replace_me OPENAI_API_KEY=sk-replace_me bun start
```
