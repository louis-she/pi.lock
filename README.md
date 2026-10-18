# pi.lock

Use the same Pi agent from a local terminal, RPC, or the SDK with the same configuration, instructions, skills, extensions, and tools. Deploy and roll it back with Git.

Supported Pi version: **1.3.0** (verified as the npm `latest` release on 2026-10-18). Requires Node.js **22.19.0+**.

pi.lock uses Pi's native `.pi/settings.json`, `SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, TUI, and RPC protocol. The main addition is `pi-lock lock`, which captures a tuned agent. Use the project-local `pi-lock` command in place of `pi`; import `createAgentSession` from `pi.lock` in the SDK.

## Name and package

The project is named **pi.lock**. One npm package provides both its CLI and SDK:

| Purpose | Name |
|---|---|
| Project name | pi.lock |
| Agent lockfile | `pi.lock` |
| npm package and SDK import | `pi.lock` |
| CLI command | `pi-lock` |
| Local snapshots, credentials, and sessions | `.pi-lock/` (excluded from Git) |

The current version is `0.1.0`. Install the published package with `npm install pi.lock`. The CLI command remains `pi-lock`.

## Try it without an API key

Run these commands from the source checkout:

```sh
npm ci
npm run build
node dist/cli.js --project examples/demo lock
node dist/cli.js --project examples/demo -p /hello
node dist/cli.js --project examples/demo
```

The last command opens Pi's native TUI. The demo uses a deterministic local provider and an echo tool; it makes no model-service requests. It also includes a skill and a `/hello` prompt template.

## Use it in your project

Install the npm package as a project dependency:

```sh
npm install pi.lock
npx --no-install pi-lock init --provider deepseek --model deepseek-chat
```

If your project already has `.pi/settings.json`, keep it and skip `init`.

Set the API-key environment variable for your provider. For example, DeepSeek uses `DEEPSEEK_API_KEY`. After changing `.pi/SYSTEM.md`, skills, or extensions, tune the agent in development mode:

```sh
npx --no-install pi-lock --dev
```

Development mode supports Pi's `/model`, `/settings`, and `/reload` commands. Behavior settings are written to this agent's `.pi/settings.json`. Restart the development session after changing provider definitions.

When you are done tuning, lock the agent and run it in the default frozen mode:

```sh
npx --no-install pi-lock lock
npx --no-install pi-lock
npx --no-install pi-lock -p "Help me with this task"
npx --no-install pi-lock --mode rpc
```

Frozen mode is the default. Changes to files, missing dependencies, model changes, and tool-schema differences produce explicit errors. The runtime does not supplement resources from global configuration, switch models, or update dependencies automatically. Use `--dev` to make changes, then run `lock` again.

## SDK: the same agent

```ts
import { createAgentSession } from "pi.lock";

const agent = await createAgentSession({
  projectRoot: "/app/my-agent", // Contains .pi/ and pi.lock
  cwd: "/data/current-task",  // Working directory for the agent's task
  apiKey: process.env.DEEPSEEK_API_KEY,
});

try {
  await agent.session.prompt("Help me with this task");
  console.log(agent.session.getLastAssistantText());
  console.log(agent.agentDigest);
} finally {
  await agent.dispose();
}
```

When run from the agent project directory, you can omit both `projectRoot` and `cwd`. `projectRoot` selects the agent definition; `cwd` selects the task data location. Instructions and `.pi` configuration in the working directory or its parents are not merged into an explicitly selected agent.

The returned `session` is Pi's `AgentSession`, with native streaming events, cancellation, and history support. `agent.runtime` provides `newSession()`, `fork()`, and `switchSession()`. After replacing a session, read the current session through `agent.session` and subscribe to its events again. `agent.dispose()` runs extension cleanup and releases the session.

To manage history yourself, pass Pi's native `SessionManager`:

```ts
import { createAgentSession, SessionManager } from "pi.lock";

const agent = await createAgentSession({
  projectRoot: "/app/my-agent",
  cwd: "/data/current-task",
  sessionManager: SessionManager.inMemory("/data/current-task"),
});
```

