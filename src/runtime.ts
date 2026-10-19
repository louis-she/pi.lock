import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentSession as createPiSession, createAgentSessionRuntime, SettingsManager, SessionManager,
  type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext, type AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";
import { lazyStream } from "@earendil-works/pi-ai";
import { assertEngine } from "./bridge.js";
import { digest, fail, findProject, replaceRoots } from "./common.js";
import { readLock, verifyDefinition, verifySnapshot, materialize, draftLock, saveLock, type AgentLock } from "./lock.js";
import { LockedResourceLoader } from "./loader.js";
import { assertModel, keyBinding, modelIdentity, modelRuntime, selectedModel, type CredentialsOptions } from "./model.js";
import { prepareRuntimePaths } from "./paths.js";

export interface LockedSessionOptions extends CredentialsOptions {
  /** Agent definition root. Defaults to the nearest pi.lock/.pi/settings.json above cwd. */
  projectRoot?: string;
  /** Task workspace; never used for resource discovery when projectRoot is supplied. */
  cwd?: string;
  sessionManager?: SessionManager;
  sessionDir?: string;
  /** Like pi --session; existing sessions must contain the same agentDigest. */
  sessionFile?: string;
  /** Explicit Pi UI callbacks; missing interaction handlers report INTERACTION_REQUIRED. */
  uiContext?: Partial<ExtensionUIContext>;
  dev?: boolean;
}
export interface LockedRuntime {
  runtime: AgentSessionRuntime;
  lock: AgentLock;
  projectRoot: string;
  releaseRoot: string;
  inspect(): unknown;
  bind(mode?: "tui" | "rpc" | "json" | "print", ui?: Partial<ExtensionUIContext>): Promise<void>;
  dispose(): Promise<void>;
}
const UI_SETTERS = new Set([
  "setTheme", "setHideThinkingBlock", "setShowCacheMissNotices", "setQuietStartup", "setCollapseChangelog", "setLastChangelogVersion",
  "setShowImages", "setClearOnShrink", "setShowTerminalProgress", "setTuiMode", "setFullscreenExitOutput", "setFullscreenScrollbar",
  "setFullscreenCopyOnSelect", "setFullscreenWheelScrollLines", "setDoubleEscapeAction", "setTreeFilterMode", "setShowHardwareCursor",
  "setEditorPaddingX", "setOutputPad", "setAutocompleteMaxVisible", "setMermaidRenderingMode",
]);
function lockedSettings(settings: Record<string, any>, frozen: boolean): SettingsManager {
  const manager = SettingsManager.inMemory({ ...settings, enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: "off" }, { projectTrusted: true });
  if (frozen) for (const name of Object.getOwnPropertyNames(SettingsManager.prototype)) {
    if ((name.startsWith("set") && !UI_SETTERS.has(name)) || name === "applyOverrides") {
      (manager as any)[name] = () => fail("FROZEN_SETTING", `${name} changes locked behavior. Edit .pi/settings.json and run pi-lock lock, or start --dev.`);
    }
  }
  return manager;
}
function developmentSettings(projectRoot: string): SettingsManager {
  const path = resolve(projectRoot, ".pi/settings.json");
  return SettingsManager.fromStorage({ withLock(scope, fn) {
    if (scope === "project") { fn(undefined); return; }
    const changed = fn(readFileSync(path, "utf8"));
    if (changed !== undefined) writeFileSync(path, changed);
  } }, { projectTrusted: true });
}

export function headlessUI(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
  const required = async () => fail("INTERACTION_REQUIRED", "INTERACTION_REQUIRED: this operation needs an interaction handler. Supply uiContext in the SDK or respond through TUI/RPC.");
  const noop = () => {};
  return {
    select: required, confirm: required, input: required, editor: required, custom: required,
    notify: noop, onTerminalInput: () => noop, setStatus: noop, setWorkingMessage: noop,
    setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
    setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop,
    getEditorText: () => "", addAutocompleteProvider: noop, setEditorComponent: noop,
    get theme() { return undefined as any; },
    ...overrides,
  } as ExtensionUIContext;
}

