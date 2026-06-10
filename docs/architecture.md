# Architecture

Status: Phase 10 package/install hardening
Date: 2026-06-07

## Thesis

`codex-agent-session-manager` is an agent-facing wrapper around selected Codex
App Server and MCP lifecycle operations.

Most App Server wrappers are human-facing clients, external task gateways, or
language SDKs. This project is different:

```text
Codex agent -> MCP tool -> session manager -> Codex App Server / MCP config
```

The agent should not need to write one-off JSON-RPC scripts every time it needs
to find a thread, reload MCP servers, schedule a continuation, close stale
remote sessions, install or remove third-party MCPs, handle credential env vars,
or prove that a new MCP callable tool is really available.

## Layers

1. MCP surface
   - Exposes a small set of agent-callable tools.
   - Exposes resources for operation state, logs, thread evidence, and
     validation results.

2. Operation model
   - Every mutating or long-running action gets an operation id.
   - Operations expose status, timestamps, evidence, and next actions.
   - Operation state is persisted under
     `.codex-agent-session-manager/state/operations.json` so detached child
     processes can update evidence that the active MCP server can later read.
   - Read-only tools can return direct results without creating operations.

3. App Server adapter
   - Handles initialize/initialized.
   - Wraps selected methods such as `thread/list`, `thread/loaded/list`,
     `thread/read`, `turn/start`, `config/mcpServer/reload`, and
     `mcpServerStatus/list`.
   - Does not expose arbitrary JSON-RPC to the model.

4. Session/process manager
   - Starts managed App Server/remote sessions when needed.
   - Finds loaded and persisted threads by cwd, marker, status, and recency.
   - Closes stale owned remote TUI processes without stopping unrelated App
     Server instances.

5. Validation harness
   - Records proof mode: continuation, replacement/fresh remote, or fresh exec.
   - Treats status as diagnostic evidence only.
   - Requires an actual model-callable tool invocation for MCP catalog proof.

## Bootstrap Control Model

The project is intentionally not self-hosted yet.

During early development, there are two roles:

- Controller session: an external Codex session using the old
  `codex-mcp-hot-reloader` harness. It schedules reloads/continuations, reviews
  worker output, controls commits/pushes, and prevents stale architecture from
  being copied blindly.
- Dogfood worker session: a Codex session running inside this repo. It uses the
  repo-local MCP when available and proves whether the tool surface is usable by
  an agent in a real turn.

The dogfood worker should receive narrow checkpoints, not broad ownership, until
the project implements its own thread-context, operation, reload, and
continuation tools.

The project can become its own primary control plane only after Phase 4
minimum:

- identify the intended loaded/persisted thread;
- record operation state and next actions;
- reload MCP config through App Server;
- schedule a continuation turn after idle/stable boundary;
- prove changed callable tools from the fresh turn.

Current bootstrap compatibility:

- App Server URL resolution prefers explicit tool input, then
  `CODEX_APP_SERVER_URL`, then workspace launcher state.
- Workspace state prefers `.codex-agent-session-manager/state/app-server.json`
  and accepts `.codex-mcp-hot-reloader/state/app-server.json` only as a
  temporary compatibility path while the old repo still controls early
  dogfood sessions.
- Workspace launcher state stores the creating runtime identity. Automatic
  state reuse refuses legacy state without runtime identity and refuses
  incompatible runtime/path flavors, such as Windows native shells trying to
  reuse a WSL App Server URL. Explicit `appServerUrl`/`--url` and
  `CODEX_APP_SERVER_URL` remain operator overrides.
- Tool inputs that accept a `cwd` resolve it under the current workspace and
  reject lexical escapes, symlink escapes, and junction escapes. This keeps
  thread discovery scoped to the workspace that loaded the MCP server.

## Initial MCP Surface

The current MCP surface exposes:

