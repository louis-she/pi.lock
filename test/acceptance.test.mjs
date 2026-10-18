import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, cpSync, rmSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createLockedRuntime, lockProject, readLock, verifyDefinition, SessionManager } from "../dist/index.js";
import { initialize } from "../dist/init.js";
import { digest, replaceRoots } from "../dist/common.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repo, "dist/cli.js");
const scratch = realpathSync(mkdtempSync(resolve(tmpdir(), "pi-lock-acceptance-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function fixture({ trace = false } = {}) {
  const root = resolve(scratch, `agent-${++n}`);
  initialize(root, { demo: true });
  if (trace) {
    const path = resolve(root, ".pi/extensions/demo.ts");
    const source = readFileSync(path, "utf8")
      .replace('import { Type,', 'import { appendFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { Type,')
      .replace('export default function (pi) {', 'export default function (pi) {\nlet workspace;\npi.on("session_start", (_e, ctx) => { workspace = ctx.cwd; });\npi.on("before_agent_start", e => { e.systemPromptOptions.sections.fixture = "locked hook"; });')
      .replace('(context) => {', '(context, options) => {\nappendFileSync(resolve(workspace, "requests.jsonl"), JSON.stringify({ context, options }) + "\\n");');
    writeFileSync(path, source);
  }
  return root;
}
function memory(root, extra = {}) { return { projectRoot: root, cwd: root, sessionManager: SessionManager.inMemory(root), ...extra }; }
function errorCode(code) { return error => error?.code === code; }
function spawnCli(root, args = [], options = {}) {
  const child = spawn(process.execPath, [cli, "--project", root, ...args], { cwd: root, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
  const result = new Promise((done, reject) => { child.on("error", reject); child.on("exit", code => done({ code, get stdout() { return stdout; }, get stderr() { return stderr; } })); });
  return { child, result, output: () => ({ stdout, stderr }) };
}
async function cliRun(root, args, env) {
  const proc = spawnCli(root, args, { env }); proc.child.stdin.end();
  const timeout = setTimeout(() => proc.child.kill("SIGKILL"), 30000);
  try { return await proc.result; } finally { clearTimeout(timeout); }
}
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await delay(30); }
  throw new Error(`Timed out waiting for ${label}`);
}
function traces(root) {
  const path = resolve(root, "requests.jsonl");
  if (!existsSync(path)) return [];
  const release = resolve(root, ".pi-lock/releases", readLock(root).agentDigest);
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(s => {
    const cleaned = JSON.parse(s, (k, v) => ["timestamp", "durationMs", "usage", "sessionId", "responseId"].includes(k) ? undefined : v);
    return replaceRoots(cleaned, [[release, "<AGENT>"], [root, "<WORKSPACE>"]]);
  });
}

test("locks latest Pi 1.3.0 and preserves the ordinary .pi layout", async () => {
  const root = fixture();
  const lock = await lockProject(root);
  assert.equal(lock.runtime.pi, "1.3.0"); assert.equal(lock.lockfileVersion, 1);
  assert.ok(lock.definition.resources.skills.includes(".pi/skills/explain/SKILL.md"));
  assert.ok(!existsSync(resolve(root, "pi.json")));
  const agent = await createAgentSession(memory(root));
  try { await agent.session.prompt("hello"); assert.match(agent.session.getLastAssistantText(), /same Pi agent/); }
  finally { await agent.dispose(); }
});

test("ignores polluted HOME, global extensions, global skills, parent AGENTS and workspace .pi", async () => {
  const root = fixture();
  const home = resolve(scratch, "poison-home");
  const marker = resolve(scratch, "GLOBAL_EXTENSION_EXECUTED");
  mkdirSync(resolve(home, ".pi/agent/extensions"), { recursive: true });
  mkdirSync(resolve(home, ".agents/skills/poison"), { recursive: true });
  writeFileSync(resolve(home, ".pi/agent/settings.json"), JSON.stringify({ defaultModel: "POISON_GLOBAL_MODEL" }));
  writeFileSync(resolve(home, ".pi/agent/SYSTEM.md"), "POISON_GLOBAL_SYSTEM");
  writeFileSync(resolve(home, ".agents/skills/poison/SKILL.md"), "---\nname: poison\ndescription: POISON_GLOBAL_SKILL\n---\npoison");
  writeFileSync(resolve(home, ".pi/agent/extensions/poison.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"BAD"); export default function() { throw Error("GLOBAL_EXTENSION"); }`);
  writeFileSync(resolve(scratch, "AGENTS.md"), "POISON_PARENT_INSTRUCTIONS");
  const workspace = resolve(root, "customer"); mkdirSync(resolve(workspace, ".pi/extensions"), { recursive: true });
  writeFileSync(resolve(workspace, ".pi/settings.json"), JSON.stringify({ defaultModel: "POISON_WORKSPACE_MODEL" }));
  writeFileSync(resolve(workspace, "AGENTS.md"), "POISON_WORKSPACE_INSTRUCTIONS");
  writeFileSync(resolve(workspace, ".pi/extensions/poison.ts"), `throw Error("WORKSPACE_EXTENSION");`);
  const before = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = resolve(home, ".pi/agent");
  try {
    await lockProject(root);
    const agent = await createAgentSession(memory(root, { cwd: workspace, sessionManager: SessionManager.inMemory(workspace) }));
    try {
      assert.doesNotMatch(JSON.stringify(agent.inspect()), /POISON|poison/);
      await agent.session.prompt("hello");
      assert.equal(process.env.HOME, home); assert.equal(process.env.PI_CODING_AGENT_DIR, resolve(home, ".pi/agent")); assert.equal(process.cwd(), before.cwd);
    } finally { await agent.dispose(); }
    const result = await cliRun(root, ["-p", "hello", "--no-session"], { HOME: home, PI_CODING_AGENT_DIR: resolve(home, ".pi/agent") });
    assert.equal(result.code, 0, result.stderr); assert.ok(!existsSync(marker));
  } finally {
    if (before.home === undefined) delete process.env.HOME; else process.env.HOME = before.home;
    if (before.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before.agent;
    rmSync(resolve(scratch, "AGENTS.md"));
  }
});

test("relocation preserves Agent digest and actual effective configuration", async () => {
  const root = fixture(); const lock = await lockProject(root);
  const moved = resolve(scratch, "relocated"); mkdirSync(moved);
  cpSync(resolve(root, ".pi"), resolve(moved, ".pi"), { recursive: true }); cpSync(resolve(root, "pi.lock"), resolve(moved, "pi.lock"));
  const a = await createAgentSession(memory(root)); const b = await createAgentSession(memory(moved));
  try {
    assert.equal(a.agentDigest, b.agentDigest); assert.equal(a.agentDigest, lock.agentDigest);
    assert.equal(a.inspect().effectiveDigest, b.inspect().effectiveDigest);
    assert.deepEqual(a.inspect().configuration, b.inspect().configuration);
    await b.session.prompt("hello");
  } finally { await a.dispose(); await b.dispose(); }
});

test("frozen execution rejects changed, removed and added resources before extension execution", async () => {
  const root = fixture(); await lockProject(root);
  appendFileSync(resolve(root, ".pi/SYSTEM.md"), "Changed");
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_DRIFT"));
  await lockProject(root);
  writeFileSync(resolve(root, ".pi/skills/explain/new-reference.md"), "New skill dependency");
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_DRIFT"));
  await lockProject(root);
  rmSync(resolve(root, ".pi/skills/explain/SKILL.md"));
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_DRIFT"));
});

test("frozen SDK and CLI reject behavioral overrides and thinking changes", async () => {
  const root = fixture(); await lockProject(root);
  await assert.rejects(createAgentSession({ ...memory(root), model: {} }), errorCode("UNLOCKED_OVERRIDE"));
  const a = await createAgentSession(memory(root));
  try {
    assert.throws(() => a.session.setThinkingLevel("high"), errorCode("FROZEN_SETTING"));
    await assert.rejects(a.session.setModel({ ...a.session.model, id: "different" }), errorCode("MODEL_DRIFT"));
    assert.throws(() => a.runtime.services.settingsManager.setDefaultProvider("other"), errorCode("FROZEN_SETTING"));
  } finally { await a.dispose(); }
  const run = await cliRun(root, ["-p", "hello", "--model", "different"]);
  assert.equal(run.code, 1); assert.match(run.stderr, /FROZEN_SETTING/);
});

test("SDK, native print and native RPC produce the same real model requests including hooks and tool rounds", async () => {
  const root = fixture({ trace: true }); await lockProject(root);
  const sdk = await createAgentSession(memory(root));
  try { await sdk.session.prompt("/hello"); } finally { await sdk.dispose(); }
  const expected = traces(root); assert.equal(expected.length, 2); assert.match(JSON.stringify(expected), /locked hook/);
  rmSync(resolve(root, "requests.jsonl"));
  const print = await cliRun(root, ["-p", "/hello", "--no-session"]);
  assert.equal(print.code, 0, print.stderr); assert.deepEqual(traces(root), expected);
  rmSync(resolve(root, "requests.jsonl"));
  const proc = spawnCli(root, ["--mode", "rpc", "--no-session"]);
  const events = []; let buffer = "";
  proc.child.stdout.on("data", data => { buffer += data; let i; while ((i = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) events.push(JSON.parse(line)); } });
  proc.child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "/hello" }) + "\n");
  try {
    await waitFor(() => events.some(e => e.type === "agent_settled"), () => proc.output().stderr);
    assert.deepEqual(traces(root), expected);
    proc.child.stdin.write(JSON.stringify({ id: "change", type: "set_thinking_level", level: "high" }) + "\n");
    await waitFor(() => events.find(e => e.id === "change"), "RPC frozen-setting response");
    assert.equal(events.find(e => e.id === "change").success, false);
  } finally { proc.child.stdin.end(); await proc.result; }
});

test("the real native TUI in a PTY uses the same model requests as the SDK", { timeout: 40000 }, async () => {
  const root = fixture({ trace: true }); await lockProject(root);
  const sdk = await createAgentSession(memory(root));
  try { await sdk.session.prompt("/hello"); } finally { await sdk.dispose(); }
  const expected = traces(root); rmSync(resolve(root, "requests.jsonl"));
  const child = spawn("python3", [resolve(repo, "test/run-terminal.py"), process.execPath, cli, "--project", root, "--no-session", "/hello"], {
    cwd: root, env: { ...process.env, TERM: "xterm-256color", PI_TUI_ESC_TIMEOUT: "10" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
  const ended = new Promise(done => child.on("exit", code => done(code)));
  try {
    await waitFor(() => existsSync(resolve(root, "requests.jsonl")) && traces(root).length >= 2, "TUI provider requests", 20000);
    await waitFor(() => output.includes("Agent versioned by pi.lock."), "TUI rendered response", 10000);
    assert.deepEqual(traces(root), expected);
    child.stdin.write("\x04");
    assert.equal(await Promise.race([ended, delay(6000).then(() => "timeout")]), 0, output.slice(-2000));
  } catch (e) { throw new Error(`${e.message}\nPTY OUTPUT:\n${output.slice(-5000)}`); }
  finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("new, reload, fork and resume retain locked resources and session version", async () => {
  const root = fixture(); const lock = await lockProject(root);
  const a = await createAgentSession({ projectRoot: root, cwd: root });
  let sessionFile;
  try {
    await a.session.prompt("first"); sessionFile = a.session.sessionFile;
    await a.session.reload();
    assert.equal(a.inspect().agentDigest, lock.agentDigest);
    const user = a.session.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user");
    assert.ok(user);
    await a.runtime.fork(user.id, { position: "at" }); await a.session.prompt("forked");
    assert.equal(a.inspect().agentDigest, lock.agentDigest);
    await a.runtime.newSession(); assert.equal(a.session.messages.filter(m => m.role === "user").length, 0);
    await a.runtime.switchSession(sessionFile, { cwdOverride: root }); await a.session.prompt("resumed");
    assert.equal(a.inspect().agentDigest, lock.agentDigest);
  } finally { await a.dispose(); }
  const resumed = await createAgentSession({ projectRoot: root, cwd: root, sessionFile });
  try { assert.ok(resumed.session.messages.some(m => m.role === "user")); } finally { await resumed.dispose(); }
});

test("two Agents coexist in one SDK process and reload without changing cwd or environment", async () => {
  const one = fixture(), two = fixture();
  writeFileSync(resolve(two, ".pi/SYSTEM.md"), "Second independent agent.");
  await lockProject(one); await lockProject(two);
  const environment = JSON.stringify(process.env), cwd = process.cwd();
  const [a, b] = await Promise.all([createAgentSession(memory(one)), createAgentSession(memory(two))]);
  try {
    assert.notEqual(a.agentDigest, b.agentDigest);
    await Promise.all([a.session.prompt("first"), b.session.prompt("second")]);
    await a.session.reload(); await b.session.prompt("still independent");
    assert.match(b.session.systemPrompt, /Second independent/); assert.doesNotMatch(a.session.systemPrompt, /Second independent/);
    assert.equal(JSON.stringify(process.env), environment); assert.equal(process.cwd(), cwd);
  } finally { await a.dispose(); await b.dispose(); }
});

test("Git rollback restores an earlier Agent; running snapshots survive source changes", async () => {
  const root = fixture();
  const git = (...args) => execFileSync("git", ["-c", "user.name=Pi Lock Acceptance", "-c", "user.email=pi-lock@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); const v1 = await lockProject(root); git("add", ".pi", "pi.lock", ".gitignore"); git("commit", "-qm", "Agent v1"); const commit = git("rev-parse", "HEAD");
  const old = await createAgentSession(memory(root));
  try {
    writeFileSync(resolve(root, ".pi/SYSTEM.md"), "Agent version two."); const v2 = await lockProject(root);
    assert.notEqual(v1.agentDigest, v2.agentDigest);
    await old.session.prompt("still version one"); assert.doesNotMatch(old.session.systemPrompt, /version two/);
    git("add", ".pi", "pi.lock"); git("commit", "-qm", "Agent v2");
    git("checkout", "-q", commit);
    verifyDefinition(root, readLock(root));
    const reverted = await createAgentSession(memory(root));
    try { assert.equal(reverted.agentDigest, v1.agentDigest); await reverted.session.prompt("rolled back"); } finally { await reverted.dispose(); }
  } finally { await old.dispose(); }
});

test("resuming a session with a different Agent version fails explicitly", async () => {
  const root = fixture(); await lockProject(root);
  const a = await createAgentSession({ projectRoot: root }); await a.session.prompt("persist"); const sessionFile = a.session.sessionFile; await a.dispose();
  appendFileSync(resolve(root, ".pi/SYSTEM.md"), "New version."); await lockProject(root);
  await assert.rejects(createAgentSession({ projectRoot: root, sessionFile }), errorCode("SESSION_VERSION_MISMATCH"));
});

test("relative helper imports are captured; absolute paths and escaping symlinks are rejected", async () => {
  const root = fixture();
  mkdirSync(resolve(root, "src"));
  writeFileSync(resolve(root, "src/helper.ts"), "export const message = 'portable helper';");
  appendFileSync(resolve(root, ".pi/extensions/demo.ts"), "\nimport { message } from '../../src/helper.ts';\nvoid message;\n");
  const lock = await lockProject(root); assert.ok(lock.definition.files.some(f => f.path === "src/helper.ts"));
  const settingsPath = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(settingsPath));
  settings.extensions = ["/tmp/external.ts"]; writeFileSync(settingsPath, JSON.stringify(settings));
  await assert.rejects(lockProject(root), errorCode("NON_PORTABLE_PATH"));
  delete settings.extensions; writeFileSync(settingsPath, JSON.stringify(settings));
  symlinkSync(resolve(scratch, "outside"), resolve(root, ".pi/escape")); writeFileSync(resolve(scratch, "outside"), "outside");
  await assert.rejects(lockProject(root), errorCode("OUTSIDE_PROJECT"));
});

test("unsupported mode-dependent extension initialization fails rather than pretending parity", async () => {
  const root = fixture();
  appendFileSync(resolve(root, ".pi/extensions/demo.ts"), "\n// The next factory intentionally violates the portable-extension contract.\n");
  const path = resolve(root, ".pi/extensions/demo.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace("export default function (pi) {", 'export default function (pi) { pi.on("session_start", (_e, ctx) => { if (ctx.mode === "rpc") pi.setActiveTools([]); });'));
  await lockProject(root);
  const proc = await cliRun(root, ["--mode", "rpc", "--no-session"]);
  assert.equal(proc.code, 1); assert.match(proc.stderr, /EFFECTIVE_CONFIG_DRIFT/);
});

test("--dev reload reads local edits; frozen running sessions remain on their immutable release", async () => {
  const root = fixture(); await lockProject(root);
  const dev = await createAgentSession(memory(root, { dev: true }));
  try {
    writeFileSync(resolve(root, ".pi/SYSTEM.md"), "Edited during local development.");
    await dev.session.reload(); assert.match(dev.session.systemPrompt, /Edited during/);
  } finally { await dev.dispose(); }
  await lockProject(root);
});

test("lock content and materialized-release corruption fail explicitly", async () => {
  const root = fixture(); const lock = await lockProject(root);
  const path = resolve(root, "pi.lock"), original = readFileSync(path);
  const changed = JSON.parse(original); changed.definition.settings.defaultProvider = "other";
  writeFileSync(path, JSON.stringify(changed));
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_CORRUPT"));
  writeFileSync(path, original);
  appendFileSync(resolve(root, ".pi-lock/releases", lock.agentDigest, ".pi/SYSTEM.md"), "tampered cache");
  await assert.rejects(createAgentSession(memory(root)), errorCode("SNAPSHOT_CORRUPT"));
  rmSync(path);
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_MISSING"));
});

test("installed npm resource packages and dependency files are pinned, portable, restorable and checked before use", { timeout: 40000 }, async () => {
  const root = fixture(); const vendor = resolve(root, "vendor"); mkdirSync(resolve(vendor, "helper"), { recursive: true });
  const helper = resolve(vendor, "helper");
  writeFileSync(resolve(helper, "package.json"), JSON.stringify({ name: "portable-fixture-helper", version: "1.0.0", type: "module", exports: "./index.js", pi: { extensions: ["./extension.ts"] } }));
  writeFileSync(resolve(helper, "index.js"), 'export const suffix = "locked dependency";\n');
  writeFileSync(resolve(helper, "extension.ts"), 'import {Type} from "@earendil-works/pi-ai"; export default function(pi) { pi.registerTool({name:"package_tool",label:"Package tool",description:"From a pinned npm package",parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:"package works"}],details:{}})}); }');
  execFileSync("npm", ["pack", "--pack-destination", vendor, "--silent"], { cwd: helper });
  rmSync(helper, { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "fixture-agent", version: "1.0.0", private: true, dependencies: { "portable-fixture-helper": "file:vendor/portable-fixture-helper-1.0.0.tgz" } }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: root });
  const cfg = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(cfg));
  settings.packages = ["npm:portable-fixture-helper@1.0.0"]; writeFileSync(cfg, JSON.stringify(settings));
  const extension = resolve(root, ".pi/extensions/demo.ts");
  appendFileSync(extension, '\nimport {suffix} from "portable-fixture-helper"; void suffix;\n');
  const lock = await lockProject(root);
  assert.ok(lock.definition.dependencies.some(p => p.name === "portable-fixture-helper" && p.version === "1.0.0" && p.integrity));
  const a = await createAgentSession(memory(root));
  try { assert.ok(a.session.getAllTools().some(t => t.name === "package_tool")); await a.session.prompt("package test"); } finally { await a.dispose(); }
  const packageFile = resolve(root, "node_modules/portable-fixture-helper/index.js"), original = readFileSync(packageFile);
  appendFileSync(packageFile, "// changed installed code");
  await assert.rejects(createAgentSession(memory(root)), errorCode("LOCK_DRIFT")); writeFileSync(packageFile, original);
  const moved = resolve(scratch, "npm-relocated");
  cpSync(root, moved, { recursive: true, filter: path => !path.includes("node_modules") && !path.includes(".pi-lock") });
  const missing = await cliRun(moved, ["-p", "hello", "--no-session"]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /MISSING_DEPENDENCY/);
  const restored = await cliRun(moved, ["sync", "--frozen"]);
  assert.equal(restored.code, 0, restored.stderr);
  const b = await createAgentSession(memory(moved));
  try { assert.equal(b.agentDigest, lock.agentDigest); await b.session.prompt("restored"); } finally { await b.dispose(); }
});

test("MCP tool schemas are locked, tool calls work, and startup/mid-session drift is blocked", { timeout: 30000 }, async () => {
  const root = fixture(); cpSync(resolve(repo, "test/mcp-server.cjs"), resolve(root, ".pi/mcp-server.cjs"));
  const state = resolve(scratch, "remote-mcp-schema"); writeFileSync(state, "one");
  const before = process.env.PI_LOCK_MCP_SCHEMA; process.env.PI_LOCK_MCP_SCHEMA = state;
  const mcpConfig = { mcpServers: { fixture: { command: "node", args: ["./.pi/mcp-server.cjs"], env: { SCHEMA_FILE: "${PI_LOCK_MCP_SCHEMA}" }, exposure: "direct" } } };
  writeFileSync(resolve(root, ".pi/mcp.json"), JSON.stringify(mcpConfig));
  const path = resolve(root, ".pi/extensions/demo.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('fauxToolCall("echo", { text: "Hello from the same Pi agent." }', 'fauxToolCall("mcp__fixture__greet", { who: "World" }'));
  let a;
  try {
    const lock = await lockProject(root);
    assert.equal(lock.effective.mcp.fixture.tools[0].name, "greet");
    a = await createAgentSession(memory(root));
    await a.session.prompt("greet"); assert.match(a.session.getLastAssistantText(), /Hello World/);
    writeFileSync(state, "two");
    await assert.rejects(a.session.prompt("schema changed"), errorCode("MCP_SCHEMA_DRIFT"));
    await a.dispose(); a = undefined;
    await assert.rejects(createAgentSession(memory(root)), errorCode("MCP_SCHEMA_DRIFT"));
  } finally {
    if (a) await a.dispose();
    if (before === undefined) delete process.env.PI_LOCK_MCP_SCHEMA; else process.env.PI_LOCK_MCP_SCHEMA = before;
  }
});

test("MCP codemode and deferred exposure use Pi's native discovery tools in every runtime", { timeout: 30000 }, async () => {
  for (const exposure of ["codemode", "deferred"]) {
    const root = fixture(); cpSync(resolve(repo, "test/mcp-server.cjs"), resolve(root, ".pi/mcp-server.cjs"));
    writeFileSync(resolve(root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "node", args: ["./.pi/mcp-server.cjs"], exposure } } }));
    await lockProject(root);
    const a = await createAgentSession(memory(root));
    try {
      assert.ok(a.session.getActiveToolNames().includes(exposure === "codemode" ? "codemode" : "tool_search"));
      assert.ok(!a.session.getActiveToolNames().includes("mcp__fixture__greet"));
    } finally { await a.dispose(); }
  }
});

test("headless UI does not silently approve and explicit SDK UI handlers work", async () => {
  const root = fixture(); const path = resolve(root, ".pi/extensions/demo.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('execute: async (_id, args) => ({', 'execute: async (_id, args, signal, update, ctx) => { if (!await ctx.ui.confirm("Confirm", "Use echo?")) throw new Error("Declined"); return ({').replace('details: {} }) });', 'details: {} }); } });'));
  await lockProject(root);
  const a = await createAgentSession(memory(root)); const events = [];
  a.session.subscribe(e => events.push(e));
  try { await a.session.prompt("confirm"); assert.ok(events.some(e => e.type === "tool_execution_end" && e.isError)); assert.match(a.session.getLastAssistantText(), /interaction handler/); }
  finally { await a.dispose(); }
  let asked = false;
  const b = await createAgentSession(memory(root, { uiContext: { confirm: async () => { asked = true; return true; } } }));
  try { await b.session.prompt("confirm"); assert.ok(asked); assert.match(b.session.getLastAssistantText(), /Hello from/); }
  finally { await b.dispose(); }
});

test("an unavailable locked model never falls back to another model", async () => {
  const root = fixture(); const path = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(path));
  settings.defaultModel = "does-not-exist"; writeFileSync(path, JSON.stringify(settings));
  await assert.rejects(lockProject(root), errorCode("MODEL_NOT_FOUND"));
});

test("native OpenAI-compatible HTTP requests use explicit credentials and match across SDK and CLI", { timeout: 30000 }, async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); requests.push({ headers: req.headers, body: parsed });
    const hasResult = parsed.messages.some(m => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = hasResult ? { role: "assistant", content: "HTTP fixture completed." } : { role: "assistant", tool_calls: [{ index: 0, id: "http-echo", type: "function", function: { name: "echo", arguments: '{"text":"from HTTP"}' } }] };
    const chunk = { id: "completion-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
    res.write("data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }] }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const root = fixture(); const settingsPath = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(settingsPath));
  settings.defaultProvider = "fixture"; settings.defaultModel = "fixture"; writeFileSync(settingsPath, JSON.stringify(settings));
  writeFileSync(resolve(root, ".pi/models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "PI_LOCK_FIXTURE_KEY", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] } } }));
  let agent;
  try {
    await lockProject(root);
    agent = await createAgentSession(memory(root, { apiKey: "sdk-fixture-key" }));
    await agent.session.prompt("http hello"); assert.equal(agent.session.getLastAssistantText(), "HTTP fixture completed.");
    assert.equal(requests.length, 2); assert.equal(requests[0].headers.authorization, "Bearer sdk-fixture-key");
    const expected = JSON.parse(JSON.stringify(requests.map(r => r.body)));
    await agent.dispose(); agent = undefined; requests.length = 0;
    const result = await cliRun(root, ["-p", "http hello", "--no-session"], { PI_LOCK_FIXTURE_KEY: "cli-fixture-key" });
    assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.authorization, "Bearer cli-fixture-key");
    assert.deepEqual(requests.map(r => r.body), expected);
  } finally { if (agent) await agent.dispose(); await new Promise(done => server.close(done)); }
});

test("extension startup logging cannot corrupt native RPC stdout", async () => {
  const root = fixture(); const path = resolve(root, ".pi/extensions/demo.ts");
  writeFileSync(path, 'console.log("PLUGIN_STARTUP_LOG");\n' + readFileSync(path, "utf8"));
  await lockProject(root);
  const proc = spawnCli(root, ["--mode", "rpc", "--no-session"]); let buffer = ""; const lines = [];
  proc.child.stdout.on("data", bytes => { buffer += bytes; let n; while ((n = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, n)); buffer = buffer.slice(n + 1); } });
  proc.child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
  try {
    await waitFor(() => lines.some(line => line.includes('"id":"state"')), "RPC state");
    for (const line of lines.filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
    assert.match(proc.output().stderr, /PLUGIN_STARTUP_LOG/);
  } finally { proc.child.stdin.end(); await proc.result; }
});

test("native RPC new_session initializes extensions exactly once, matching SDK lifecycle", async () => {
  const root = fixture(); const path = resolve(root, ".pi/extensions/demo.ts");
  const hook = 'import {appendFileSync} from "node:fs"; import {resolve} from "node:path";\n';
  writeFileSync(path, hook + readFileSync(path, "utf8").replace("export default function (pi) {", 'export default function (pi) { pi.on("session_start", (_e, ctx) => { appendFileSync(resolve(ctx.cwd,"starts.txt"),"start\\n"); });'));
  await lockProject(root); rmSync(resolve(root, "starts.txt"));
  const sdk = await createAgentSession(memory(root));
  try { await sdk.runtime.newSession(); assert.equal(readFileSync(resolve(root, "starts.txt"), "utf8").trim().split("\n").length, 2); } finally { await sdk.dispose(); }
  rmSync(resolve(root, "starts.txt"));
  const proc = spawnCli(root, ["--mode", "rpc", "--no-session"]); let output = "";
  proc.child.stdout.on("data", b => output += b);
  proc.child.stdin.write(JSON.stringify({ id: "new", type: "new_session" }) + "\n");
  try {
    await waitFor(() => output.includes('"id":"new"'), "RPC new_session");
    assert.equal(readFileSync(resolve(root, "starts.txt"), "utf8").trim().split("\n").length, 2);
    assert.ok(output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(e => e.id === "new").success);
  } finally { proc.child.stdin.end(); await proc.result; }
});

test("native project context, loose skills, glob selection and resource exclusions are resolved locally", async () => {
  const root = fixture();
  writeFileSync(resolve(root, "AGENTS.md"), "Project root instructions.");
  writeFileSync(resolve(root, ".pi/skills/loose.md"), "---\nname: loose\ndescription: A loose Pi skill.\n---\nLocal loose skill.");
  mkdirSync(resolve(root, ".agents/skills/shared"), { recursive: true });
  writeFileSync(resolve(root, ".agents/skills/shared/SKILL.md"), "---\nname: shared\ndescription: Project-local shared skill.\n---\nShared within this project.");
  const cfg = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(cfg));
  settings.prompts = ["prompts/*.md", "-prompts/hello.md"]; writeFileSync(cfg, JSON.stringify(settings));
  const lock = await lockProject(root);
  assert.equal(lock.definition.resources.prompts.length, 0);
  assert.ok(lock.definition.resources.context.includes("AGENTS.md"));
  assert.ok(lock.effective.skills.some(s => s.name === "loose")); assert.ok(lock.effective.skills.some(s => s.name === "shared"));
});

test("development model selection uses native Pi APIs and persists settings for the subsequent lock", async () => {
  const root = fixture(), path = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(path));
  settings.defaultProvider = "anthropic"; settings.defaultModel = "claude-sonnet-4-6"; writeFileSync(path, JSON.stringify(settings));
  const dev = await createAgentSession(memory(root, { dev: true, apiKey: "unused-fixture-key" }));
  try {
    assert.equal(dev.session.scopedModels.length, 0);
    assert.ok(dev.session.modelRuntime.getAvailableSnapshot().some(m => m.id === "claude-opus-4-6"));
    await dev.session.setModel(dev.session.modelRuntime.getModel("anthropic", "claude-opus-4-6"), { persist: true });
  } finally { await dev.dispose(); }
  assert.equal(JSON.parse(readFileSync(path)).defaultModel, "claude-opus-4-6");
  const lock = await lockProject(root); assert.equal(lock.model.id, "claude-opus-4-6");
});

test("development can start without a default model and the first Pi model selection becomes the project default", async () => {
  const root = fixture(), path = resolve(root, ".pi/settings.json"), settings = JSON.parse(readFileSync(path));
  delete settings.defaultProvider; delete settings.defaultModel; writeFileSync(path, JSON.stringify(settings));
  await assert.rejects(lockProject(root), errorCode("MODEL_REQUIRED"));

  const credentials = new InMemoryCredentialStore();
  await credentials.modify("pi-lock-demo", async () => ({ type: "api_key", key: "offline-demo" }));
  const dev = await createAgentSession(memory(root, { dev: true, credentials }));
  try {
    assert.ok(!dev.session.model || dev.session.model.id === "unknown");
    assert.ok(dev.session.modelRuntime.getAvailableSnapshot().some(candidate => candidate.provider === "pi-lock-demo" && candidate.id === "demo"));
    const model = dev.session.modelRuntime.getModel("pi-lock-demo", "demo");
    assert.ok(model);
    await dev.session.setModel(model, { persist: false });
  } finally { await dev.dispose(); }

  const selected = JSON.parse(readFileSync(path));
  assert.equal(selected.defaultProvider, "pi-lock-demo");
  assert.equal(selected.defaultModel, "demo");
  const lock = await lockProject(root);
  assert.equal(lock.model.provider, "pi-lock-demo");
  assert.equal(lock.model.id, "demo");
});

test("packed npm release installs into a clean app and runs an unchanged Agent lock", { timeout: 60000 }, async () => {
  const root = fixture(); const lock = await lockProject(root);
  const destination = resolve(scratch, "packed-release"); mkdirSync(destination);
  const result = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", destination, "--json"], { cwd: repo, encoding: "utf8" }))[0];
  assert.ok(result.files.some(f => f.path === "npm-shrinkwrap.json"));
  assert.ok(!result.files.some(f => f.path.includes(".pi-lock/") || f.path.endsWith("/auth.json")));
  const app = resolve(destination, "app"); mkdirSync(app);
  writeFileSync(resolve(app, "package.json"), JSON.stringify({ name: "installed-consumer", version: "1.0.0", private: true, type: "module" }));
  execFileSync("npm", ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", resolve(destination, result.filename)], { cwd: app, encoding: "utf8" });
  const agent = resolve(app, "agent"); mkdirSync(agent);
  cpSync(resolve(root, ".pi"), resolve(agent, ".pi"), { recursive: true }); cpSync(resolve(root, "pi.lock"), resolve(agent, "pi.lock"));
  const binary = resolve(app, "node_modules/pi.lock/dist/cli.js");
  const verified = execFileSync(process.execPath, [binary, "--project", agent, "verify"], { cwd: app, encoding: "utf8" });
  assert.match(verified, new RegExp(lock.agentDigest));
  const answer = execFileSync(process.execPath, [binary, "--project", agent, "-p", "/hello", "--no-session"], { cwd: app, encoding: "utf8" });
  assert.match(answer, /same Pi agent/);
});
