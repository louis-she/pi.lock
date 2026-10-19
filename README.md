# pi.lock

Use Pi's native project configuration and TUI to tune an agent locally, then lock and deploy the same agent through Git. pi.lock provides one frozen runtime for the CLI, SDK, and RPC.

Requires Node.js **22.19+**. Supports Pi **1.3.0**.

## Install

```sh
npm install pi.lock
```

## Build and lock an agent

For a new agent, initialize project-local Pi configuration. If the project already has `.pi/settings.json`, keep it and skip `init`:

```sh
npx pi-lock init
npx pi-lock --dev
```

`--dev` opens Pi's native TUI for this project. pi.lock loads project resources only; it does not load `~/.pi`, `~/.agents`, or resources from parent directories.

When the agent is ready, create the lock:

```sh
npx pi-lock lock
```

Commit `.pi/`, project `.agents/skills/` if used, `pi.lock`, and the npm manifests and lockfiles. Frozen runs reject changes to locked files, dependencies, model settings, or tool schemas. Edit in `--dev` and run `lock` again to update the agent. `.pi-lock/` holds local sessions, credentials, and runtime snapshots. `init` adds it to `.gitignore`; if you skipped `init`, add it yourself.

## Deploy and roll back

Deploy the Git commit containing the agent and its dependency lockfiles:

```sh
npm ci
npx --no-install pi-lock sync --frozen
npx --no-install pi-lock verify
```

To roll back, deploy the earlier Git commit, including its `pi.lock` and npm lockfiles, then run the same commands. Sessions are bound to one agent version; resume them with the matching release or start a new session. Rolling back the agent does not undo external side effects from earlier tool calls.

## Use from an application

The project and `pi.lock` stay the same; only the entry point changes. For an SDK host, select the agent project and task workspace:

```ts
import { createAgentSession } from "pi.lock";

const agent = await createAgentSession({
  projectRoot: "/app/my-agent",
  cwd: "/data/current-task",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

try {
  await agent.session.prompt("Summarize these files");
  console.log(agent.session.getLastAssistantText());
} finally {
  await agent.dispose();
}
```

For RPC, launch the same project with Pi's JSONL protocol:

```sh
npx --no-install pi-lock --mode rpc
```

See the [architecture notes](docs/architecture.md) for implementation boundaries and the [acceptance report](docs/acceptance.md) for tested behavior and environment limits.
