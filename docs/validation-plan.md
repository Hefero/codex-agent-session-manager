# Validation Plan

Status: next-alpha hardening validation plan

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
node --import tsx src/cli.ts init --dry-run --workspace .
node --import tsx src/cli.ts init --dry-run --workspace . --package-spec ./codex-agent-session-manager-<version>.tgz
node --import tsx src/cli.ts deinit --workspace .
node --import tsx src/cli.ts global install --dry-run
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts mcp --help
node --import tsx src/cli.ts mcp local add npm @modelcontextprotocol/server-everything --dry-run
node --import tsx src/cli.ts mcp local add npm example-search-mcp@latest --server-name search_mcp --env-var SEARCH_API_KEY --no-default-stdio-arg --dry-run
node --import tsx src/cli.ts mcp local remove everything --dry-run
node --import tsx src/cli.ts mcp global add npm @modelcontextprotocol/server-everything --dry-run
node --import tsx src/cli.ts mcp global remove everything --dry-run
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
- `tools/call` can call `codex_session_manager_probe`.
- `tools/call` can call `codex_session_manager_help` for at least the
  `mcp-handling` topic.
- `resources/list` includes `codex-session-manager://guide`,
  `codex-session-manager://workflows`,
  `codex-session-manager://workflows/mcp-handling`,
  `codex-session-manager://secrets`,
  `codex-session-manager://safety`,
  `codex-session-manager://global-install`, and
  `codex-session-manager://operations`.
- `resources/read` can read `codex-session-manager://guide`.
- CLI help lists the public App Server, MCP refresh, and session commands.
- CLI `mcp --help` reaches the public CLI path, not the stdio server alias.
- CLI public subcommands reject ignored cross-command flags and extra
  positionals before scheduling any guarded operation.
- CLI `mcp local add npm` dry-run emits a project-scoped install/config plan without
  writing files and shows `--ignore-scripts`, `--no-audit`, `--no-fund`, and
  workspace-local `--cache ./.npm-cache` by default.
- npm execution helpers must avoid direct `spawnSync('npm.cmd', ..., {
  shell:false })` on Windows. The preferred Windows path is `node.exe
  <node-prefix>/node_modules/npm/bin/npm-cli.js ...`, with `cmd.exe /d /c
  npm.cmd ...` only as fallback.
- CLI/MCP `mcp local add npm` supports secret-bearing MCPs through `env_vars` /
  `--env-var` without storing secret values in `.codex/config.toml`.
- CLI `secret set/list/status/unset` stores API keys/tokens by env var name
  without accepting values as command arguments or printing values in output.
- `codex_secret_status` reports only env var availability and source, never
  secret values.
- `codex_mcp_package_inspect` / CLI `mcp inspect npm` extracts candidate
  credential env var names from npm metadata/README without package-specific
  hardcoding.
- `codex_mcp_install_npm` / CLI `mcp install npm` is the preferred npm MCP
  install entrypoint, defaults to local scope, and requires explicit
  `scope:"global"` / `--scope global` for user-global MCP config.
- MCP server initialization instructions must front-load
  `codex_mcp_install_npm`, including the instruction to use it before raw
  shell/npm/Codex MCP commands. This guards against agents ignoring the managed
  install path after project `AGENTS.md` guidance was removed.
- CLI/MCP `mcp local add npm` reports that `env_vars` stores names only, and that
  values created after App Server launch require the agent to use
  session-manager refresh, continuation, replacement, or lifecycle tools before
  MCP validation. The agent must not ask the operator to restart Codex manually.
- CLI/MCP `mcp local add npm` and `mcp global add npm` report structured
  `envVarStatus`; if a configured env var is missing, agents must stop secret
  MCP validation, ask the operator to run `secret set`, and must not treat
  keyless/fallback tool behavior as proof.
- CLI/MCP `mcp local add npm` and `mcp global add npm` refuse real install when
  package inspection finds candidate credential env vars and `envVars` is
  empty, unless `allowNoEnvVars` / `--allow-no-env-vars` is explicitly selected.
- `codex_session_manager_help` and the guidance resources instruct agents to
  prefer read-only OAuth scopes first, require explicit operator approval for
  write/delete scopes, avoid patching `node_modules`, avoid visible
  direct-launch validation of stdio MCP entrypoints, and continue through
  refresh/replacement until a real callable MCP tool call proves the change.
- CLI/MCP `mcp local add npm` can omit the default positional `"stdio"` argument for
  packages that default to stdio.
- Real CLI/MCP `mcp local add npm` execution requires `--confirm` or
  `dryRun:false, confirm:true`.
