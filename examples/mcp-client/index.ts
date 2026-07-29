import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const apiKey = process.env.SHIPMAIL_API_KEY;
if (!apiKey) throw new Error("SHIPMAIL_API_KEY is required");

const transport = new StreamableHTTPClientTransport(
  new URL("https://shipmail.to/api/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } },
);
const client = new Client({ name: "shipmail-inbox-example", version: "0.1.0" });

await client.connect(transport);
const tools = await client.listTools();
console.info(tools.tools.map((tool) => tool.name));
await client.close();
