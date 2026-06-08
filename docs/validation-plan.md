# Validation Plan

Status: alpha.4 OAuth/env and stdio direct-launch hardening implemented

## Scaffold Checks

```powershell
npm run check
npm test
npm run smoke
npm run build
npm run security:smoke
npm run security:scan
npm run audit:prod
npm run remote -- --dry-run --no-resume
node --import tsx src/cli.ts init --dry-run --workspace . --no-agents
node --import tsx src/cli.ts deinit --workspace .
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts mcp --help
node --import tsx src/cli.ts mcp add npm @modelcontextprotocol/server-everything --dry-run
node --import tsx src/cli.ts mcp add npm tavily-mcp@latest --server-name tavily_search --env-var TAVILY_API_KEY --no-default-stdio-arg --dry-run
node --import tsx src/cli.ts app-server start --dry-run --port 4566
node --import tsx src/cli.ts session launch --dry-run --url ws://127.0.0.1:4566 --thread-id <thread-id>
npm run pack:validate
```

Do not run `pack:dry-run` and `pack:smoke` concurrently. Both rebuild `dist/`;
`pack:validate` keeps that package validation path sequential.

The smoke must prove:

- MCP initialize succeeds.
- `tools/list` includes:
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
  - `codex_session_launch`
  - `codex_session_manager_probe`
  - `codex_session_replace`
  - `codex_thread_context`
  - `codex_threads_list`
- `tools/call` can call `codex_session_manager_probe`.
- `resources/list` includes `codex-session-manager://operations`.
- CLI help lists the public App Server, MCP refresh, and session commands.
- CLI `mcp --help` reaches the public CLI path, not the stdio server alias.
- CLI public subcommands reject ignored cross-command flags and extra
  positionals before scheduling any guarded operation.
- CLI `mcp add npm` dry-run emits a project-scoped install/config plan without
  writing files and shows `--ignore-scripts` by default.
- CLI/MCP `mcp add npm` supports secret-bearing MCPs through `env_vars` /
  `--env-var` without storing secret values in `.codex/config.toml`.
- CLI/MCP `mcp add npm` reports that `env_vars` stores names only, and that
  values created after App Server launch require App Server restart/relaunch
  or a reviewed wrapper before refresh.
- Generated `AGENTS.md` instructs agents to prefer read-only OAuth scopes
  first, require explicit operator approval for write/delete scopes, avoid
  patching `node_modules`, avoid visible direct-launch validation of stdio MCP
  entrypoints, and continue through refresh/replacement until a real callable
  MCP tool call proves the change.
- CLI/MCP `mcp add npm` can omit the default positional `"stdio"` argument for
  packages that default to stdio.
- Real CLI/MCP `mcp add npm` execution requires `--confirm` or
  `dryRun:false, confirm:true`.
- Real CLI/MCP `mcp add npm` execution suppresses npm lifecycle scripts unless
  `--allow-scripts` / `allowScripts:true` is explicitly selected.
- Real CLI/MCP `mcp add npm` execution reports installed package lifecycle
  scripts and warns when they were suppressed.
- CLI App Server start dry-run emits JSON with `dryRun:true` and the requested
  loopback URL.
- CLI init dry-run emits human-readable output for a temporary workspace
  without writing files; `--json` keeps machine-readable output.
- CLI deinit dry-run emits human-readable output for a temporary workspace
  without writing files, reports packages selected for uninstall/removal, and
  warns that active App Server/TUI/MCP processes require stop or reload
  separately.
- CLI deinit can remove a scratch npm project through explicit
  `--remove-added-mcps --remove-empty-npm-project --remove-empty-codex-dir`
  when the only package metadata left belongs to the session manager and
  managed npm MCP installs.
- CLI prompt files are accepted only from the current workspace, reject
  symlink/junction escapes, and enforce prompt size limits before scheduling
  refresh/launch/replace work.