- Real CLI/MCP `mcp local add npm` execution suppresses npm lifecycle scripts unless
  `--allow-scripts` / `allowScripts:true` is explicitly selected.
- Real CLI/MCP `mcp local add npm` execution reports installed package lifecycle
  scripts and warns when they were suppressed.
- CLI/MCP `mcp local remove` dry-run reports whether a managed project-scoped MCP
  block exists without writing files.
- CLI/MCP `mcp local remove` removes only marked blocks created by `mcp local add npm` and
  does not touch unmanaged MCP sections.
- CLI/MCP `mcp local remove --uninstall-package` runs `npm uninstall -D` only with
  explicit confirmation and skips uninstall when another managed MCP block still
  references the same npm package.
- CLI/MCP `mcp global add npm` installs into an isolated user-global runtime,
  writes only marked user-global config, defaults to dry-run, stores env var
  names only, and suppresses npm lifecycle scripts unless explicitly allowed.
- CLI/MCP `mcp global remove` removes only marked user-global blocks created by
  this package and removes the isolated runtime only with explicit package
  removal opt-in.
- CLI/MCP `mcp report` / `codex_mcp_cleanup_report` reports managed
  project-local and user-global MCP cleanup state, orphaned managed global
  runtime dirs, and recent add/remove operations without returning raw config
  content or env values.
- Real CLI/MCP local/global MCP add/remove executions create completed or
  failed durable operation records.
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
- persist App Server launcher runtime identity and refuse automatic reuse of
  legacy or incompatible runtime state, including Windows native shells versus
  WSL path flavor. Explicit `--url`/`appServerUrl` and `CODEX_APP_SERVER_URL`
  remain operator overrides.
- read MCP server status for a target thread.
- recommend a target thread by marker/cwd/status evidence;
- read and wait for operation records.
- persist operation records under local workspace runtime state;
- observe operation completion written by another store/process instance.
- schedule MCP reload through durable operation state and detached child process;
- record diagnostic MCP status before/after reload when a thread id is supplied.
- compose MCP reload plus continuation through `codex_mcp_refresh`, preserving
  before/after MCP status, idle/stable wait evidence, and `turn/start`
  evidence in one operation. Completion of this operation means `turn/start`
  was accepted, not that the child turn finished or proved the changed tool.
- schedule a continuation through durable operation state and a detached child
  process;
- pass continuation prompt text outside argv, structured output, operation
  evidence, and failure evidence;
- wait for idle/stable thread boundary before `turn/start`.
- when the target is the current thread, schedule continuation and let the
  active turn finish before waiting or reading the operation from a later turn;
  same-turn waits keep the target thread active.
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
- verify `codex_app_server_status` reconciles stale ready state to stopped when
  managed state points at a dead process, and completes any stuck managed
  `app_server_stop` operation with reconciliation evidence.
- verify `codex_app_server_status --no-process-tree` still reports
  `processAlive:true` when the recorded pid exists, and does not reconcile a
  process-list miss to stopped when `/readyz` succeeds.
- dry-run `codex_app_server_stop`, confirm real execution requires
  `dryRun:false` and `confirm:true`, and verify the real operation only targets
  the owned workspace App Server process tree.
- verify forced URL stop requires a loopback `appServerUrl`, `force:true`, and
  `confirm:true`, revalidates a `codex app-server --listen <url>` process, and
  reconciles matching reused local launcher state to stopped.
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
  runtime/cache ignore rules, generated package scripts, and project-local npm
  metadata. `init` must not create or update `AGENTS.md`; agent-facing guidance
  belongs in MCP tool descriptions, `codex_session_manager_help`, and read-only
  resources. Empty workspaces should get a minimal `package.json`, a
  devDependency on this package, and a local install using
  `--ignore-scripts --no-audit --no-fund --cache ./.npm-cache`.
- keep init idempotent and avoid editing user global Codex config.
- keep user-global integration behind explicit `global install --confirm`.
  Dry-run must show both the global MCP config action and shell-hook action,
  `--mcp-only` / `--shell-hook-only` must scope the operation, and unmanaged
  global `codex_agent_session_manager` sections must not be overwritten.
- keep shell profile edits out of default init. Validate
  `init --install-shell-hook` as the explicit opt-in path, including dry-run
  with no profile write and real install against a disposable profile path.
  Validate explicit PowerShell, bash, and zsh selection. In WSL, validate the
  opt-in PATH mitigation that prefers Linux npm binaries and refuses `/mnt/c`
  Windows shims for `codex-agent-session-manager`.
- keep non-project-local host integration edits out of init. VS Code extension
  visibility was probed and is not part of the supported scaffold contract for
  this release.
