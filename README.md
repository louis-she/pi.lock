# pi.lock

Build a Pi agent locally, lock its behavior with `pi.lock`, then deploy or roll it back with your application through Git. Use Pi's native project configuration and TUI while developing; the SDK and RPC use the same locked agent in production.

Requires Node.js **22.19+**. Supports Pi **1.3.0**.

## Install

```sh
npm install pi.lock
```

## Build and test your agent locally

For a new agent, initialize a normal project-local Pi configuration. If `.pi/settings.json` already exists, keep using it and skip `init`:

```sh
npx pi-lock init
npx pi-lock --dev
```

`--dev` opens Pi's native TUI. Sign in with `/login` and choose a provider and model with `/model`. Then build the agent the way you normally would with Pi: edit `.pi/settings.json` and `.pi/SYSTEM.md`, add project skills, extensions, and prompt templates, and try real prompts. Use `/reload` after changing resources.

Keep resources in the project, such as `.pi/skills/`, `.pi/extensions/`, `.pi/prompts/`, or `.agents/skills/`. To make an agent portable, pi.lock deliberately does not load `~/.pi`, `~/.agents`, or resources from parent directories.

When the agent behaves as you expect, save the tested definition:

```sh
npx pi-lock lock
```

Commit `.pi/`, project `.agents/skills/` if used, `pi.lock`, and the npm manifests and lockfiles. `.pi-lock/` contains local sessions, credentials, and runtime snapshots. `pi-lock init` adds `.pi-lock/` to `.gitignore`; if you skipped `init` for an existing project, add it there yourself.

## Deploy and roll back

Deploy the Git commit containing the agent and install its pinned dependencies:

```sh
npm ci
npx --no-install pi-lock sync --frozen
npx --no-install pi-lock verify
```

To roll back, deploy the earlier Git commit, including its `pi.lock` and npm lockfiles, then run the same commands. A session belongs to one agent version: resume it with the matching release or start a new session. Rolling back the agent does not undo external side effects from earlier tool calls.

## Use the same agent from an application

The agent definition and `pi.lock` stay the same; only the entry point changes. In an SDK host, provide the agent project and task workspace explicitly:

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

To integrate through Pi's JSONL RPC protocol, launch the same project with:

```sh
npx --no-install pi-lock --mode rpc
```

For extension, MCP, and compatibility details, see the [architecture notes](docs/architecture.md). The [acceptance report](docs/acceptance.md) describes tested behavior and environment limits.
