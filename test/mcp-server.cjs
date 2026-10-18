const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const input = createInterface({ input: process.stdin });
const state = () => process.env.SCHEMA_FILE ? readFileSync(process.env.SCHEMA_FILE, "utf8").trim() : "one";
input.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result;
  if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1.0.0" }, instructions: "Locked MCP fixture " + state() };
  else if (msg.method === "tools/list") result = { tools: [{ name: "greet", description: "Greeting schema " + state(), inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] } }] };
  else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "Hello " + msg.params.arguments.who }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
