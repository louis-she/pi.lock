# pi.lock architecture

The project and npm package are named **pi.lock**. The CLI command remains `pi-lock`; the SDK imports from `pi.lock`; the Agent lockfile is also `pi.lock`; local runtime state lives in `.pi-lock/`.

## One construction path

`src/runtime.ts:createLockedRuntime` is shared by the SDK, Pi InteractiveMode, Pi runRpcMode, and Pi runPrintMode. It constructs Pi's AgentSessionRuntime with an explicit runtime factory. Every new/resumed/forked session goes through that factory. No adapter invokes Pi's default service/resource discovery.

`src/bridge.ts` contains the imports that use the pinned Pi 1.3.0 internal layout. Pi exports the ResourceLoader contract, but not its explicit extension-factory initializer or every MCP helper. Those version-specific integration points are isolated instead of modifying the installed Pi package.

## Definition and locking

The human-facing source remains native `.pi` configuration. `readDefinition` computes a project-scoped inventory, follows declared resources/packages, captures relative extension helpers, and records integrity-pinned local npm dependencies. It rejects escaping paths and symlinks. Package hashes include supporting files, not only extension entry points and SKILL.md.

The runtime identity hashes compiled pi-lock JavaScript and the installed production dependency closure, excluding packages containing only TypeScript declarations. npm can hoist a developer's @types/node into a dependency's type-only edge; such non-executable metadata must not change Agent identity. The distributed npm package carries a shrinkwrap generated from the source package-lock so fresh installations restore the runtime dependency graph. The definition and effective startup configuration are included in the lock digest. This prevents a nominally identical Pi version string from silently masking a different installed implementation.

`lockProject` builds a candidate snapshot, initializes extensions, captures the effective model/prompt/resource/tool configuration, rechecks that source did not change during initialization, and only then atomically saves pi.lock. Credentials, wall-clock timestamps and absolute deployment paths are not lock identifiers. Absolute resource/workspace paths in diagnostics are normalized to `<AGENT>` and `<WORKSPACE>`.

## Execution and immutability

Frozen startup checks both the installed implementation and current project inventory against pi.lock. It materializes ordinary files in `.pi-lock/releases/<agentDigest>` and verifies them before executing extensions. That snapshot, not the source tree, supplies lazy Skill/template reads and relative imports. Changing or checking out source files therefore does not switch an existing session's instruction files.

Frozen reload verifies source before reinitializing the locked snapshot. Developer reload intentionally creates a new snapshot from current project resources. Provider/model definition changes during development require a restart; ordinary local prompt/Skill/extension reloads preserve Pi's normal `/reload` workflow.

SessionManager remains Pi's native JSONL/in-memory tree manager. An initial custom entry binds each transcript to agentDigest. An imported transcript without a pin or a transcript from another version is rejected. No automatic history migration is attempted.

## Isolation scope

SettingsManager is in memory in frozen mode. Developer writes use a custom storage backend bound to exactly `.pi/settings.json`. ModelRuntime has an explicit credential store and in-memory model store, no models.json path discovery and no remote catalogue refresh. A missing model never falls back to the first available provider.

The custom ResourceLoader never walks parent context directories or user-global resource locations. Extension compilation disables filesystem cache and tsconfig path discovery; Pi and TypeBox imports are mapped to the pinned host modules. Additional resources returned by `resources_discover` are rejected unless first declared as project resources and locked.

No process-global environment or cwd changes are made by the SDK. The standalone CLI sets Pi's process-level paths before importing Pi so the native TUI's remaining getAgentDir calls target `.pi-lock/state/ui`. This is deliberately confined to the CLI process.

This is a reproducibility contract for cooperating host code and compatible extensions. Unrestricted JavaScript, filesystem tools, shell commands and external services retain their normal effects. It is not a sandbox or a proof that arbitrary dynamically generated code has no ambient dependencies.

## MCP

MCP connections are established before startup validation. The same connected clients supply the recorded catalogue and execute calls. Server instructions, capabilities, and all paginated tool schemas are compared against the lock; catalogues are checked again before requests/tool calls. A server-side change fails explicitly instead of replacing a same-named tool silently.

Pi's native MCP tool-definition adapter and its codemode/tool-search extensions provide tool exposure and execution. The project-specific transport/bootstrap layer supplies only explicit configuration, secrets, roots and process environment. Resource-list/read adapters call the same MCP clients. OAuth providers or non-project command runners require explicit integration.

## Evidence

Acceptance tests compare the actual provider transcript/options across SDK, print, RPC and a PTY-hosted native TUI, including an extension prompt hook and the second tool-result round. Only path relocation, transcript timestamps, durations, response/session identifiers and fake-provider usage metadata are normalized. Another test uses Pi's native OpenAI HTTP implementation and compares actual request bodies and explicit Authorization headers against a local streaming server.

Other tests cover polluted HOME/workspace/ancestor settings, source/dependency/snapshot tampering, npm restoration after relocation, Git rollback with live old snapshots, session version mismatches, lifecycle changes, multiple SDK agents, missing interaction callbacks and MCP drift. The final execution record is in acceptance.md.
