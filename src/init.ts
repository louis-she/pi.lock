import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicJson, fail } from "./common.js";

export const demoExtension = `import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

// Ordinary Pi extension. The provider is offline and deterministic; no API key or network.
export default function (pi) {
  const fake = fauxProvider({ provider: "pi-lock-demo", api: "openai-completions", models: [{ id: "demo", name: "Offline demo", reasoning: false, contextWindow: 32768, maxTokens: 1024 }] });
  fake.setResponses(Array.from({ length: 100 }, () => (context) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("Agent versioned by pi.lock. " + last.content.filter(c => c.type === "text").map(c => c.text).join(""));
    return fauxAssistantMessage(fauxToolCall("echo", { text: "Hello from the same Pi agent." }, { id: "echo-demo" }), { stopReason: "toolUse" });
  }));
  pi.registerProvider("pi-lock-demo", { api: "openai-completions", baseUrl: "http://localhost:0", apiKey: "offline-demo", streamSimple: fake.provider.streamSimple, models: [{ id: "demo", name: "Offline demo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  pi.registerTool({ name: "echo", label: "Echo", description: "Echo a text value.", parameters: Type.Object({ text: Type.String() }), execute: async (_id, args) => ({ content: [{ type: "text", text: args.text }], details: {} }) });
}
`;

export function initialize(projectRoot: string, options: { demo?: boolean; provider?: string; model?: string } = {}): void {
  const config = resolve(projectRoot, ".pi/settings.json");
  if (existsSync(config)) fail("PROJECT_EXISTS", ".pi/settings.json already exists. Keep using it and run pi-lock lock.");
  mkdirSync(dirname(config), { recursive: true });
  atomicJson(config, { defaultProvider: options.demo ? "pi-lock-demo" : options.provider ?? "anthropic", defaultModel: options.demo ? "demo" : options.model ?? "claude-sonnet-4-6", defaultThinkingLevel: options.demo ? "off" : "medium", defaultTools: options.demo ? ["read", "echo"] : ["read", "bash", "edit", "write"], ...(options.demo ? { compaction: { enabled: false }, retry: { enabled: false } } : {}) });
  writeFileSync(resolve(projectRoot, ".pi/SYSTEM.md"), "You are a helpful agent. Use the supplied tools and skills when needed.\n");
  if (options.demo) {
    atomicJson(resolve(projectRoot, ".pi/models.json"), { providers: { "pi-lock-demo": { api: "openai-completions", baseUrl: "http://localhost:0", models: [{ id: "demo", name: "Offline demo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] } } });
    mkdirSync(resolve(projectRoot, ".pi/extensions"), { recursive: true });
    writeFileSync(resolve(projectRoot, ".pi/extensions/demo.ts"), demoExtension);
    mkdirSync(resolve(projectRoot, ".pi/skills/explain"), { recursive: true });
    writeFileSync(resolve(projectRoot, ".pi/skills/explain/SKILL.md"), "---\nname: explain\ndescription: Explain the configured agent and its available tools.\n---\nExplain briefly, and demonstrate the echo tool.\n");
    mkdirSync(resolve(projectRoot, ".pi/prompts"), { recursive: true });
    writeFileSync(resolve(projectRoot, ".pi/prompts/hello.md"), "---\ndescription: Try the same agent through every interface.\n---\nSay hello using the echo tool. $ARGUMENTS\n");
  }
  const ignore = resolve(projectRoot, ".gitignore");
  const existing = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!existing.split("\n").includes(".pi-lock/")) writeFileSync(ignore, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + ".pi-lock/\n");
}
