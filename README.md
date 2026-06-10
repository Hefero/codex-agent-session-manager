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
prepares the local session-manager runtime. It does not edit `AGENTS.md`, the
user's global Codex config, or shell profiles unless the matching opt-in flag is
explicitly passed.

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
Generated MCP server blocks set `cwd = "."` so hosts can resolve
project-relative runtime and `node_modules` paths from the initialized
workspace.

Current VS Code note: the Codex CLI and a terminal-launched `codex` session load
the project-scoped `.codex/config.toml` from the current directory. The Codex VS
Code extension may start its own internal App Server outside the workspace on
Windows native sessions, so `/mcp` inside the extension can miss project-local
MCP servers even when `codex.cmd mcp list` from the same folder shows them.
Use terminal-launched Codex or the managed remote flow for supported callable
catalog validation.

Agents should call `codex_session_manager_help` for operational guidance. MCP
clients that support resources can also read `codex-session-manager://guide`,
`codex-session-manager://workflows`,
`codex-session-manager://workflows/mcp-handling`,
`codex-session-manager://safety`, and
`codex-session-manager://global-install`.

After upgrading this package in an existing project, rerun
`npx codex-agent-session-manager init` to refresh `.gitignore`, package
scripts, and the MCP config block. If the binary is installed globally or linked
on PATH, `codex-agent-session-manager init` is equivalent. If the project
already has the generated npm scripts, `npm run codex:init` is also equivalent.
The init operation is idempotent and project-scoped.

For unpublished local package testing, pass the same package spec that should be
installed into the target project:

```powershell
codex-agent-session-manager init --package-spec ./codex-agent-session-manager-<version>.tgz
```

Published releases do not need this flag.

### Optional Global Install

`global install` is the stronger opt-in path. It edits the user's global Codex
config and shell profile only when explicitly confirmed:

```powershell
codex-agent-session-manager global install --dry-run
codex-agent-session-manager global install --confirm
```

By default it does both:

- installs `codex_agent_session_manager` in `~/.codex/config.toml`, so the MCP
  tools and `codex_session_manager_help` are available to normal Codex sessions
  across projects;
- installs the global `codex` shell function hook with managed-remote fallback,
  so plain `codex` launches in any directory can start or reuse a managed App
  Server. Initialized projects still use their generated local supervisor when
  present.

Use component flags when you want only one side:

```powershell
codex-agent-session-manager global install --mcp-only --confirm
codex-agent-session-manager global install --shell-hook-only --confirm
codex-agent-session-manager global uninstall --confirm
```

On Windows, the global MCP config uses a hidden stdio launcher under
`~/.codex-agent-session-manager/` to avoid helper console popups. The global
MCP command expects `codex-agent-session-manager` to be available on PATH,
for example through a global npm install or `npm link`.
The global shell hook also expects `codex-agent-session-manager` on PATH.
In WSL, add `--shell-hook-wsl-prefer-linux-path` when installing the global
hook if your PATH includes Windows npm shims under `/mnt/c` before Linux npm
binaries:

```bash
codex-agent-session-manager global install --shell-hook-wsl-prefer-linux-path --confirm
```

### Optional Shell Hook

`init --install-shell-hook` is intentionally not part of default init. Default
init stays inside the project directory. The shell hook is the explicit opt-in
path for users who want plain `codex` to enter the managed remote flow inside
initialized projects.

Without the shell hook:

- `codex` works normally.
- The project MCP server is available after init.
- Managed App Server launch/state helpers work best when the session was
  started with `npm run codex:remote`, `codex-agent-session-manager remote`, or
  an explicit App Server URL.

With the shell hook:

- outside initialized projects, `codex` delegates to the real Codex CLI;
- inside initialized projects, `codex` delegates to the generated project
  supervisor under `.codex-agent-session-manager/shell/`;
- the supervisor starts or reuses the workspace App Server and launches the
  visible Codex TUI through `codex-agent-session-manager remote`;
- native Codex subcommands and flags such as `codex mcp list`,
  `codex login`, `codex --version`, and `codex --help` still delegate to the
  real Codex CLI;
- interactive Codex-shaped launches are preserved through native argv
  passthrough:
  - `codex "<prompt>"` becomes managed remote as `remote -- "<prompt>"`;
  - `codex --model gpt-5 --search "<prompt>"` keeps the native Codex flags;
  - `codex --dangerously-bypass-approvals-and-sandbox "<prompt>"` keeps that
    explicit native bypass flag. The hook does not add it implicitly in
    passthrough mode.

Supported shells are PowerShell, bash, and zsh. Auto-detection uses PowerShell
on Windows, the current `$SHELL` when it is bash or zsh, zsh on macOS when the
shell is unknown, and bash elsewhere. Default profile targets are:

- PowerShell 7 when detected: `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`
- Windows PowerShell fallback: `~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`
- zsh: `~/.zshrc`
- bash on macOS: `~/.bash_profile`
- bash elsewhere: `~/.bashrc`