- `codex_app_server_start`
- `codex_app_server_state_read`
- `codex_app_server_status`
- `codex_app_server_stop`
- `codex_global_mcp_add_npm`
- `codex_global_mcp_remove`
- `codex_local_mcp_add_npm`
- `codex_local_mcp_remove`
- `codex_mcp_cleanup_report`
- `codex_mcp_install_npm`
- `codex_mcp_package_inspect`
- `codex_mcp_refresh`
- `codex_mcp_reload`
- `codex_mcp_status_list`
- `codex_operation_read`
- `codex_operation_wait`
- `codex_secret_status`
- `codex_session_close`
- `codex_session_continue`
- `codex_session_hard_relaunch`
- `codex_session_launch`
- `codex_session_manager_help`
- `codex_session_manager_probe`
- `codex_session_replace`
- `codex_thread_context`
- `codex_threads_list`
- `codex-session-manager://guide`
- `codex-session-manager://workflows`
- `codex-session-manager://workflows/mcp-handling`
- `codex-session-manager://secrets`
- `codex-session-manager://safety`
- `codex-session-manager://global-install`
- `codex-session-manager://operations`

## Callable Refresh Evidence

Phase 3 proved an important boundary:

- App Server status can list a newly registered tool while the current TUI turn
  still cannot call it.
- An additional same-thread continuation after reload can still remain stale.
- A replacement/fresh remote TUI for the same thread saw
  `codex_thread_context`, `codex_operation_read`, and `codex_operation_wait`
  and called them successfully.

This reinforces the validation rule: `mcpServerStatus/list` is diagnostic, and
final MCP proof requires an actual model-callable invocation at the correct
turn/session boundary.

Phase 4 reload proof added the first mutating operation:

- `codex_mcp_reload` schedules `config/mcpServer/reload` in a detached child
  process.
- The parent tool returns a durable operation id before reload can restart MCP
  server processes.
- The child records `background`, `statusBefore`, `reload`, and `statusAfter`
  evidence in the operation store.
- Replacement/fresh remote proof called `codex_mcp_reload`, then
  `codex_operation_wait`/`codex_operation_read`, and observed a completed
  operation with before/after status evidence.

Phase 4 continuation adds the second mutating operation:

- `codex_session_continue` creates a durable `session_continue` operation and
  schedules a detached child process.
- The prompt is passed to the child through environment, not argv, and prompt
  text is not returned in structured output or operation evidence.
- The child waits for the explicit target thread to reach an idle/stable
  boundary, then calls `turn/start`.
- If the target is the current thread, the scheduling turn must end before any
  wait/read follow-up. Waiting inside the same active turn keeps the target
  thread active and can make the background child time out before it can call
  `turn/start`.
- Final proof still requires the started continuation turn to call the intended
  model-callable tool.
- The first callable proof called `codex_session_continue` from a fresh proof
  turn, observed a completed durable operation with `ready` and `turnStart`
  evidence, and observed the child turn respond with the requested marker.

Phase 4 composition adds the default refresh workflow:

- `codex_mcp_refresh` creates one durable `mcp_refresh` operation that reloads
  MCP servers, records before/after MCP status for the target thread, waits for
  the target thread idle/stable boundary, and starts a continuation turn.
- Refresh prompt text uses environment transport, never argv or operation
  evidence.
- The operation is proof scheduling, not final proof. A completed operation
  means App Server accepted `turn/start`, not that the child turn finished.
  Final proof still requires the started continuation turn to call the changed
  model-callable tool.

Phase 10 package bootstrap adds agent-facing npm MCP handlers:

- `codex_local_mcp_add_npm` defaults to `dryRun: true`; real install/config writes
  require `dryRun: false` and `confirm: true`.
- With confirmation, it installs an npm MCP package into the current project
  and writes a marked project-scoped `.codex/config.toml` block.
- npm install runs with `--ignore-scripts --no-audit --no-fund --cache
  ./.npm-cache` by default. `allowScripts: true` or CLI `--allow-scripts` is
  an explicit opt-in for packages that require lifecycle scripts.
- After a real install, the tool inspects the installed package metadata and
  reports declared lifecycle scripts plus whether they were suppressed by the
  default safe install mode.
- The generated server command uses `node` plus the installed package
  entrypoint instead of npm command shims.
- Existing unmanaged `[mcp_servers.<name>]` sections are not overwritten.
- This is setup only. Final callable proof still requires `codex_mcp_refresh`
  followed by a real tool call from the continuation turn; direct MCP SDK calls
  are diagnostic only.
- `codex_local_mcp_remove` and CLI `mcp local remove` remove only marked project-scoped
  blocks created by `codex_local_mcp_add_npm` / `mcp local add npm`. They default to
  dry-run, refuse to touch unmanaged MCP sections, and uninstall the inferred
  npm package only with explicit opt-in and only when no other managed block
  still references the package.