## App Server And Session Checks

Current checks:

- reject non-loopback App Server URLs;
- reject URL credentials, path, query, and fragment;
- initialize App Server connection before any other request;
- list loaded threads;
- list stored threads scoped by cwd;
- reject tool-provided cwd values that escape the current workspace lexically
  or through symlink/junction ancestors;
- read primary and legacy App Server launcher state without leaking raw
  workspace paths;
- report App Server URL resolution source with environment taking precedence
  over primary state and primary state taking precedence over legacy state;
- read MCP server status for a target thread.
- recommend a target thread by marker/cwd/status evidence;
- read and wait for operation records.
- persist operation records under local workspace runtime state;
- observe operation completion written by another store/process instance.
- schedule MCP reload through durable operation state and detached child process;
- record diagnostic MCP status before/after reload when a thread id is supplied.
- compose MCP reload plus continuation through `codex_mcp_refresh`, preserving
  before/after MCP status, idle/stable wait evidence, and `turn/start`
  evidence in one operation.
- schedule a continuation through durable operation state and a detached child
  process;
- pass continuation prompt text outside argv, structured output, operation
  evidence, and failure evidence;
- wait for idle/stable thread boundary before `turn/start`.
- prove `codex_session_continue` by a real model-callable invocation, then
  confirm the child turn started and replied from the scheduled continuation.
- report matching remote TUI process roots for explicit-thread cleanup in
  `dryRun` mode;
- support an explicit workspace+URL fallback for fresh remotes that do not
  expose thread id in argv, while avoiding wrapper roots that also own App
  Server child processes;
- refuse real remote TUI cleanup unless `dryRun:false` and `confirm:true`;
- exclude App Server processes from remote TUI cleanup targets.
- preview Codex remote TUI launch without prompt text in `dryRun` mode;
- refuse real remote TUI launch unless `dryRun:false` and `confirm:true`;
- keep App Server lifecycle start/status/stop separate from
  `codex_session_launch`.
- preview explicit-thread remote TUI replacement without prompt text in
  `dryRun` mode;
- refuse real remote TUI replacement unless `dryRun:false` and `confirm:true`;
- compose replacement from explicit-thread close plus same-thread launch while
  keeping App Server lifecycle start separate.
- run a security smoke proving scan patterns fail on representative leaks
  without printing raw sensitive fixtures;
- scan tracked files for personal paths, workspace paths, UUID-style thread/app
  ids, common credentials, and unsafe App Server URL shapes;
- run production dependency audit.
- dry-run the repo-local remote launcher and confirm it uses primary
  `.codex-agent-session-manager` state, not legacy hot-reloader state.
- dry-run `codex_app_server_start`, confirm real execution requires
  `confirm:true`, and verify the real operation runs the no-resume App Server
  plan without launching a TUI.
- call `codex_app_server_status` without destructive side effects and verify it
  reports only primary workspace-managed App Server state/process evidence.
- dry-run `codex_app_server_stop`, confirm real execution requires
  `dryRun:false` and `confirm:true`, and verify the real operation only targets
  the owned workspace App Server process tree.
- verify App Server stop marks primary launcher state as `stopped`/`owned:false`
  and does not close remote TUI windows or alter user global MCP config.
- expose public CLI commands for App Server lifecycle, MCP refresh, and session
  launch/close/replace over the same guarded operation builders used by MCP.
- expose an agent-facing npm MCP installer that writes project-scoped
  `.codex/config.toml` blocks without editing user global Codex config and
  without running npm lifecycle scripts by default.
- validate an env/auth npm MCP install with Tavily or another low-risk service:
  set the required API key only in the remote-launch environment, install with
  `--env-var`, refresh MCP, call one read-only tool, then deinit/uninstall and
  revoke or rotate the test key.