PowerShell 5 and PowerShell 7 use different profile files. Run the install
from each shell, or pass `--shell-hook-profile`, if you want both profiles to
receive the hook.

Preview first:

```powershell
codex-agent-session-manager init --install-shell-hook --dry-run
codex-agent-session-manager shell-hook install --dry-run
```

Install explicitly:

```powershell
codex-agent-session-manager init --install-shell-hook --shell-hook-shell powershell
codex-agent-session-manager init --install-shell-hook --shell-hook-shell bash
codex-agent-session-manager init --install-shell-hook --shell-hook-shell zsh
```

Or install the hook directly:

```powershell
codex-agent-session-manager shell-hook install --shell powershell --confirm
codex-agent-session-manager shell-hook install --shell bash --confirm
codex-agent-session-manager shell-hook install --shell zsh --confirm
```

Use `--shell-hook-profile <path>` with `init`, or `--profile <path>` with
`shell-hook`, to target a disposable profile during testing. Restart the shell
or source the edited profile before testing the `codex` function.

In WSL bash/zsh, `init --install-shell-hook --shell-hook-wsl-prefer-linux-path`
or `shell-hook install --wsl-prefer-linux-path` makes the hook prefer Linux npm
binary locations and refuse `/mnt/c` Windows shims for
`codex-agent-session-manager`. This avoids npm shim/path errors when Windows
PATH entries appear before the WSL npm install.

Remove the profile hook with:

```powershell
codex-agent-session-manager shell-hook uninstall --confirm
```

Remove from a project:

```powershell
codex-agent-session-manager app-server stop --dry-run
codex-agent-session-manager stop --confirm
codex-agent-session-manager stop --force --confirm
codex-agent-session-manager app-server stop --url ws://127.0.0.1:60998 --force --confirm
codex-agent-session-manager deinit --confirm --remove-runtime
npm uninstall -D codex-agent-session-manager
```

Remove the optional global install:

```powershell
codex-agent-session-manager global uninstall --dry-run
codex-agent-session-manager global uninstall --confirm
```

`deinit` defaults to dry-run unless `--confirm` is passed. It removes only the
project-scoped scaffold it can recognize: the managed `.codex/config.toml`
block, generated npm scripts, and local runtime and npm-cache ignore rules.
Runtime state under
`.codex-agent-session-manager/` is removed only with `--remove-runtime`. MCP
server blocks created through `mcp local add npm` are kept unless
`--remove-added-mcps` is passed; when removed, `deinit` reports the npm
packages selected for uninstall or scratch-project removal. It does not stop a
running Codex App Server, remote TUI, or already-loaded MCP server processes;
stop or reload active sessions before uninstalling packages when live
processes must exit.
Scratch test workspaces can also use `deinit --confirm
--remove-added-mcps --remove-empty-npm-project --remove-empty-codex-dir` to
remove an npm skeleton that contains only this package and npm MCP packages
created by `mcp local add npm`. This refuses to remove `package.json` when unmanaged
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
  - `codex_global_mcp_add_npm`
  - `codex_global_mcp_remove`
  - `codex_local_mcp_add_npm`
  - `codex_local_mcp_remove`
  - `codex_mcp_cleanup_report`
  - `codex_mcp_refresh`
  - `codex_mcp_reload`
  - `codex_mcp_status_list`
  - `codex_operation_read`
  - `codex_operation_wait`
  - `codex_session_close`
  - `codex_session_continue`
  - `codex_session_hard_relaunch`
  - `codex_session_launch`
  - `codex_session_manager_help`
  - `codex_session_manager_probe`
  - `codex_session_replace`
  - `codex_thread_context`
  - `codex_threads_list`
- Guidance resources: `codex-session-manager://guide`,
  `codex-session-manager://workflows`,
  `codex-session-manager://workflows/mcp-handling`,
  `codex-session-manager://safety`, and
  `codex-session-manager://global-install`.
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
codex-agent-session-manager init --install-shell-hook --dry-run
codex-agent-session-manager init --install-shell-hook --shell-hook-shell powershell
codex-agent-session-manager deinit --dry-run
codex-agent-session-manager deinit --confirm --remove-runtime
codex-agent-session-manager shell-hook install --dry-run
codex-agent-session-manager shell-hook install --confirm
codex-agent-session-manager shell-hook uninstall --dry-run
codex-agent-session-manager global install --dry-run
codex-agent-session-manager global install --confirm
codex-agent-session-manager global uninstall --dry-run

codex-agent-session-manager app-server start --dry-run --port auto
codex-agent-session-manager app-server start --dry-run --port auto -- --config 'model="gpt-5"' --enable js_repl
codex-agent-session-manager app-server status --no-probe-ready
codex-agent-session-manager app-server stop --dry-run
codex-agent-session-manager app-server stop --confirm
codex-agent-session-manager stop --confirm
codex-agent-session-manager stop --force --confirm
codex-agent-session-manager app-server stop --url ws://127.0.0.1:60998 --force --confirm

codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --dry-run
codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --server-name everything --confirm
codex-agent-session-manager mcp local add npm example-search-mcp@latest --server-name search_mcp --env-var SEARCH_API_KEY --no-default-stdio-arg --confirm
codex-agent-session-manager mcp local remove everything --dry-run
codex-agent-session-manager mcp local remove everything --uninstall-package --confirm
codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --dry-run
codex-agent-session-manager mcp global remove everything --dry-run
codex-agent-session-manager mcp report
codex-agent-session-manager mcp refresh --thread-id <thread-id>

codex-agent-session-manager operation read --operation-id <operation-id>
codex-agent-session-manager operation wait --operation-id <operation-id> --timeout-ms 30000

codex-agent-session-manager session launch --thread-id <thread-id> --dry-run
codex-agent-session-manager session close --thread-id <thread-id> --dry-run
codex-agent-session-manager session replace --thread-id <thread-id> --dry-run
```

PowerShell resolves npm binaries to the generated `.ps1` shim first, and that
shim consumes the `--` passthrough separator. For commands that pass native
arguments after `--`, call the `.cmd` shim explicitly:

```powershell
codex-agent-session-manager.cmd app-server start --dry-run --port auto -- --config 'model="gpt-5"' --enable js_repl
```

See [Optional Shell Hook](#optional-shell-hook) before installing the shell
hook. It is opt-in because it edits a shell profile and changes how the
`codex` command resolves inside initialized workspaces.

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

`mcp local add npm` defaults to dry-run. With `--confirm`, it installs an npm MCP
package locally and writes only the project-scoped `.codex/config.toml`. It
does not edit the user's global Codex config. The install uses
`--ignore-scripts --no-audit --no-fund --cache ./.npm-cache` by default; pass
`--allow-scripts` only when the selected package requires npm lifecycle scripts
during install. After a real install, the result reports lifecycle scripts
declared by the package and warns when they were suppressed. The install does
not count as callable proof; run `mcp refresh` and validate with a real tool
call from the continuation. Added npm MCP server blocks also set `cwd = "."`
for project-relative entrypoints.
Use repeated `--env-var <NAME>` for secret-bearing MCPs; this writes
`env_vars = ["NAME"]` and forwards the variable from the launch environment
without storing the secret value in TOML. Use `--no-default-stdio-arg` for npm
MCP packages whose entrypoint defaults to stdio and should not receive a
positional `"stdio"` argument.

`mcp local remove <server-name>` removes a project-scoped MCP block that was created
by `mcp local add npm`. It defaults to dry-run and refuses to touch unmanaged
`[mcp_servers.*]` sections. Pass `--uninstall-package --confirm` to also run
`npm uninstall -D` for the inferred npm package, but only when no other managed
MCP block still references that package. After removal, run `mcp refresh` and
validate that the removed namespace is absent from the callable catalog.
Use `mcp report` before or after cleanup when you need a read-only summary of
managed local/global MCP blocks, package/runtime presence, orphaned managed
global runtime directories, and recent add/remove operations.

`mcp global add npm` is the stronger third-party MCP path. It installs the npm
package into an isolated runtime under the session-manager global state
directory and writes a marked user-global `~/.codex/config.toml` MCP block.
It also defaults to dry-run, disables npm lifecycle scripts by default, stores
only env var names, and affects Codex sessions outside the current project
until removed. `mcp global remove <server-name>` removes only managed global
blocks created by this package. Pass `--uninstall-package --confirm` only when
the isolated global runtime directory should also be removed.

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
node --import tsx src/cli.ts init --dry-run --workspace .
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
configuration. When a workspace reused an App Server it does not own, the
explicit forced path is `app-server stop --url <loopback-ws-url> --force
--confirm`; it validates a running `codex app-server --listen <url>` process
before stopping it. If managed state says an App Server is ready but the process
is gone, `codex_app_server_status` reconciles the stale state to stopped and
marks stuck managed stop operations completed with reconciliation evidence.

`codex_session_close` targets Codex remote TUI processes. It does not own
operator-created terminal wrappers such as a manual `powershell -NoExit`
launcher used during experiments; close those windows separately after the
managed remote/App Server cleanup is complete.

## Documentation

- `docs/architecture.md`: target architecture.
- `docs/project-plan.md`: phase plan.
- `docs/release.md`: npm trusted-publishing setup and release workflow.
- `docs/validation-plan.md`: initial validation matrix.
- `docs/handoff-template.md`: handoff for starting a fresh Codex session.
- `docs/mcp-typescript-architecture-research.md`: stack research.
- `docs/research/hot-reloader-origin-notes.md`: lessons from the experimental
  repo.