- `codex_global_mcp_add_npm` installs a third-party npm MCP into an isolated
  user-global runtime under the session-manager global state directory and
  writes a marked user-global `~/.codex/config.toml` block.
- `codex_global_mcp_remove` removes only marked user-global blocks created by
  `codex_global_mcp_add_npm` and removes the isolated runtime only with
  `uninstallPackage:true`.
- Real local/global MCP add/remove executions create durable operation records
  under the requesting workspace. `codex_mcp_cleanup_report` summarizes managed
  local/global MCP blocks, package/runtime presence, orphaned managed global
  runtime directories, and recent MCP add/remove operations without exposing raw
  config or env values.
- Global third-party MCP handling is intentionally separate from
  `global install`, which manages only this package's own global MCP block and
  shell hook.
- Secret handling is intentionally separate from MCP config. `secret set`
  stores values in user-local or workspace-local restricted runtime JSON, MCP
  config stores only `env_vars` names, `remote` injects stored values into the
  managed App Server environment, and `codex_secret_status` exposes only
  availability/source metadata to agents.
- Third-party npm MCP installs have a high-level install entrypoint plus an
  inspection gate. `codex_mcp_install_npm` / CLI `mcp install npm` defaults to
  project-local scope and uses `scope:"global"` / `--scope global` only when
  the operator explicitly wants a user-global MCP. `codex_mcp_package_inspect`
  and CLI `mcp inspect npm` read npm metadata/README and generically extract
  likely credential env var names. Install/add tools reuse that evidence when
  `envVars` is empty and refuse real install if candidates were found, unless
  the operator explicitly opts out with `allowNoEnvVars` /
  `--allow-no-env-vars`. This prevents agents from validating keyless or
  fallback behavior as if a secret-bearing MCP were configured.
- The MCP server `instructions` field starts with the npm MCP install workflow.
  Codex reads server instructions during MCP initialization, so the first
  instructions must make `codex_mcp_install_npm` the visible path before shell,
  raw `npm`, raw `codex mcp add`, or manual config edits.

Phase 10 also adds project teardown:

- `codex-agent-session-manager deinit` defaults to dry-run and requires
  `--confirm` to apply changes.
- It removes recognized project-scoped scaffold only: the base
  `codex_agent_session_manager` `.codex/config.toml` block, generated npm
  scripts, and `.codex-agent-session-manager/` plus `.npm-cache/` gitignore
  rules.
- Runtime state deletion is opt-in through `--remove-runtime`, guarded by a
  workspace containment check before recursive deletion.
- Managed npm MCP blocks created by `mcp local add npm` are kept by default and can
  be removed with `--remove-added-mcps`.
- `deinit` does not run `npm uninstall` while the CLI is executing. Instead it
  returns `packagesToUninstall` so the operator can run npm uninstall after the
  scaffold is removed.
- `deinit` edits project files only. It does not stop a running App Server,
  remote TUI, or already-loaded MCP server processes, so active sessions should
  be stopped or reloaded before package uninstall when process teardown matters.
- Scratch workspace cleanup has explicit opt-ins:
  `--remove-empty-npm-project` deletes package metadata, lockfile, and
  `node_modules` only after generated scripts/dependencies are gone and no
  custom scripts remain; `--remove-empty-codex-dir` deletes `.codex/` only when
  it is empty.

Phase 5 starts with safe remote TUI cleanup:

- `codex_session_close` targets only Codex remote TUI processes for the current
  workspace, selected App Server URL, and explicit `threadId`.
- Fresh remote TUI processes may not expose a thread id in process argv. For
  those cases, `allowWorkspaceUrlFallback` / `--allow-workspace-url-fallback`
  is an explicit opt-in that falls back to workspace+URL matching only after
  thread matching finds nothing.
- The fallback avoids climbing to a launcher wrapper that also owns an App
  Server child process, preserving the App Server lifecycle boundary.
- It defaults to `dryRun: true`; real cleanup requires `dryRun: false` and
  `confirm: true`.
- It does not stop App Server or archive thread history.
- Its first callable proof ran in `dryRun` mode and returned
  `appServerWillBeStopped: false`.

Phase 5 launch is intentionally scoped:

- `codex_session_launch` builds or schedules a Codex remote TUI launch against
  an already-known loopback App Server URL.