The SDK also accepts `credentials` (Pi's native `CredentialStore`), `env` (named credential bindings), `uiContext`, `sessionFile`, and `sessionDir`. Model, tool, and resource configuration lives in `.pi`; the SDK does not have a second configuration surface. Unsupported behavior overrides return an error.

## Project files and local state

```text
my-agent/
├── .pi/
│   ├── settings.json
│   ├── SYSTEM.md
│   ├── models.json             # Optional: native Pi custom-provider definitions
│   ├── mcp.json                # Optional: native Pi MCP configuration
│   ├── extensions/
│   ├── skills/
│   └── prompts/
├── pi.lock                    # Commit to Git
├── package.json               # Commit when using npm dependencies
├── package-lock.json          # Commit when using npm dependencies
└── .pi-lock/                  # Created automatically; excluded from Git
    ├── releases/<digest>/     # Immutable code and resource snapshots
    └── state/                 # Local sessions, TUI state, and CLI credentials
```

The project root's `AGENTS.md` or `AGENTS.override.md` and project-local `.agents/skills/` are included in the lock. Parent directories, `~/.pi`, and `~/.agents` are not searched.

`pi.lock` records the resource inventory and load order, file hashes, npm dependency versions and integrity, model metadata, tool schemas, the initialized configuration fingerprint, and fingerprints for the Pi/pi-lock runtime code. Managed paths are relative to the project root.

The CLI's `/login` stores credentials in `.pi-lock/state/auth.json`. SDK applications can inject their own credential store. Credentials and sessions are not written to the lockfile. Do not copy a user-level `auth.json`, `models-store.json`, or entire sessions directory into `.pi`.

## Deployment and rollback

Commit `.pi/`, `pi.lock`, and the npm manifests and lockfiles you use. A recommended approach is to deploy each Git commit into its own directory:

```sh
npm ci
npx --no-install pi-lock sync --frozen
npx --no-install pi-lock verify
```

You do not need `npm ci` if the agent has no additional npm dependencies. `sync --frozen` restores npm-locked dependencies in the project root and `.pi/npm/`, then verifies the agent without rewriting `pi.lock`.

To roll back, restore the earlier Git commit and the matching pi-lock npm package version, then start that runtime. New sessions use that version. Older sessions carry their own `agentDigest` and are explicitly rejected if the version does not match. A running runtime continues to use its own snapshot, so a Git checkout change cannot mix another version's skills into it.

Keep each release's dependency packages or a reproducible source for them. A lockfile cannot recover a package that has been removed from its remote source. Local npm tarballs must also be stored and committed within the project.

Inspect the current lock:

```sh
npx --no-install pi-lock inspect
```

## Extensions, npm packages, and MCP

The standard Pi TypeScript/JavaScript extension API remains unchanged. Relative helper imports for local extensions are included in the snapshot. Install external npm dependencies in the current project and pin them with an npm lockfile. Pi host packages and TypeBox use the same host instance instead of being duplicated. TypeScript compilation caches are disabled, and path mappings from another project's `tsconfig` are not read.

Use the `packages` declaration in `.pi/settings.json` to load local resource packages, packages in the project's `node_modules`, or packages installed by `pi install -l` into `.pi/npm/node_modules`. Pi package manifests, globs, and resource filters are supported. If you specify a version, it must match the exact installed version; you can also omit the version and let `pi.lock` record the installed version.

Vendor Git-based resource packages into the project or distribute them as npm packages pinned by integrity. The first release does not manage Pi's remote Git package installer. External symlinks, global npm packages, and API keys generated by shell commands are not part of frozen execution.

MCP uses `mcpServers` from `.pi/mcp.json`. It supports stdio and Streamable HTTP, with direct, codemode, deferred, and hidden tool exposure. Tool-call adaptation, codemode, and `tool_search` use Pi 1.3.0 implementations. Server instructions, capabilities, and tool schemas are recorded at lock time and checked at startup and when making requests.

Stdio MCP servers must use `node` or a project-relative executable; relative script paths in their configuration are included in the snapshot. Put any additional runner in the project dependencies. HTTP authentication uses explicit `${VARIABLE}` bindings. The first release does not read global MCP OAuth credentials automatically. A stdio child process receives only the configured environment variables and the Node executable's PATH; it does not inherit the entire user environment. Use `${WORKSPACE}` in arguments for the task directory and `${AGENT_ROOT}` for the current resource snapshot.

## Guarantees and compatibility boundaries

- Resource discovery uses only the locked inventory and supported entry points. The original global `pi` command and SDK do not automatically recognize `pi.lock`; use this project's CLI or SDK entry points.
- Extensions that read user directories, dynamically import arbitrary external code, or change business logic based on `ctx.mode` need adaptation. pi-lock checks initialized configuration and rejects detectable differences, but it is not an OS sandbox for arbitrary JavaScript. Direct mutation of Pi internals by an SDK host is also outside the freeze contract.
- Task files, session history, external-service responses, credentials, and the clock are runtime inputs. Programs launched by filesystem tools still require a compatible host environment. A locked configuration cannot make a macOS-only command run on Linux.
- The SDK does not modify `process.env`, `HOME`, or the process working directory. The CLI sets project-local Pi state paths in its own process and disables Pi's automatic downloads and updates. Native TUI colors and key bindings affect presentation, not the agent definition.
- A headless call that needs user interaction reports `INTERACTION_REQUIRED` by default; it does not approve automatically. The SDK can receive native `uiContext` callbacks. RPC and TUI use Pi's own interaction channels.
- Session metadata is bound to an agent version. Applications must explicitly handle version and data migrations, and reversal of side effects already performed by external tools.
- See the [acceptance report](docs/acceptance.md) for the tested environment. Tests in temporary directories on one machine are not presented as proof of cross-platform operation or compatibility with every third-party extension.

## Development and acceptance

```sh
npm ci
npm test
```

Acceptance uses Pi's real `AgentSession`, native TUI (through a PTY), native RPC, native OpenAI-compatible HTTP streaming, and a local MCP server. Model responses come from deterministic local fixtures, so no real account or paid request is required.

See the [architecture notes](docs/architecture.md) for implementation details and trade-offs.
