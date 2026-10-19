import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { digest, fail, inside, json } from "./common.js";
import { internalModule } from "./bridge.js";

export interface LockedMcp {
  factory: ExtensionFactory;
  catalog: Record<string, unknown>;
  check(): Promise<void>;
  close(): Promise<void>;
}
function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => env[name] ?? fail("MISSING_CREDENTIAL", `MCP needs environment binding ${name}.`));
}
export async function prepareMcp(root: string, workspace: string, env: Record<string, string | undefined>, expected?: Record<string, unknown>): Promise<LockedMcp | undefined> {
  const path = resolve(root, ".pi/mcp.json");
  if (!existsSync(path)) return undefined;
  const cfg = json(path);
  const catalog: Record<string, unknown> = {};
  const clients = new Map<string, McpClient>();
  const toolModule = await internalModule("./extensions/mcp/tools.js");
  const close = async () => { await Promise.allSettled([...clients.values()].map(c => c.close())); };
  function metadata(client: McpClient, tools: unknown[]) {
    return { server: client.serverInfo, capabilities: client.serverCapabilities, instructions: client.instructions, tools };
  }
  try {
    for (const [name, server] of Object.entries<any>(cfg.mcpServers ?? {})) {
      if (server.enabled === false || server.exposure === "hidden") continue;
      if (server.oauth || server.auth) fail("UNSUPPORTED_MCP_AUTH", `${name}: supply an explicit HTTP Authorization environment binding; global Pi OAuth is never loaded.`);
      const client = new McpClient({ name: "pi-lock", version: "0.1.2", requestTimeoutMs: server.timeout ?? 10000,
        roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }] });
      clients.set(name, client);
      if (server.command) {
        const command = server.command === "node" ? process.execPath : server.command.startsWith(".") ? inside(root, server.command) : fail("UNLOCKED_MCP_COMMAND", `${name}: use node or a checked-in project-relative executable; install runner dependencies locally instead of using npx/global commands.`);
        const args = (server.args ?? []).map((arg: string) => interpolate(arg.replaceAll("${WORKSPACE}", workspace).replaceAll("${AGENT_ROOT}", root), env));
        const variables = Object.fromEntries(Object.entries<string>(server.env ?? {}).map(([key, value]) => [key, interpolate(value, env)]));
        await client.connect(new StdioTransport({ command, args, cwd: root, inheritEnv: false, env: { PATH: dirname(process.execPath), ...variables }, stderr: "pipe" }));
      } else if (server.url) {
        for (const [key, value] of Object.entries<string>(server.headers ?? {})) if (/authorization|token|api[-_]?key/i.test(key) && !/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) fail("SECRET_IN_DEFINITION", `${name}: ${key} must use an environment binding, not a literal secret.`);
        const headers = Object.fromEntries(Object.entries<string>(server.headers ?? {}).map(([key, value]) => [key, interpolate(value, env)]));
        await client.connect(new StreamableHttpTransport({ url: server.url, headers, openGetStream: true }));
      } else fail("INVALID_MCP", `${name}: expected command or url.`);
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      catalog[name] = metadata(client, tools);
    }
    if (expected && digest(catalog) !== digest(expected)) fail("MCP_SCHEMA_DRIFT", "MCP server instructions, capabilities or tool schemas differ from pi.lock. Review and re-lock.");
  } catch (e) { await close(); throw e; }
  const check = async () => {
    for (const [name, client] of clients) {
      const current = metadata(client, client.serverCapabilities?.tools ? await client.listTools() : []);
      if (digest(current) !== digest(catalog[name])) fail("MCP_SCHEMA_DRIFT", `MCP ${name} changed its catalogue during this session.`);
    }
  };
  const factory: ExtensionFactory = pi => {
    const used = new Set<string>();
    for (const [name, client] of clients) {
      const entry = cfg.mcpServers[name];
      const data = catalog[name] as any;
      const namespace = { name: `mcp__${name}`, aliases: [name], description: name, instructions: data.instructions };
      for (const tool of data.tools) {
        const fullName = toolModule.createMcpToolName(name, tool.name, (candidate: string) => used.has(candidate));
        used.add(fullName);
        pi.registerTool(toolModule.createMcpToolDefinition({ server: name, tool, name: fullName,
          exposure: entry.toolExposure?.[tool.name] ?? entry.exposure ?? "codemode", namespace,
          timeoutMs: entry.timeout ?? 10000,
          getClient: async () => { await check(); return client; },
          readableResources: () => Boolean(client.serverCapabilities?.resources),
        }));
      }
    }
    const servers = () => [...clients].map(([name]) => name);
    if ([...clients.values()].some(c => c.serverCapabilities?.resources)) {
      pi.registerTool({ name: "list_mcp_resources", label: "MCP resources", description: "List resources from the locked MCP servers.", parameters: Type.Object({ server: Type.Optional(Type.String()) }),
        execute: async (_id, args) => ({ content: [{ type: "text", text: JSON.stringify(await Promise.all(servers().filter(n => !args.server || n === args.server).map(async server => ({ server, resources: await clients.get(server)!.listResources() })))) }], details: {} }) });
      pi.registerTool({ name: "list_mcp_resource_templates", label: "MCP templates", description: "List resource templates from the locked MCP servers.", parameters: Type.Object({ server: Type.Optional(Type.String()) }),
        execute: async (_id, args) => ({ content: [{ type: "text", text: JSON.stringify(await Promise.all(servers().filter(n => !args.server || n === args.server).map(async server => ({ server, templates: await clients.get(server)!.listResourceTemplates() })))) }], details: {} }) });
      pi.registerTool({ name: "read_mcp_resource", label: "Read MCP resource", description: "Read a resource from a locked MCP server.", parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
        execute: async (_id, args, signal) => {
          const client = clients.get(args.server) ?? fail("UNKNOWN_MCP", `Unknown server ${args.server}`);
          const result = await client.readResource(args.uri, { signal });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } });
    }
    pi.on("session_start", () => {
      const active = new Set(pi.getActiveTools());
      for (const [name] of clients) {
        const exposure = cfg.mcpServers[name].exposure ?? "codemode";
        if (exposure === "codemode" && cfg.autoEnableCodemode !== false) active.add("codemode");
        if (exposure === "deferred") active.add("tool_search");
      }
      pi.setActiveTools([...active]);
    });
    pi.on("before_agent_start", event => {
      const instructions = [...clients].map(([name, client]) => `${name}: ${client.instructions ?? ""}`).join("\n");
      event.systemPromptOptions.sections.mcp_servers = instructions;
    });
    pi.on("session_shutdown", close);
  };
  return { factory, catalog, check, close };
}