function pinSession(manager: SessionManager, lock: AgentLock, dev: boolean): void {
  const pins = manager.getEntries().filter((e: any) => e.type === "custom" && e.customType === "pi-lock");
  if (pins.some((e: any) => e.data?.agentDigest !== lock.agentDigest) && !dev) fail("SESSION_VERSION_MISMATCH", "This session belongs to a different Agent version. Use its matching release or start a new session.");
  if (!pins.length) {
    if (manager.buildSessionContext().messages.length && !dev) fail("SESSION_UNPINNED", "This transcript has no Agent version. Start a new locked session; importing history requires an explicit migration.");
    manager.appendCustomEntry("pi-lock", { agentDigest: lock.agentDigest, lockfileVersion: 1 });
  }
}

export function effectiveConfiguration(session: AgentSession, releaseRoot: string, cwd: string, lock: AgentLock): unknown {
  const loader = session.resourceLoader;
  const tools = session.getAllTools().map(info => {
    const tool = session.getToolDefinition(info.name);
    return { name: info.name, description: info.description, parameters: tool?.parameters ?? (info as any).parameters,
      promptSnippet: tool?.promptSnippet, promptGuidelines: tool?.promptGuidelines, exposure: (info as any).exposure,
      constrainedSampling: tool?.constrainedSampling };
  });
  return replaceRoots({
    model: modelIdentity(session.model), thinkingLevel: session.thinkingLevel,
    settings: lock.definition.settings,
    extensions: loader.getExtensions().extensions.map(e => ({ path: e.path, commands: [...e.commands.keys()], hooks: [...e.handlers.keys()] })),
    skills: loader.getSkills().skills, prompts: loader.getPrompts().prompts,
    context: loader.getAgentsFiles().agentsFiles, systemPrompt: session.systemPrompt,
    tools, activeTools: session.getActiveToolNames(), mcp: (loader as LockedResourceLoader).mcp?.catalog,
  }, [[releaseRoot, "<AGENT>"], [cwd, "<WORKSPACE>"]]);
}

