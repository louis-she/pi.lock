#!/usr/bin/env node
// This entry intentionally imports no Pi code until its per-process paths are bound locally.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, findProject, json, atomicJson, LockError, PI_VERSION } from "./common.js";

const help = `pi-lock — Pi ${PI_VERSION}, project-local and reproducible

  pi-lock init [--demo]              Create ordinary .pi settings and resources
  pi-lock lock                       Generate/update pi.lock after editing
  pi-lock                            Open Pi's native TUI (frozen by default)
  pi-lock -p "prompt"                Print a response and exit
  pi-lock --mode rpc                 Use Pi's JSONL RPC protocol
  pi-lock --mode json "prompt"       Stream Pi JSON events
  pi-lock inspect                    Show the locked resources and fingerprint
  pi-lock verify                     Verify source/dependencies against pi.lock
  pi-lock sync --frozen               npm ci, then verify; never rewrite pi.lock

  --project <dir>                    Agent definition root (auto-detected)
  --cwd <dir>                        Task workspace (does not change the agent)
  --dev                              Edit/tune before locking; /reload reads local edits
  --provider <id> --model <id>        init/--dev only; saves local Pi settings
  --thinking <level> --tools <list>   --dev only; saves local Pi settings
  --session <file>                   Resume a matching locked session
  --session-dir <dir>                Explicit application-owned session directory
  --no-session                      Use an in-memory session
  -c, --continue                     Continue latest session of this Agent version
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { console.log(help); return; }
  if (args.includes("--version") || args.includes("-v")) { console.log(`pi-lock 0.1.1 (Pi ${PI_VERSION})`); return; }
  const commands = new Set(["init", "lock", "inspect", "verify", "sync"]);
  let command = commands.has(args[0]) ? args.shift()! : "run";
  const flags: Record<string, string | boolean> = {};
  const messages: string[] = [];
  const booleanFlags = new Set(["--demo", "--dev", "--no-session", "--frozen", "--continue", "-c", "-p", "--print"]);
  const valueFlags = new Set(["--project", "--cwd", "--mode", "--provider", "--model", "--thinking", "--tools", "--session", "--session-dir"]);
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") { messages.push(...args); break; }
    if (booleanFlags.has(arg)) flags[arg] = true;
    else if (valueFlags.has(arg)) {
      const value = args.shift(); if (!value || value.startsWith("--")) fail("ARGUMENT", `${arg} needs a value.`); flags[arg] = value;
    } else if (arg.startsWith("-")) fail("ARGUMENT", `Unknown option ${arg}. Run pi-lock --help.`);
    else if (command === "run" && !messages.length && !flags["-p"] && !flags["--print"] && !flags["--mode"] && commands.has(arg)) command = arg;
    else messages.push(arg);
  }
  const cwd = resolve(String(flags["--cwd"] ?? process.cwd()));
  const root = command === "init" ? resolve(String(flags["--project"] ?? cwd)) : findProject(cwd, flags["--project"] as string | undefined);
  // Pi TUI helpers still use getAgentDir(); set it before importing Pi, inside this CLI process only.
  const uiRoot = resolve(root, ".pi-lock/state/ui");
  mkdirSync(uiRoot, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = uiRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = resolve(root, ".pi-lock/state/sessions");
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  const { execute } = await import("./commands.js");
  await execute(command, root, cwd, flags, messages);
}
main().catch(error => {
  console.error(`${error instanceof LockError ? error.code : "PI_LOCK_ERROR"}: ${error.message}`);
  process.exitCode = 1;
});