- It does not start App Server; App Server lifecycle belongs to
  `codex_app_server_start`, `codex_app_server_status`, and
  `codex_app_server_stop`.
- It defaults to `dryRun: true`, requires `confirm: true` for real launch, and
  omits initial prompt text from previews and operation evidence.
- Its first callable proof ran in `dryRun` mode and confirmed
  `startsAppServer: false` with prompt text replaced by `<prompt>`.

Phase 5 replacement composes cleanup and launch:

- `codex_session_replace` targets matching remote TUI roots for the current
  workspace, selected loopback App Server URL, and explicit `threadId`, then
  relaunches that same thread against the same App Server.
- It defaults to `dryRun: true`; real replacement requires `dryRun: false` and
  `confirm: true`.
- Replacement prompt text is passed through environment in the detached child
  and appears only as `<prompt>` in previews/evidence.
- Its first callable proof ran in `dryRun` mode and returned `ok: true`,
  `confirmRequired: true`, `startsAppServer: false`, and close target counts
  without stopping or launching any process.

Phase 6 starts by hardening workspace scope:

- `resolveWorkspaceCwd` validates read-only thread discovery `cwd` inputs
  before they reach App Server `thread/list` or loaded-thread matching.
- Unit tests cover default cwd, nested cwd, missing final directories,
  lexical escapes, and symlink/junction escapes when supported by the platform.
- The first callable proof called `codex_thread_context` with `cwd: ".."` and
  observed the expected failure:
  `Workspace cwd must stay inside the current workspace.`

Phase 6 also adds read-only launcher state visibility:

- `codex_app_server_state_read` reports the current workspace App Server state
  sources without starting, stopping, or probing any process.
- Resolution evidence follows the same order used by session tools:
  environment, primary `.codex-agent-session-manager` state, then legacy
  `.codex-mcp-hot-reloader` state for bootstrap compatibility.
- Its first callable proof returned `resolved.source: legacy-state`,
  `resolved.url: ws://127.0.0.1:57798`, primary state absent, legacy state
  present, and workspace paths redacted as `<workspace>`.

Phase 6 promotes the first Windows App Server launcher hardening:

- `codex-agent-session-manager remote` starts the managed App Server through a
  generated `.codex-agent-session-manager/windows-hidden-stdio-launcher.exe`
  when running on Windows and the resolved Codex command is a native
  `codex.exe`.
- The visible Codex TUI still launches directly; only the background App Server
  process is wrapped.
- Remote TUI launch passes `--dangerously-bypass-approvals-and-sandbox` by
  default for trusted local development. `--no-bypass-sandbox` opts out.
- Specific session resume accepts either `--resume <thread-id>` or the more
  explicit `--session-id <thread-id>` and emits `codex resume <thread-id>`.
- This keeps the user's global MCP configuration untouched. The launcher is a
  session/workspace lifecycle concern, not a permanent rewrite of
  `~/.codex/config.toml`.
- A `--no-resume` operational test started `windows-hidden-stdio-launcher.exe`
  as the App Server root and observed `codex.exe app-server --listen ...` as
  its child.

Phase 7 starts App Server lifecycle management from MCP:

- `codex_app_server_start` builds the same no-resume managed App Server plan
  used by the CLI `remote` command.
- It defaults to `dryRun: true`; real execution requires `confirm: true`.
- Real execution creates an `app_server_start` operation and schedules a
  detached child, so the tool call returns before App Server startup can race
  with MCP process lifecycle.
- The child runs the no-resume remote plan, writes primary
  `.codex-agent-session-manager/state/app-server.json`, records launcher output
  as operation evidence, and does not launch a TUI.
- `codex_app_server_status` reads only primary workspace launcher state,
  reports process-tree liveness, and can probe `/readyz`.
- `codex_app_server_stop` stops only the primary workspace-owned App Server
  process tree. It defaults to `dryRun: true`, requires `dryRun: false` plus
  `confirm: true` for real execution, and schedules a detached child so the
  MCP tool call can return before the serving App Server is stopped.
- If a workspace reused an App Server that is not marked owned in local
  launcher state, stop can target an explicit loopback URL only with
  `appServerUrl` plus `force:true` and `confirm:true` (or CLI
  `app-server stop --url <ws-url> --force --confirm`). The operation revalidates
  that the PID still looks like `codex app-server --listen <url>` before
  stopping the process tree.