export async function createLockedRuntime(options: LockedSessionOptions = {}, prepared?: AgentLock): Promise<LockedRuntime> {
  const allowed = new Set(["projectRoot", "cwd", "sessionManager", "sessionDir", "sessionFile", "uiContext", "dev", "apiKey", "credentials", "env"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("UNLOCKED_OVERRIDE", `SDK option ${key} is not a runtime binding. Put Agent behavior in .pi/settings.json or an extension, then lock it.`);
  assertEngine();
  const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
  const projectRoot = findProject(cwd, options.projectRoot);
  let lock = prepared ?? (options.dev ? await draftLock(projectRoot, true) : readLock(projectRoot));
  if (!options.dev) verifyDefinition(projectRoot, lock);
  const paths = prepareRuntimePaths(projectRoot);
  let releaseRoot = materialize(projectRoot, lock);
  const stateDir = resolve(options.sessionDir ?? resolve(paths.sessions, lock.agentDigest, digest(cwd).slice(0, 12)));
  const agentDir = paths.ui;
  const manager = options.sessionManager ?? (options.sessionFile ? SessionManager.open(resolve(options.sessionFile), stateDir, cwd) : SessionManager.create(cwd, stateDir));
  let host!: AgentSessionRuntime;
  let lastInspection: unknown;
  const create: CreateAgentSessionRuntimeFactory = async input => {
    verifySnapshot(releaseRoot, lock);
    pinSession(input.sessionManager, lock, Boolean(options.dev));
    const settings = options.dev ? developmentSettings(projectRoot) : lockedSettings(lock.definition.settings, true);
    const models = await modelRuntime(lock.definition, options, Boolean(options.dev));
    const model = selectedModel(models, lock.definition, Boolean(options.dev));
    if (!options.dev) assertModel(model, lock.model);
    const loader = new LockedResourceLoader(releaseRoot, input.cwd, lock.definition, options.env, (lock.effective as any)?.mcp);
    await loader.reload();
    let result: Awaited<ReturnType<typeof createPiSession>>;
    try { result = await createPiSession({ cwd: input.cwd, agentDir,
      modelRuntime: models, model, thinkingLevel: lock.definition.settings.defaultThinkingLevel,
      scopedModels: options.dev ? undefined : [{ model: model!, thinkingLevel: lock.definition.settings.defaultThinkingLevel ?? "medium" }],
      resourceLoader: loader, settingsManager: settings, sessionManager: input.sessionManager,
      sessionStartEvent: input.sessionStartEvent,
    }); } catch (error) { await loader.mcp?.close(); throw error; }
    const session = result.session;
    if (options.dev && (!settings.getDefaultProvider() || !settings.getDefaultModel())) {
      const setModel = session.setModel.bind(session);
      session.setModel = (async (next, opts = {}) => setModel(next, { ...opts, persist: true })) as AgentSession["setModel"];
    }
    if (options.dev) await models.refresh({ allowNetwork: false });
    const errors: string[] = [];
    const originalBind = session.bindExtensions.bind(session);
    let boundRunner: AgentSession["extensionRunner"] | undefined;
    let boundMode: string | undefined;
    const validate = (initial = true) => {
      if (errors.length) fail("EXTENSION_RUNTIME_FAILED", errors.join("\n"));
      if (!options.dev) assertModel(session.model, lock.model);
      const effective = effectiveConfiguration(session, releaseRoot, input.cwd, lock);
      if (initial && lock.effective && !options.dev && digest(effective) !== digest(lock.effective)) fail("EFFECTIVE_CONFIG_DRIFT", "Actual model, prompt, tools, or extensions differ from pi.lock. Mode-dependent extension initialization is not portable.");
      lastInspection = { agentDigest: lock.agentDigest, effectiveDigest: digest(effective), frozen: !options.dev, pi: lock.runtime.pi,
        credentialEnvironment: lock.definition.settings.defaultProvider ? keyBinding(lock.definition) : undefined, configuration: effective };
    };
    session.bindExtensions = async bindings => {
      // Pi RPC may rebind twice after new_session. Run startup hooks once per extension runtime.
      if (boundRunner === session.extensionRunner) {
        if (bindings.mode && bindings.mode !== boundMode) fail("MODE_ALREADY_BOUND", "Create a fresh runtime when changing its interface mode.");
        return;
      }
      await originalBind({ ...bindings, uiContext: bindings.uiContext ?? headlessUI(options.uiContext), onError: error => { errors.push(`${error.event}: ${error.error}`); bindings.onError?.(error); } });
      validate();
      await loader.mcp?.check();
      boundRunner = session.extensionRunner; boundMode = bindings.mode ?? "print";
    };
    if (!options.dev) {
      const setModel = session.setModel.bind(session);
      session.setModel = (async (next, opts) => { assertModel(next, lock.model); return setModel(next, opts); }) as AgentSession["setModel"];
      const setThinking = session.setThinkingLevel.bind(session);
      session.setThinkingLevel = (level, opts) => {
        if (level !== session.thinkingLevel) fail("FROZEN_SETTING", "Thinking level is locked. Edit .pi/settings.json and re-lock.");
        return setThinking(level, opts);
      };
      for (const name of ["setSteeringMode", "setFollowUpMode", "setAutoCompactionEnabled", "setAutoRetryEnabled"]) {
        if (typeof (session as any)[name] === "function") (session as any)[name] = () => fail("FROZEN_SETTING", `${name} changes locked behavior. Use --dev, then re-lock.`);
      }
    }
    const originalPrompt = session.prompt.bind(session);
    session.prompt = async (text, opts) => {
      verifySnapshot(releaseRoot, lock);
      validate(false);
      await loader.mcp?.check();
      const result = await originalPrompt(text, opts);
      if (errors.length) fail("EXTENSION_RUNTIME_FAILED", errors.join("\n"));
      const last = session.messages.at(-1) as any;
      if (last?.role === "assistant" && last.stopReason === "error") fail("MODEL_REQUEST_FAILED", last.errorMessage ?? "Model request failed.");
      return result;
    };
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (selected, context, streamOptions) => {
      verifySnapshot(releaseRoot, lock);
      if (!options.dev) assertModel(selected, lock.model);
      return lazyStream(selected, async () => { await loader.mcp?.check(); return stream(selected, context, streamOptions); });
    };
    const reload = session.reload.bind(session);
    session.reload = async opts => {
      if (!options.dev) verifyDefinition(projectRoot, lock);
      else {
        const next = await draftLock(projectRoot, true);
        if (next.model) {
          const configured = models.getModel(next.definition.settings.defaultProvider, next.definition.settings.defaultModel);
          if (!configured || digest(modelIdentity(configured)) !== digest(next.model)) fail("RESTART_REQUIRED", "Model configuration changed. Restart pi-lock --dev to rebuild its provider runtime.");
        }
        lock = next; releaseRoot = materialize(projectRoot, next);
        loader.root = releaseRoot; loader.definition = next.definition;
      }
      await reload(opts); validate(); boundRunner = session.extensionRunner;
    };
    return { ...result, services: { cwd: input.cwd, agentDir, modelRuntime: models, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
  };
  host = await createAgentSessionRuntime(create, { cwd, agentDir, sessionManager: manager });
  const originalDispose = host.dispose.bind(host);
  let disposing: Promise<void> | undefined;
  host.dispose = () => disposing ??= (async () => {
    await host.session.abort();
    await host.services.settingsManager.flush();
    await originalDispose();
  })();
  const bind = async (mode: "tui" | "rpc" | "json" | "print" = "print", ui?: Partial<ExtensionUIContext>) => {
    await host.session.bindExtensions({ mode, uiContext: headlessUI(ui ?? options.uiContext),
      commandContextActions: {
        waitForIdle: () => host.session.agent.waitForIdle(),
        newSession: opts => host.newSession(opts), fork: (id, opts) => host.fork(id, opts),
        navigateTree: (id, opts) => host.session.navigateTree(id, opts),
        switchSession: (path, opts) => host.switchSession(path, opts),
        reload: () => host.session.reload(),
      },
    });
  };
  host.setRebindSession(() => bind());
  return { runtime: host, get lock() { return lock; }, projectRoot, get releaseRoot() { return releaseRoot; }, inspect: () => lastInspection, bind, dispose: () => host.dispose() };
}

/** Drop-in-shaped SDK entry: same Pi session, with project-only loading and frozen checks. */
export async function createAgentSession(options: LockedSessionOptions = {}) {
  const locked = await createLockedRuntime(options);
  try { await locked.bind("print", options.uiContext); }
  catch (e) { await locked.dispose(); throw e; }
  return {
    get session() { return locked.runtime.session; },
    runtime: locked.runtime,
    inspect: locked.inspect,
    get agentDigest() { return locked.lock.agentDigest; },
    dispose: locked.dispose,
  };
}

export async function lockProject(projectRoot: string): Promise<AgentLock> {
  const root = findProject(projectRoot, projectRoot);
  const lock = await draftLock(root);
  const runtime = await createLockedRuntime({ projectRoot: root, cwd: root, sessionManager: SessionManager.inMemory(root) }, lock);
  try {
    await runtime.bind();
    lock.effective = (runtime.inspect() as any).configuration;
    // A source edit during extension initialization must never produce a mixed release.
    verifyDefinition(root, lock);
    saveLock(root, lock);
    materialize(root, lock);
    return lock;
  } finally { await runtime.dispose(); }
}