- deinitialize project-scoped scaffold with dry-run-by-default semantics,
  `--confirm` for real edits, and `--remove-runtime` before deleting local
  runtime state.
- remove empty scratch npm project remnants only through explicit
  `--remove-empty-npm-project`, treating the session manager and managed npm
  MCP packages as removable only when their managed config blocks are also
  removed, refusing when unmanaged dependencies or custom scripts remain, and
  remove `.codex/` when it is empty or will become empty through planned
  managed file deletions.
- keep managed npm MCP blocks created by `mcp local add npm` unless
  `--remove-added-mcps` is explicitly passed.
- keep direct MCP SDK calls classified as diagnostic only; final proof remains
  a model-callable MCP tool call from the continuation/replacement boundary.
- keep hard process reset classified as fallback evidence unless explicitly
  selected: process-level TUI close plus `codex resume <threadId> --remote
  <url> ... <prompt>` can inject a prompt without App Server `turn/start`, but
  it must prove the target by dry-run process identity first and must not stop
  the App Server.
- validate `codex_session_hard_relaunch` as the plain-`codex` fallback: the
  current TUI root is discovered from MCP process ancestry, the relaunch prompt
  is non-secret, the relaunched Codex process resumes the current thread by
  default, the new process is started before the old root is stopped, and proof
  comes from the relaunched session's observable work.
- validate the opt-in shell hook separately: install is dry-run-by-default,
  writes only a marked profile block with `--confirm`, uninstall removes only
  that block, and initialized workspaces route `codex` through the managed
  `remote` path rather than plain Codex. Validate PowerShell plus POSIX
  bash/zsh blocks. Validate that `codex [flags] [prompt]` preserves native
  Codex argv through managed `remote -- ...`, including representative flags
  such as `--model`, `--search`, and
  `--dangerously-bypass-approvals-and-sandbox`.
  `handoffMode: "shell-resume-next"` writes local managed-remote resume-next
  state instead of opening a new terminal directly, and the supervisor converts
  that internal state into manager-owned `remote --resume/--prompt` arguments.
  When
  `resumeMode: "current"` cannot infer a thread id, it must refuse; only
  `resumeMode: "fresh"` may intentionally open a new thread.
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

## Native Codex Init Probe

The native project path should not require `codex-agent-session-manager remote`.
After installing the package in a target project and running `init`, start a
fresh Codex session from that project with plain `codex`, or use an explicitly
labeled fresh `codex exec` proof when automation is enough:

```powershell
cd <workspace>
npm install -D codex-agent-session-manager
npx codex-agent-session-manager init
codex exec --skip-git-repo-check "Call codex_session_manager_probe with echo native-proof and report the marker."
```

Expected evidence:

- `.codex/config.toml` contains `codex_agent_session_manager`.
- When `package.json` exists, the MCP command path targets
  `node_modules/codex-agent-session-manager/dist/cli.js`.
- On Windows, the MCP server command is
  `.codex-agent-session-manager/windows-hidden-stdio-launcher.exe`.
- The fresh session calls
  `codex_agent_session_manager/codex_session_manager_probe` without running
  `remote`.
- Plain `codex` sessions can call project MCP tools, but self-management
  operations that require an App Server URL, managed launch state, or automatic
  continuation are only expected to work after a managed `remote`/App Server
  path is active or an explicit loopback App Server URL is configured.
- The proof above is for CLI/terminal-launched Codex. For the Codex VS Code
  extension, run a separate host probe: open the initialized folder, run `/mcp`
  in the extension, then compare with `codex.cmd mcp list` from the same
  folder. On Windows native extension builds, the extension may spawn its
  internal App Server outside the workspace and miss project-scoped MCP config.
  Treat that as a host-compatibility limitation rather than release proof
  failure for the terminal/managed remote path.
- `codex_session_hard_relaunch` is the explicit exception for process-level
  self-management from plain `codex`. A disposable Windows probe launched
  plain `codex`, had the first agent call the tool, and verified the relaunched
  session created `hard-relaunch-proof.txt` containing exactly
  `hard-relaunch-ok`.
- Same-terminal relaunch is a separate opt-in shell-hook probe. Install the
  hook, restart or source the profile, run plain `codex` from the initialized
  project, and ask the agent to call `codex_session_hard_relaunch` with
  `handoffMode: "shell-resume-next"`. PowerShell, bash, and zsh hook blocks are
  covered by unit tests; real macOS runtime validation remains host-dependent.
- With the shell hook installed, also validate that native Codex subcommands
  still bypass the managed remote wrapper, for example `codex mcp list` and
  `codex --version`.

VS Code extension integration remains an abandoned probe, not a supported
release path. The terminal and managed remote flows are the release proof paths.

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
