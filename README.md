# pi.lock

A portable Pi agent you can version and roll back with Git.

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

Now build and test your Pi agent as you normally would. When it is ready, create the lock:

```sh
npx pi-lock lock
```

Commit the project as you normally would:

```sh
git add -A
```

`init` adds `.pi-lock/` to `.gitignore`; it holds local sessions, credentials, and runtime snapshots. If you skipped `init`, add `.pi-lock/` to `.gitignore` before committing.

Frozen runs reject changes to locked files, dependencies, model settings, or tool schemas. Edit in `--dev` and run `lock` again to update the agent.

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
