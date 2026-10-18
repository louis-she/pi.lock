# pi.lock

Use one Pi agent from the terminal, RPC, or the SDK with the same project configuration and resources. Commit `pi.lock` with your code to deploy or roll back the agent through Git.

Requires Node.js **22.19+** and supports Pi **1.3.0**.

## Install and configure

```sh
npm install pi.lock
npx pi-lock init --provider deepseek --model deepseek-chat
```

Set your provider API key, for example `DEEPSEEK_API_KEY`. If you already have `.pi/settings.json`, keep it and skip `init`.

Tune the agent in development mode. Edit its instructions, skills, or extensions under `.pi/` as needed:

```sh
npx pi-lock --dev
```

If no default model is configured, start anyway. Sign in with `/login` if needed, then choose a model with Pi's `/model` selector. The first selection is saved to this project's `.pi/settings.json`.

When it is ready, record its configuration and resources in `pi.lock`:

```sh
npx pi-lock lock
```

## Run the agent

The default command opens Pi's native TUI. You can also send a one-shot prompt or use Pi's RPC protocol:

```sh
npx pi-lock
npx pi-lock -p "Summarize these files"
npx pi-lock --mode rpc
```

Normal mode is frozen: if locked files, dependencies, model settings, or tool schemas change, pi.lock reports an error. Make changes with `--dev`, then run `lock` again.

## Use it from the SDK

```ts
import { createAgentSession } from "pi.lock";

const agent = await createAgentSession({
  projectRoot: "/app/my-agent", // Directory containing .pi/ and pi.lock
  cwd: "/data/current-task",  // Working directory for this task
  apiKey: process.env.DEEPSEEK_API_KEY,
});

try {
  await agent.session.prompt("Summarize these files");
  console.log(agent.session.getLastAssistantText());
} finally {
  await agent.dispose();
}
```

`projectRoot` selects the agent definition; `cwd` selects the task's working directory. Both can be omitted when running from the agent project directory. The returned session is Pi's native `AgentSession`.

## Keep the agent with your project

Commit the agent definition, `pi.lock`, and npm lockfiles to Git:

```text
my-agent/
├── .pi/
│   ├── settings.json
│   ├── SYSTEM.md
│   ├── extensions/
│   ├── skills/
│   └── prompts/
├── pi.lock
├── package.json
└── package-lock.json
```

The project root's `AGENTS.md` and project-local `.agents/skills/` are included. pi.lock does not load `~/.pi`, `~/.agents`, or resources from parent directories. Local sessions, credentials, and runtime snapshots go in `.pi-lock/` and should not be committed.

For deployment, install the versions recorded by your package lockfile and verify the agent before starting it:

```sh
npm ci
npx --no-install pi-lock sync --frozen
npx --no-install pi-lock verify
```

To roll back, check out the earlier Git commit and install that commit's dependency versions. Each running session remains bound to its agent version.

For extension, MCP, and compatibility details, see the [architecture notes](docs/architecture.md). Test coverage and environment limits are in the [acceptance report](docs/acceptance.md).
