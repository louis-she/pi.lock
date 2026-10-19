import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { InteractiveMode, initTheme, runPrintMode, runRpcMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { atomicJson, digest, fail, json } from "./common.js";
import { internalModule } from "./bridge.js";
import { initialize } from "./init.js";
import { createLockedRuntime, lockProject } from "./runtime.js";
import { materialize, readLock, verifyDefinition, verifySourcesBeforeInstall } from "./lock.js";
import { prepareRuntimePaths } from "./paths.js";

async function npmCi(cwd: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn("npm", ["ci", "--no-audit", "--no-fund"], { cwd, stdio: "inherit", shell: false });
    child.on("error", reject); child.on("close", code => code === 0 ? done() : reject(new Error(`npm ci failed (${code}) in ${cwd}`)));
  });
}
export async function execute(command: string, root: string, cwd: string, flags: Record<string, string | boolean>, messages: string[]) {
  if (command === "init") {
    initialize(root, { demo: Boolean(flags["--demo"]), provider: flags["--provider"] as string, model: flags["--model"] as string });
    console.log(`Created .pi/settings.json${flags["--demo"] ? " and offline demo" : ""}. Run pi-lock --dev to tune, then pi-lock lock.`); return;
  }
  if (command === "lock") {
    const lock = await lockProject(root);
    console.log(`Locked Pi ${lock.runtime.pi}: ${lock.agentDigest}\nCommit .pi/ and pi.lock to Git.`); return;
  }
  if (command === "sync") {
    if (!flags["--frozen"]) fail("ARGUMENT", "Use pi-lock sync --frozen to restore dependencies without changing pi.lock.");
    const lock = readLock(root);
    verifySourcesBeforeInstall(root, lock);
    for (const path of [root, resolve(root, ".pi/npm")]) if (existsSync(resolve(path, "package-lock.json"))) await npmCi(path);
  }
  if (["verify", "inspect", "sync"].includes(command)) {
    const lock = readLock(root); verifyDefinition(root, lock); materialize(root, lock);
    if (command === "inspect") console.log(JSON.stringify({ agentDigest: lock.agentDigest, pi: lock.runtime.pi, configuration: lock.effective, resources: lock.definition.resources, dependencies: lock.definition.dependencies }, null, 2));
    else console.log(`Verified ${lock.agentDigest}`);
    return;
  }
  const edits: Record<string, string> = { "--model": "defaultModel", "--provider": "defaultProvider", "--thinking": "defaultThinkingLevel", "--tools": "defaultTools" };
  for (const [flag, field] of Object.entries(edits)) if (flags[flag] !== undefined) {
    if (!flags["--dev"]) fail("FROZEN_SETTING", `${flag} changes locked behavior. Start --dev to tune, then pi-lock lock.`);
    const path = resolve(root, ".pi/settings.json"); const config = json(path);
    config[field] = flag === "--tools" ? String(flags[flag]).split(",") : flags[flag]; atomicJson(path, config);
  }
  const mode = flags["--mode"] ?? ((flags["-p"] || flags["--print"]) ? "print" : "tui");
  if (!["tui", "rpc", "json", "print", "text"].includes(String(mode))) fail("ARGUMENT", `Unknown mode ${mode}.`);
  const state = prepareRuntimePaths(root).state;
  const { AuthStorage } = await internalModule("./core/auth-storage.js");
  const credentials = AuthStorage.create(resolve(state, "auth.json"));
  const opts: any = { projectRoot: root, cwd, credentials, dev: Boolean(flags["--dev"]), sessionFile: flags["--session"], sessionDir: flags["--session-dir"] };
  if (flags["--no-session"]) opts.sessionManager = SessionManager.inMemory(cwd);
  if (flags["--continue"] || flags["-c"]) {
    if (opts.dev) fail("ARGUMENT", "Continue a frozen version, or use --session explicitly while developing.");
    const lock = readLock(root);
    const dir = resolve(String(flags["--session-dir"] ?? resolve(state, "sessions", lock.agentDigest, digest(cwd).slice(0, 12))));
    opts.sessionManager = SessionManager.continueRecent(cwd, dir);
  }
  if (mode !== "tui") (await internalModule("./core/output-guard.js")).takeOverStdout();
  const locked = await createLockedRuntime(opts);
  const themeModule = await internalModule("./modes/interactive/theme/theme.js");
  themeModule.setRegisteredThemes(locked.runtime.services.resourceLoader.getThemes().themes);
  initTheme(locked.runtime.services.settingsManager.getTheme(), false);
  const keys = resolve(locked.releaseRoot, ".pi/keybindings.json");
  if (existsSync(keys)) copyFileSync(keys, resolve(state, "ui/keybindings.json"));
  else rmSync(resolve(state, "ui/keybindings.json"), { force: true });
  try {
    if (mode === "rpc") { await runRpcMode(locked.runtime); }
    else if (mode === "tui") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) fail("TTY_REQUIRED", "TUI requires a terminal. Use -p or --mode rpc for non-interactive execution.");
      const tui = new InteractiveMode(locked.runtime, { initialMessage: messages.join(" ") || undefined, initialImages: [], initialMessages: [], migratedProviders: [], verbose: false });
      await tui.run();
    } else {
      let prompt = messages.join(" ");
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        const input = Buffer.concat(chunks).toString("utf8").trim(); if (input) prompt = [input, prompt].filter(Boolean).join("\n\n");
      }
      if (!prompt) fail("PROMPT_REQUIRED", "Pass a prompt or pipe input into pi-lock -p.");
      process.exitCode = await runPrintMode(locked.runtime, { mode: mode === "json" ? "json" : "text", initialMessage: prompt, initialImages: [], messages: [] });
    }
  } finally { await locked.dispose(); }
}
