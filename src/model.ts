import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import { digest, fail } from "./common.js";
import type { Definition } from "./definition.js";

export interface CredentialsOptions {
  apiKey?: string;
  credentials?: CredentialStore;
  /** Only named credential bindings are read. Never pass process.env into provider options. */
  env?: Record<string, string | undefined>;
}
export function keyBinding(def: Definition): string {
  const provider = def.settings.defaultProvider;
  const nativeNames: Record<string, string> = {
    google: "GEMINI_API_KEY", "google-vertex": "GOOGLE_CLOUD_API_KEY", azure: "AZURE_OPENAI_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY", huggingface: "HF_TOKEN", "github-copilot": "COPILOT_GITHUB_TOKEN",
    moonshotai: "MOONSHOT_API_KEY", "moonshotai-cn": "MOONSHOT_API_KEY", "kimi-coding": "KIMI_API_KEY",
    "opencode-go": "OPENCODE_API_KEY", "cloudflare-workers-ai": "CLOUDFLARE_API_KEY", "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  };
  return def.modelConfig.providers?.[provider]?.apiKey ?? nativeNames[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
export async function modelRuntime(def: Definition, options: CredentialsOptions = {}, development = false): Promise<ModelRuntime> {
  const provider = def.settings.defaultProvider;
  const credentials = options.credentials ?? new InMemoryCredentialStore();
  if (options.apiKey && !provider) fail("MODEL_PROVIDER_REQUIRED", "Set a provider before injecting a single apiKey, or use named provider credentials in dev mode.");
  const key = provider ? options.apiKey ?? (options.env ?? process.env)[keyBinding(def)] : undefined;
  if (key && provider) await credentials.modify(provider, async () => ({ type: "api_key", key }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  for (const [id, config] of Object.entries<any>(def.modelConfig.providers ?? {})) {
    runtime.registerProvider(id, { ...config, apiKey: undefined });
  }
  const keys = new Map<string, string>();
  if (key && provider) keys.set(provider, key);
  if (development) for (const entry of runtime.getProviders()) {
    if (entry.id === provider) continue;
    const binding = keyBinding({ ...def, settings: { ...def.settings, defaultProvider: entry.id } });
    const value = (options.env ?? process.env)[binding];
    if (value) { keys.set(entry.id, value); await credentials.modify(entry.id, async () => ({ type: "api_key", key: value })); }
  }
  const configured = async (id: string) => Boolean((development || id === provider) && (await credentials.read(id) || keys.has(id) || runtime.getRegisteredProviderConfig(id)?.apiKey));
  const auth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (async (selected: any, overrides: any = {}) => {
    const id = typeof selected === "string" ? selected : selected.provider;
    if (!development && id !== provider) fail("FROZEN_MODEL", `Agent is locked to provider ${provider}.`);
    if (!await configured(id)) fail("MISSING_CREDENTIAL", `Supply apiKey/credentials through the SDK or set ${keyBinding({ ...def, settings: { ...def.settings, defaultProvider: id } })}. Global Pi authentication is not read.`);
    return auth(selected, { ...overrides, apiKey: keys.get(id) ?? overrides.apiKey, env: {} });
  }) as ModelRuntime["getAuth"];
  const checkAuth = runtime.checkAuth.bind(runtime);
  runtime.checkAuth = async (id, opts) => await configured(id) ? checkAuth(id, opts) : undefined;
  // There is no need to discover another provider or refresh a remote catalog in a locked agent.
  const refresh = runtime.refresh.bind(runtime);
  runtime.refresh = async (opts = {}) => {
    const selected = development ? opts.providers ?? runtime.getProviders().map(p => p.id) : [provider];
    const safe: string[] = [];
    for (const id of selected) if (await configured(id)) safe.push(id);
    return safe.length ? refresh({ ...opts, providers: safe, allowNetwork: false }) : { aborted: false, errors: new Map() };
  };
  return runtime;
}
export function selectedModel(runtime: ModelRuntime, def: Definition, allowUnselected = false) {
  if (allowUnselected && (!def.settings.defaultProvider || !def.settings.defaultModel)) return undefined;
  const model = runtime.getModel(def.settings.defaultProvider, def.settings.defaultModel);
  if (!model) fail("MODEL_NOT_FOUND", `Model ${def.settings.defaultProvider}/${def.settings.defaultModel} is not in Pi 1.3.0 or local .pi/models.json. No fallback model will be selected.`);
  return model;
}
export function modelIdentity(model: unknown): unknown { return model == null ? model : JSON.parse(JSON.stringify(model)); }
export function assertModel(actual: unknown, expected: unknown): void {
  if (digest(modelIdentity(actual)) !== digest(expected)) fail("MODEL_DRIFT", "The loaded model definition differs from pi.lock. Re-lock intentionally after reviewing the change.");
}