- Stop marks primary launcher state as `stopped` and `owned: false`; it does
  not close remote TUI windows, archive threads, or alter user global MCP
  configuration.
- `codex_session_launch` remains scoped to visible TUI launch against a known
  App Server URL/state. Keeping these operations separate avoids hiding process
  ownership changes inside a TUI-launch command.
- On Windows, visible detached TUI launch intentionally differs from hidden
  App Server launch. The App Server path uses the hidden native launcher to
  avoid popup windows; the detached TUI path uses `cmd.exe /c` with the npm
  `codex.cmd` shim so Codex receives a real terminal. Deterministic launches
  record App Server loaded-thread verification before completing.

Phase 8 exposes the same surface as an operator CLI:

- `app-server start|status|stop`, `mcp refresh`, and
  `session launch|close|replace` are public CLI commands over the same typed
  payload builders used by MCP tools.
- The CLI returns JSON by default and is intended for operator automation,
  shell use, and future preloaders.
- It does not add a raw App Server JSON-RPC proxy or a second lifecycle model.
- Destructive or process-launching commands still default to dry-run and
  require `--confirm` for real execution.
- Prompt-bearing commands support `--prompt-file`; prompt bodies remain
  operator text and should not be treated as structured evidence. Prompt files
  are resolved inside the current workspace, reject symlink/junction escapes,
  and are size/character bounded before they are read.

Phase 9 adds project bootstrap:

- `codex-agent-session-manager init` prepares a target workspace without
  touching user global Codex config.
- `init` prints a human-readable action list by default and keeps JSON
  available through `--json`.
- The project-scoped `.codex/config.toml` registers
  `codex_agent_session_manager` so a normal `codex` session launched from the
  project can call the session-manager tools; the managed `remote` command is
  optional rather than required for tool availability.
- Plain `codex` tool availability does not by itself provide a managed App
  Server URL or launcher state. Operations that schedule continuations or close
  managed sessions still need a managed `remote`/App Server path or an explicit
  loopback App Server URL. The exception is the explicitly experimental
  `codex_session_hard_relaunch` fallback, which manages the current visible
  Codex TUI process tree directly instead of using App Server `turn/start`.
- The generated MCP config points at the project-local
  `node_modules/codex-agent-session-manager/dist/cli.js` entrypoint. This
  avoids depending on a global npm binary when third-party launchers simply run
  `codex` in the project directory.
- The project-scoped config path is validated for CLI/terminal-launched Codex
  sessions. A Windows VS Code extension probe showed that the extension can
  spawn its internal `codex app-server` without the workspace as process cwd;
  in that host, `/mcp` may miss project-local MCP servers even though
  `codex.cmd mcp list` from the same folder sees them. Treat IDE-extension
  visibility as a separate host-compatibility probe.
- On Windows, the generated MCP config wraps the session-manager stdio server
  with `.codex-agent-session-manager/windows-hidden-stdio-launcher.exe`. For
  project-local installs the launcher runs `node node_modules/.../dist/cli.js
  serve`.
- Runtime state is kept under `.codex-agent-session-manager/`, npm cache is
  kept under `.npm-cache/`, and both are ignored by the target project's
  `.gitignore`.
- `package.json` is created when absent and updated when present. Scripts use
  the package binary directly so `npm run codex:init`, `npm run codex:remote`,
  and related commands supply local `node_modules/.bin` on PATH for both App
  Server and MCP startup.
- If the local package entrypoint is missing, `init` runs a project-local npm
  install with `--ignore-scripts --no-audit --no-fund --cache ./.npm-cache`.
- `init` does not create or update `AGENTS.md`. Agent-facing guidance lives in
  the MCP surface through `codex_session_manager_help` and read-only resources
  so it travels with the server instead of mutating the consumer project.
- `init --install-shell-hook` is the explicit exception to the project-scoped
  default: it installs or refreshes the marked `codex` function hook for
  PowerShell, bash, or zsh so plain `codex` launches can enter the managed
  remote path. Without that flag, `init` does not edit shell profiles.
- A VS Code extension visibility probe showed that alternate host integration
  can expose an MCP server in `/mcp`, but it still does not solve App Server
  session control and adds non-project-local state. It is not a supported
  project feature in this release. The project-scoped `.codex/config.toml` path
  plus terminal/managed remote sessions remains the minimum supported native
  integration.

