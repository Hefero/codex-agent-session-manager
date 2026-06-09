# Codex Agent Session Manager

[![npm version](https://img.shields.io/npm/v/codex-agent-session-manager.svg)](https://www.npmjs.com/package/codex-agent-session-manager)
[![npm alpha](https://img.shields.io/npm/v/codex-agent-session-manager/alpha.svg?label=alpha)](https://www.npmjs.com/package/codex-agent-session-manager)
[![GitHub release](https://img.shields.io/github/v/tag/Apethor/codex-agent-session-manager?filter=v*&sort=semver&label=release)](https://github.com/Apethor/codex-agent-session-manager/releases)

Agent-facing Codex App Server session manager with an MCP validation harness.

The goal is to expose selected Codex App Server session operations as safe MCP
tools that a Codex agent can call from inside its own workflow.

This project is currently in alpha. It is intended for Codex/App Server
workflows that need MCP refresh and session-management automation.

Early scope:

- discover loaded and persisted Codex threads;
- identify the intended thread with cwd, status, and marker evidence;
- reload MCP server processes and continue after an idle boundary;
- close or replace stale managed remote sessions;
- track operations with status, logs, and next actions;
- install npm MCP packages into project-scoped Codex config;
- validate MCP callable-catalog changes from a fresh model turn.

The project is intentionally starting from the session-management architecture,
not from a generic App Server SDK or a human session browser.

## Install

Install per project:

```powershell
npm install -D codex-agent-session-manager
npx codex-agent-session-manager init
codex
```

`init` is project-scoped. It updates `.codex/config.toml` with the
`codex_agent_session_manager` MCP server, adds local runtime and common secret
patterns to `.gitignore`, creates or updates `package.json` with
`codex:init`, `codex:init:dry-run`, remote, and App Server package scripts, and
creates or updates a small `AGENTS.md` block unless `--no-agents` is passed. It
does not edit the user's global Codex config. It also does not edit shell
profiles unless `--install-shell-hook` is explicitly passed.

After `init`, a normal Codex session started from the project directory can use
the session-manager MCP tools; `npm run codex:remote` is optional. Use the
generated remote script when you want this package to start or reuse a managed
App Server, launch a remote TUI, or use the session close/replace helpers.
On Windows, the generated project config routes the session-manager stdio MCP
server through `.codex-agent-session-manager/windows-hidden-stdio-launcher.exe`
so plain `codex` sessions do not need a visible helper console for this MCP.
The MCP config points at the project-local
`node_modules/codex-agent-session-manager/dist/cli.js` entrypoint. If the local
package is missing, `init` runs `npm install --save-dev --ignore-scripts
--no-audit --no-fund --cache ./.npm-cache codex-agent-session-manager@<version>`
so even an empty workspace becomes self-contained.

After upgrading this package in an existing project, rerun
`npx codex-agent-session-manager init` to refresh the managed `AGENTS.md`,
`.gitignore`, package scripts, and MCP config block. If the binary is installed
globally or linked on PATH, `codex-agent-session-manager init` is equivalent.
If the project already has the generated npm scripts, `npm run codex:init` is
also equivalent. The init operation is idempotent and project-scoped.

Remove from a project:

```powershell
codex-agent-session-manager app-server stop --dry-run
codex-agent-session-manager stop --confirm
codex-agent-session-manager deinit --confirm --remove-runtime
npm uninstall -D codex-agent-session-manager
```

`deinit` defaults to dry-run unless `--confirm` is passed. It removes only the
project-scoped scaffold it can recognize: the managed `.codex/config.toml`
block, generated npm scripts, managed `AGENTS.md` block, and local runtime
and npm-cache ignore rules. Runtime state under
`.codex-agent-session-manager/` is removed only with `--remove-runtime`. MCP
server blocks created through `mcp add npm` are kept unless
`--remove-added-mcps` is passed; when removed, `deinit` reports the npm
packages selected for uninstall or scratch-project removal. It does not stop a
running Codex App Server, remote TUI, or already-loaded MCP server processes;
stop or reload active sessions before uninstalling packages when live
processes must exit.
Scratch test workspaces can also use `deinit --confirm
--remove-added-mcps --remove-empty-npm-project --remove-empty-codex-dir` to
remove an npm skeleton that contains only this package and npm MCP packages
created by `mcp add npm`. This refuses to remove `package.json` when unmanaged
dependencies or custom scripts remain.

## Current Surface

The current MCP surface is still small, but already dogfooded:

- TypeScript ESM package.
- MCP stdio server using `@modelcontextprotocol/sdk`.
- Zod-backed tools:
  - `codex_app_server_start`
  - `codex_app_server_state_read`
  - `codex_app_server_status`
  - `codex_app_server_stop`
  - `codex_mcp_add_npm`
  - `codex_mcp_refresh`
  - `codex_mcp_reload`
  - `codex_mcp_status_list`
  - `codex_operation_read`
  - `codex_operation_wait`
  - `codex_session_close`
  - `codex_session_continue`
  - `codex_session_hard_relaunch`
  - `codex_session_launch`
  - `codex_session_manager_probe`
  - `codex_session_replace`
  - `codex_thread_context`
  - `codex_threads_list`
- Durable operation resource: `codex-session-manager://operations`.
- Raw JSON-RPC smoke test for MCP initialization, tool listing, tool call, and
  resource listing.

MCP status from App Server is treated as diagnostic only. Callable-catalog proof
requires a real model-callable tool invocation from the correct continuation or
replacement boundary.

`codex_thread_context` recommends a target thread from loaded threads first,
then stored-thread and recent operation-state hints. Operation-derived thread
ids are low-confidence recovery evidence, useful when `thread/list` is empty
after a remote TUI exits.

For the common "MCP changed, refresh and continue" path, use
`codex_mcp_refresh`: it reloads MCP servers, records before/after status
evidence, waits for the target thread to become idle, and starts the
continuation turn. A completed refresh/continue operation means `turn/start`
was accepted; it does not mean the child turn finished. The continuation must
still perform the actual proof call, then stop validation and report the
result.

When `codex_session_continue` targets the current thread, schedule it and end
the current turn. Calling `codex_operation_wait` or `codex_operation_read` from
that same active turn keeps the target thread busy, so the background child
cannot observe the idle boundary it needs before `turn/start`.

`codex_session_hard_relaunch` is an experimental escape hatch. Detached mode is
for plain `codex` sessions: it identifies the current Codex TUI from process
ancestry, resumes the current thread by default with an optional non-secret
prompt, then attempts to stop the old TUI process tree. With the opt-in shell
hook installed, `handoffMode: "shell-resume-next"` writes
managed-remote resume state so the shell hook relaunches through
`codex-agent-session-manager remote` in the same terminal. It does not use App
Server `turn/start` directly, and its prompt eventually reaches Codex through a
CLI argument surface, so it must never contain secrets.

## Public CLI

The package also exposes a public CLI for operator workflows. It is a thin
wrapper over the same guarded operation builders used by the MCP tools; it does
not expose raw arbitrary App Server JSON-RPC.

```powershell
codex-agent-session-manager init --dry-run
codex-agent-session-manager init
codex-agent-session-manager init --install-shell-hook
codex-agent-session-manager deinit --dry-run
codex-agent-session-manager deinit --confirm --remove-runtime
codex-agent-session-manager shell-hook install --dry-run
codex-agent-session-manager shell-hook install --confirm
codex-agent-session-manager shell-hook uninstall --dry-run

codex-agent-session-manager app-server start --dry-run --port auto
codex-agent-session-manager app-server status --no-probe-ready
codex-agent-session-manager app-server stop --dry-run
codex-agent-session-manager stop --confirm

codex-agent-session-manager mcp add npm @modelcontextprotocol/server-everything --dry-run
codex-agent-session-manager mcp add npm @modelcontextprotocol/server-everything --server-name everything --confirm
codex-agent-session-manager mcp add npm tavily-mcp@latest --server-name tavily_search --env-var TAVILY_API_KEY --no-default-stdio-arg --confirm
codex-agent-session-manager mcp refresh --thread-id <thread-id>

codex-agent-session-manager operation read --operation-id <operation-id>
codex-agent-session-manager operation wait --operation-id <operation-id> --timeout-ms 30000

codex-agent-session-manager session launch --thread-id <thread-id> --dry-run
codex-agent-session-manager session close --thread-id <thread-id> --dry-run
codex-agent-session-manager session replace --thread-id <thread-id> --dry-run
```

The shell hook is opt-in and supports PowerShell, bash, and zsh. Install it with
`codex-agent-session-manager shell-hook install --confirm`, or during init with
`codex-agent-session-manager init --install-shell-hook`. Auto-detection uses
PowerShell on Windows, zsh on macOS when the shell is unknown, and bash on
Linux when the shell is unknown; pass `--shell powershell|bash|zsh` or
`--shell-hook-shell powershell|bash|zsh` to choose explicitly. Outside
initialized workspaces it delegates to the real Codex CLI. Inside initialized
workspaces it makes `codex` enter the managed `remote` path, so a user or
external session launcher can type `codex` while the package starts/reuses the
workspace App Server, records launcher state, and launches the visible TUI with
`--remote`. Basic Codex-style forms are translated: `codex "<prompt>"` becomes
a managed fresh remote with `--prompt`, and
`codex resume <thread-id> "<prompt>"` becomes a managed resume remote.

CLI output is JSON by default. Operations that modify files, run package
installs, are destructive, or launch real processes default to dry-run and
require `--confirm` for real execution.
Continuation and replacement prompts are operator text; prefer `--prompt-file`
when avoiding prompt text in shell history. Prompt files are resolved inside the
current workspace and are limited before being read.

`session close` matches remote TUI processes by thread id when the process argv
contains one. Fresh remote launches may not expose the thread id in argv; in
that case pass `--allow-workspace-url-fallback` only after reviewing the
dry-run. The fallback closes remotes that match the same workspace and App
Server URL, and avoids climbing to a wrapper process that also owns the App
Server.

`init` is the exception: it prints a human-readable action list by default.
Use `codex-agent-session-manager init --json` when automation needs the
machine-readable form.

`mcp add npm` defaults to dry-run. With `--confirm`, it installs an npm MCP
package locally and writes only the project-scoped `.codex/config.toml`. It
does not edit the user's global Codex config. The install uses
`--ignore-scripts --no-audit --no-fund --cache ./.npm-cache` by default; pass
`--allow-scripts` only when the selected package requires npm lifecycle scripts
during install. After a real install, the result reports lifecycle scripts
declared by the package and warns when they were suppressed. The install does
not count as callable proof; run `mcp refresh` and validate with a real tool
call from the continuation.
Use repeated `--env-var <NAME>` for secret-bearing MCPs; this writes
`env_vars = ["NAME"]` and forwards the variable from the launch environment
without storing the secret value in TOML. Use `--no-default-stdio-arg` for npm
MCP packages whose entrypoint defaults to stdio and should not receive a
positional `"stdio"` argument.

For OAuth, PII, write-capable, or destructive MCPs, treat the package install
as only the first step. Prefer read-only scopes first, escalate to write/delete
scopes only after explicit operator approval, keep OAuth clients and token
files outside the workspace or under ignored paths such as `.secrets/`, and do
not patch installed files under `node_modules`. If an environment variable was
created or changed after the managed App Server started, restart or relaunch
that App Server before `mcp refresh`; `.codex/config.toml` stores only variable
names, not values. Do not validate by launching stdio MCP entrypoints in a
visible terminal; stdio servers stay alive waiting for a client and can leave
orphan `node`/`cmd` windows. Use App Server refresh plus a real callable tool
call as proof.

## Development

```powershell
npm install
npm run check
npm test
npm run smoke
npm run build
npm run security:smoke
npm run security:scan
npm run audit:prod
npm run remote -- --dry-run --no-resume
node --import tsx src/cli.ts init --dry-run --workspace . --no-agents
npm run pack:validate
```

`pack:validate` runs package smoke and npm pack dry-run sequentially. The pack
scripts rebuild `dist/`, so do not run them in parallel.

Start the MCP server:

```powershell
npm run serve
```

Start a Codex remote session from this repo's own launcher:

```powershell
npm run remote -- --dry-run --no-resume
npm run remote
npm run remote -- --resume <thread-id>
```

The `remote` command reads and writes only
`.codex-agent-session-manager/state/app-server.json`; it intentionally ignores
legacy hot-reloader launcher state so Windows popup tests can compare the new
flow against the old launcher.

In projects initialized with this package, use the generated script name:
`npm run codex:remote -- --resume <thread-id>`. `--resume <thread-id>` is an
alias for `--session-id <thread-id>` and launches Codex as
`codex resume <thread-id> --remote ...`. The visible Codex TUI passes
`--dangerously-bypass-approvals-and-sandbox` by default for trusted local
development; add `--no-bypass-sandbox` to omit it.

On Windows, `remote` starts the managed App Server through a generated
`.codex-agent-session-manager/windows-hidden-stdio-launcher.exe` when the Codex
binary resolves to `codex.exe`. The visible Codex TUI still launches normally;
only the background App Server process is wrapped. This does not edit the
user's global `~/.codex/config.toml`.

The same hidden launcher is also used by `init` for the project-scoped
`codex_agent_session_manager` MCP server on Windows. This is separate from the
remote/App Server lifecycle path: it lets third-party launchers that simply run
`codex` in the project still get the session-manager tools without an extra
visible stdio helper window.

Agents can start or reuse the same managed App Server path through
`codex_app_server_start`. The tool records a durable operation and leaves TUI
launching to `codex_session_launch`, keeping App Server lifecycle and visible
session launch as separate operations. Agents can inspect the managed process
with `codex_app_server_status` and stop only the workspace-owned App Server
tree with `codex_app_server_stop`; neither operation rewrites user global MCP
configuration. If managed state says an App Server is ready but the process is
gone, `codex_app_server_status` reconciles the stale state to stopped and marks
stuck managed stop operations completed with reconciliation evidence.

`codex_session_close` targets Codex remote TUI processes. It does not own
operator-created terminal wrappers such as a manual `powershell -NoExit`
launcher used during experiments; close those windows separately after the
managed remote/App Server cleanup is complete.

## Documentation

- `docs/architecture.md`: target architecture.
- `docs/project-plan.md`: phase plan.
- `docs/validation-plan.md`: initial validation matrix.
- `docs/handoff-template.md`: handoff for starting a fresh Codex session.
- `docs/mcp-typescript-architecture-research.md`: stack research.
- `docs/research/hot-reloader-origin-notes.md`: lessons from the experimental
  repo.
