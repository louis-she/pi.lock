# pi.lock Acceptance Report

Acceptance date: 2026-10-18 (Asia/Shanghai). Project and npm package: `pi.lock@0.1.0`. Supported Pi version: **1.3.0**.

## Runtime-store follow-up — 2026-10-19

`npm test` passed **28 tests, 0 failures** after moving runtime data to `~/.pi-lock/`. The acceptance suite verifies that sessions are stored outside the project, projects have isolated mutable state, and identical `agentDigest` snapshots are shared. The npm build ran as part of the test command.

The package identifier and SDK self-reference were updated for publication as `pi.lock`; the CLI command remains `pi-lock`.

## Results

`npm test`: **26 passed, 0 failed, 0 skipped**, about 47.2 seconds. TypeScript build passed. The full output is available in [acceptance.tap](acceptance.tap).

Both the source checkout and packed npm package were run. After installation in a clean application directory, the package verified and ran an unchanged agent definition and lockfile. The acceptance test checks that the npm package includes `npm-shrinkwrap` and excludes `.pi-lock` state and `auth.json`.

## Acceptance scope

| Capability | Evidence collected |
|---|---|
| Pi version | Official npm registry reported `latest` as 1.3.0; dependency versions are exact-pinned |
| Global configuration isolation | Polluted HOME, global extensions and skills, parent AGENTS, and task-directory `.pi`; marker extension did not execute and ambient instructions were not loaded |
| Portable resources | Copied an agent to another directory; digest, effective configuration fingerprint, and content matched |
| SDK / TUI / RPC / print | Real Pi `AgentSession`; native TUI ran in a PTY; compared provider transcripts/options, including hooks, tool schemas, and the follow-up request after tool execution |
| HTTP model path | Connected Pi's native OpenAI-compatible HTTP streaming implementation to a local service; compared SDK and CLI request bodies and checked explicit credential injection |
| Frozen execution | Additions, modifications, and deletions of resources; model/thinking/settings changes; and lockfile or snapshot tampering were rejected |
| Lifecycle | New, reloaded, forked, and resumed sessions used the locked factory; RPC new-session initialization ran once |
| Multiple agents | Ran two agents concurrently in one SDK process; reloading one left the other working; process cwd/env stayed unchanged |
| Git rollback | Committed V1 and V2 in a temporary Git repository, checked out V1, and ran it; an already-started V1 continued reading its snapshot after the source directory changed to V2 |
| Session version | Resuming an old session with a new agent version failed explicitly |
| npm package and dependencies | Ran real npm pack/install; package resources, helper imports, and dependency files were locked; tampering was rejected; missing dependencies after relocation prevented execution and `sync --frozen` restored them |
| MCP | A local stdio server tool call succeeded; schema changes before startup and during a session were detected; codemode/deferred exposure initialized through native tool support |
| Interaction | SDK without a callback did not auto-approve; explicit native `uiContext.confirm` callback worked |
| Model fallback | A missing locked model failed instead of selecting another model |
| Native resource conventions | Project AGENTS, project `.agents/skills`, loose skills, globs, and resource exclusions resolved correctly |
| Tune, then release | Native model selection API wrote to `.pi/settings.json` in development mode; the next lock used the saved model |
| RPC output | Extension startup `console.log` did not corrupt JSONL stdout |
| Package reproducibility | Installed the tarball in a new application without source-project development dependencies; the unchanged lock verified and ran |

Request comparisons normalize deployment paths, session/response IDs, timestamps, durations, and usage statistics from the local mock model. Instructions, content, tool schemas, call arguments, and hook results are compared.

## Environment

- macOS 27.0.1 / arm64
- Node.js v22.23.2
- npm 10.9.8
- Pi `@earendil-works/pi-coding-agent` 1.3.0
- The PTY driver uses system Python 3; it is not a runtime requirement for pi-lock
- Demo agent digest: `bf54f0845e5553fc6948add9a1711455feb5bc98d39eb40a9ade8cca00436827`
- Full test-log SHA-256: `4e41da880942cf2bffa3d2c53cb23c77fdba932a90693c488891a6765265de1d`

## Tested boundaries

Model responses came from a deterministic local provider and local HTTP fixture; no real provider account, paid request, or live model response was used as a substitute for consistency checks. MCP tool calls and drift detection used a local stdio fixture. External MCP HTTP services, OAuth provider login, and the full third-party extension ecosystem were not tested against live services.

Relocation and clean-install tests ran in separate directories on the same macOS machine. The Docker command was available, but its daemon was not, so Linux, Windows, and another physical machine were not tested. Same-machine directory relocation is not represented as cross-platform acceptance.

See the [README](../README.md) and [architecture notes](architecture.md) for extension compatibility, host-command dependencies, session migration, and external side-effect boundaries.
