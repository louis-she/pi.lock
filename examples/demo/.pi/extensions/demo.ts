import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

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