- validate a high-risk OAuth MCP flow such as Google Drive with a safe account:
  start from read-only when possible, only move to read/write after explicit
  operator instruction, keep token/client files outside the workspace or under
  ignored paths, avoid editing `node_modules`, refresh/relaunch as needed, and
  prove the final tool through the model-callable catalog. Confirm no stale
  visible stdio MCP server windows remain from direct diagnostic launches.
- Windows `session launch` proof must assert App Server loaded-thread state,
  not only process-spawn success. For `mode=session`, verify the requested
  `threadId` appears in `thread/loaded/list`; for `mode=fresh` with a prompt,
  verify a new loaded thread appears relative to the pre-launch baseline.
  Alpha.3 replay evidence used a disposable loopback App Server, recorded
  `windows-cmd-shim-terminal`, and completed with
  `launchVerification.ok:true`.
- keep public CLI operation output JSON by default and preserve
  dry-run/confirm semantics for process-launching or destructive operations.
- keep `init` human-readable by default with `--json` for automation.
- initialize target projects through project-scoped `.codex/config.toml`, local
  runtime ignore rules, optional `AGENTS.md`, and package scripts when
  `package.json` already exists.
- keep init idempotent and avoid editing user global Codex config.
- deinitialize project-scoped scaffold with dry-run-by-default semantics,
  `--confirm` for real edits, and `--remove-runtime` before deleting local
  runtime state.
- remove empty scratch npm project remnants only through explicit
  `--remove-empty-npm-project`, treating the session manager and managed npm
  MCP packages as removable only when their managed config blocks are also
  removed, refusing when unmanaged dependencies or custom scripts remain, and
  remove `.codex/` when it is empty or will become empty through planned
  managed file deletions.
- keep managed npm MCP blocks created by `mcp add npm` unless
  `--remove-added-mcps` is explicitly passed.
- keep direct MCP SDK calls classified as diagnostic only; final proof remains
  a model-callable MCP tool call from the continuation/replacement boundary.
- package only the intended npm artifact files: `dist/`, `scripts/*.cs`,
  `README.md`, `LICENSE`, and package metadata.
- reject package inclusion of source, tests, docs, `.codex*` runtime config,
  and `.exe` runtime binaries.
- install the generated `.tgz` in a temporary target project, run installed
  `dist/cli.js`, run project `init`, validate generated files/scripts, and run
  installed `npm run codex:remote:dry-run`.

## Windows Popup Probe

The operator should run this in a normal PowerShell window:

```powershell
cd <workspace>
npm run remote
```

Then run `/mcp` in the opened Codex session.

Record separately:

- whether `npm run remote` itself opens extra cmd/conhost windows;
- whether `/mcp` opens extra cmd/conhost windows;
- whether `.codex/config.toml` is using the hidden stdio launcher or direct
  `node` for the MCP server.

If the probe uses an external wrapper such as `powershell -NoExit` to keep a
test window open, close that wrapper manually after managed cleanup. Session
cleanup targets Codex remote TUI processes, not arbitrary operator terminal
wrappers.

## Callable Catalog Proof Matrix

The core proof modes are:

- `Pass - continuation`: a scheduled continuation turn calls the changed tool.
- `Pass - replacement/fresh remote`: a replacement or fresh remote session
  calls the changed tool.
- `Pass - fresh exec`: an explicitly labeled fresh `codex exec` process calls
  the changed tool.
- `Diagnostic`: status or same-turn evidence that is useful but not sufficient.

Status output alone is never final proof for handler, schema, new-tool,
removed-tool, or renamed-server cases.

## Origin Findings To Preserve

- `config/mcpServer/reload` refreshes MCP server processes/status but does not
  by itself prove the current model-callable tool bridge changed.
- Continuation after the target thread is idle is the preferred proof for
  handler/schema/new-tool changes.
- Replacement/fresh remote remains fallback for stubborn callable bridge
  staleness, especially new-tool and rename cases.
- Stale remote TUI cleanup is session hygiene, not callable proof.