Phase 11 adds an explicit user-global opt-in without changing the default:

- `codex-agent-session-manager global install --confirm` manages a marked
  block in the user's `~/.codex/config.toml` and a marked shell profile hook.
- `--mcp-only` limits the operation to the global MCP block;
  `--shell-hook-only` limits it to the global `codex` function hook.
- `global uninstall --confirm` removes only the marked global MCP block and/or
  marked shell hook block. Unmanaged `codex_agent_session_manager` config
  sections are reported as conflicts and are not rewritten.
- On Windows, the user-global MCP block uses
  `~/.codex-agent-session-manager/windows-hidden-stdio-launcher.exe` to avoid
  visible stdio helper consoles.
- The global MCP makes the guidance tool and session-manager tools available
  across projects. The global shell hook routes initialized projects through
  their generated local supervisor when present; otherwise it routes plain
  Codex-shaped launches through `codex-agent-session-manager remote --workspace
  <cwd>` and delegates native Codex subcommands to the real CLI.

Post-alpha replay hardening adds an opt-in plain-`codex` self-management
fallback:

- With the shell hook installed by `shell-hook install --confirm` or
  `init --install-shell-hook`, `codex` remains the operator-facing command, but
  initialized workspaces route it through
  `codex-agent-session-manager remote`. This preserves compatibility with
  external launchers that run `codex` in a project directory while still
  creating managed App Server state and a `--remote` TUI.
- The local supervisor supports Codex-shaped interactive launches such as
  `codex [flags] [prompt]` by passing native Codex argv through
  `codex-agent-session-manager remote -- ...`. The wrapper injects only the
  managed App Server URL and workspace defaults, so flags such as `--model`,
  `--search`, and `--dangerously-bypass-approvals-and-sandbox` keep Codex
  semantics.
- Native Codex subcommands and flags such as `codex mcp list`,
  `codex login`, `codex --version`, and `codex --help` are delegated to the
  real Codex CLI instead of being forwarded to `codex-agent-session-manager
  remote`.
- `codex_session_hard_relaunch` walks from the session-manager MCP server
  process to the visible Codex TUI ancestor, preferring the terminal wrapper
  that launched Codex and avoiding App Server-looking ancestors.
- With confirmation, detached mode schedules a child, passes the relaunch
  prompt through environment, relaunches plain Codex, resumes the selected
  thread by default, then attempts to stop the old TUI root process tree.
  `handoffMode: "shell-resume-next"` instead writes managed-remote state for
  the shell hook, which relaunches through `codex-agent-session-manager remote`
  in the same terminal using explicit manager-owned `--resume`/`--prompt`
  arguments. If no thread id is inferable, the tool refuses unless the caller
  explicitly selects `resumeMode: "fresh"`.
- The relaunched Codex process receives the prompt through the Codex CLI
  argument surface. This is acceptable only for non-secret operator text and is
  why the tool remains a hard fallback rather than the default refresh path.
- A disposable Windows probe initialized an empty workspace, launched plain
  `codex` without `remote`, had the first agent call the hard relaunch tool,
  and verified that the relaunched agent created `hard-relaunch-proof.txt` with
  exact content `hard-relaunch-ok`.

Phase 10 hardens packaging:

- The npm artifact is intentionally small: `dist/`, `scripts/*.cs`,
  `README.md`, `LICENSE`, and npm's required package metadata.
- Source, test, docs, project `.codex*` runtime state, and `.exe` runtime
  binaries are excluded from the package.
- The package smoke installs the generated `.tgz` into a temporary project and
  validates installed `dist/cli.js`, project `init`, generated scripts,
  project-scoped MCP config, and `codex:remote:dry-run`.
- Automated smoke stops at remote dry-run. Opening a real Codex TUI remains a
  manual probe because it is operator-visible process/session behavior.

## Boundaries

This project is not:

- a general App Server SDK;
- a generic "call any JSON-RPC method" proxy;
- a human session browser;
- a broad subagent worker with auto-approval defaults.

The project may later grow a preloader UI or CLI, but the core artifact is the
MCP wrapper that lets a Codex agent manage the Codex session/control-plane
problem from inside its own workflow.
