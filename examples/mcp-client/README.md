# MCP client example

`hosted-mcp.json` connects an MCP host to `https://shipmail.to/api/mcp` with a bearer key.
`local-mcp.json` starts the published `shipmail-mcp` package over stdio with
`npx -y shipmail-mcp`.

The script lists the hosted server's tools:

```bash
bun install
SHIPMAIL_API_KEY=sm_live_replace_me bun start
```

Do not commit a real key in either JSON file. Prefer your MCP host's secret storage when it has one.
