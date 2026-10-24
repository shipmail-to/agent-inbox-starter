# Claude Agent SDK example

A Claude agent that works the inbox through Shipmail's hosted MCP server. It has no built-in tools
(no shell, files or web), and its MCP tools are limited to listing conversations, reading one, and
saving a reply draft. `permissionMode: "dontAsk"` denies any other tool call instead of asking.

```bash
bun install --ignore-scripts
SHIPMAIL_API_KEY=sm_live_replace_me ANTHROPIC_API_KEY=sk-ant-replace_me bun start
```
