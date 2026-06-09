# Project Plan

Status: post-alpha real-replay hardening in progress

## Bootstrap Workflow

This project has a self-reference problem: the tool being built is the same
tool a future Codex agent will use to manage its own App Server session. Until
the project can discover its own thread, track operations, reload MCP servers,
and schedule a continuation turn, it cannot safely be its own primary control
plane.

Current workflow:

- The old `codex-mcp-hot-reloader` repo acts only as an external controller and
  validation harness.
- This repo stays isolated from the old implementation shape.
- A separate Codex remote session in this repo acts as a dogfood worker.
- The controller authorizes architecture, commits, pushes, reloads, and final
  callable proof.
- The worker executes narrow implementation checkpoints and proves whether the
  new MCP surface is usable by a real Codex agent.

Migration criterion:

The worker should not become the primary session until Phase 4 minimum is done:
MCP reload, continuation scheduling, and fresh-turn callable proof.

## Phase 1: Foundation

- TypeScript ESM scaffold.
- MCP stdio server with one callable proof tool.
- Resource placeholder for operation state.
- Raw JSON-RPC smoke test.
- Architecture, validation, handoff, and research docs.

Exit criteria:

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm run build`

Status: complete and pushed in `3d2984f Add TypeScript MCP scaffold`.

## Phase 2: App Server Adapter

- Implement a typed App Server client.
- Add loopback URL validation and redaction.
- Support initialize/initialized and basic request correlation.
- Add wrappers for:
  - `thread/loaded/list`
  - `thread/list`
  - `thread/read`
  - `mcpServerStatus/list`

Exit criteria:

- Unit tests for URL validation and request correlation.
- Smoke against an active loopback App Server.

Status: complete and pushed in `a45397d Add App Server read-only MCP tools`.

Additional proof:

- `codex_threads_list` and `codex_mcp_status_list` were registered as MCP
  tools.
- App Server status listed the new tools.
- A fresh continuation turn in the dogfood worker called both tools
  successfully.

## Phase 3: Thread Context And Operations

- Implement `codex_thread_context`.
- Add operation store and resources.
- Add `codex_operation_read` and `codex_operation_wait`.
- Preserve evidence for cwd, marker, status, loaded/stored source, and
  ambiguity.

Exit criteria:

- Same-cwd thread discovery works with multiple loaded threads.
- Marker match wins over active-but-stale candidates.

Status: complete and validated.

Implemented:

- `codex_thread_context` summarizes loaded thread evidence without returning
  raw thread payloads.
- Marker matches outrank active-only and cwd-only heuristics.
- Stored thread matches are low-confidence recovery hints.
- Recent operation records are also low-confidence recovery hints when loaded
  thread listing is empty or inconclusive.
- Operation records track id, kind, status, timestamps, evidence, failure, and
  next action.
- `codex_operation_read` reads operation state by id.
- `codex_operation_wait` waits for terminal operation state or reports missing
  and timeout conditions.
- App Server URL fallback now uses explicit input, `CODEX_APP_SERVER_URL`, or
  workspace launcher state. The state resolver prefers this repo's future
  `.codex-agent-session-manager` state and accepts the old
  `.codex-mcp-hot-reloader` state only for bootstrap compatibility.

Validation:

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm run build`
- `git diff --check` with only Windows LF/CRLF warnings
- App Server status listed `codex_thread_context`.
- Same-thread reload plus continuation still saw stale callable state twice.
- Replacement/fresh remote TUI then called `codex_thread_context` successfully
  with `recommendedThreadIdSource: loaded-marker-match`,
  `recommendationConfidence: high`, and `markerMatched: true`.
- App Server status listed `codex_operation_read` and `codex_operation_wait`.
- Same-thread reload plus continuation still saw stale callable state for the
  new operation tools.
- Replacement/fresh remote TUI then called both operation tools successfully on
  a missing operation id: each returned `ok: true` and `found: false`; wait also
  returned `timedOut: false`.

## Phase 4: Reload And Continuation

- Persist operation state so detached child processes can update operation
  evidence.
- Implement MCP reload.
- Implement continuation scheduling after idle/stable boundary.
- Record status-before/status-after as evidence.
- Require follow-up callable proof for pass.

Exit criteria:

- Handler/schema/new-tool fixture probes pass by continuation.
- Same-turn stale behavior is recorded as diagnostic, not pass.

Status: reload and continuation complete.

Implemented:

- Runtime operation state is file-backed at
  `.codex-agent-session-manager/state/operations.json`.
- `.codex-agent-session-manager/` is ignored as local runtime state.
- Operation reads and waits reload state from disk, so an active MCP server can
  observe updates written by another process.
- Writes use temp-file plus rename.
- `codex_mcp_reload` creates a durable `mcp_reload` operation and schedules a
  detached child process.
- The hidden internal CLI command runs the reload child without shell, with
  ignored stdio, detached process mode, and `windowsHide`.
- The child calls `config/mcpServer/reload` and records optional
  status-before/status-after evidence when a `threadId` is provided.
- `codex_session_continue` creates a durable `session_continue` operation and
  schedules a detached child process.
- The continuation child waits for an explicit target thread to reach the
  idle/stable boundary, then calls `turn/start`.
- If the explicit target is the current thread, the scheduling turn must end
  before waiting on the operation; otherwise the active turn itself prevents the
  background child from observing the idle boundary.
- Continuation prompts are passed through child environment and are not returned
  in operation evidence or argv.

Validation:

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm run build`
- `git diff --check` with only Windows LF/CRLF warnings
- Tests cover persistence across store instances, corrupt/missing state files,
  deep clone behavior, and wait observing completion from another store
  instance.
- A durable operation was written through `OperationStore`, App Server MCP was
  reloaded, same-thread continuation remained stale, and replacement/fresh TUI
  then read/waited that operation successfully:
  `read found true/status completed`, `wait found true/completed true/timedOut
  false`.
- Unit tests cover App Server reload request shape, reload operation scheduling,
  child runner completion with fake client/status, and operation argv parsing.
- App Server status listed `codex_mcp_reload`.
- Same-thread reload plus continuation still saw stale callable state for the
  new reload tool.
- Replacement/fresh remote TUI called `codex_mcp_reload`; the returned
  operation completed and retained `background`, `statusBefore`, and
  `statusAfter` evidence.
- Unit tests cover continuation operation scheduling, prompt redaction from
  payload/evidence, argv parsing without prompt text, idle wait, and
  `turn/start` through a fake client.
- App Server status listed `codex_session_continue`.
- A fresh proof turn called `codex_session_continue`; the returned operation
  scheduled a detached child with `argvIncludesPrompt: false`.
- The operation completed with `ready.ok: true` and `turnStart` evidence.
- The child continuation turn replied with the requested proof marker, and the
  operation JSON did not contain the prompt text.

Phase 4 composition:

- `codex_mcp_refresh` composes MCP reload plus continuation in one durable
  operation.
- The child records before/after MCP status evidence for the target thread,
  requests reload, waits for the target thread idle/stable boundary, and starts
  the continuation turn.
- Refresh prompt text is passed through environment and is excluded from argv,
  structured output, operation evidence, and failure evidence.
- Final proof still requires the started continuation turn to call the changed
  model-callable tool.

Validation:

- Unit tests cover durable scheduling, prompt redaction, operation argv without
  prompt text, status-before/reload/status-after ordering, idle wait, and
  `turn/start` through a fake client.
- Fresh-turn callable proof called `codex_mcp_refresh`; the resulting
  `mcp_refresh` operation completed with `statusBefore`, `statusAfter`,
  `ready`, and `turnStart` evidence. The continuation turn then called
  `codex_session_manager_probe` and replied `MCP_REFRESH_CHILD_PROOF_DONE`.

## Phase 5: Session Launch, Close, Replace

- Start managed remote sessions.
- Close stale owned remote sessions.
- Replace remote TUI sessions as fallback.
- Keep App Server ownership and remote TUI ownership separate.

Exit criteria:

- Stale remote TUI cleanup works without stopping App Server.
- Replacement fallback can validate a callable MCP change when continuation is
  stale.

Status: close, launch, and replace implemented/callable.

Implemented:

- `codex_session_close` reports matching remote TUI process roots in `dryRun`
  mode by default.
- Real close requires `dryRun: false`, `confirm: true`, and explicit
  `threadId`.
- The close operation runs in a detached child after a short delay so the tool
  call can return before a matching TUI is closed.
- Matching is scoped to current workspace, App Server URL, and thread id; App
  Server processes are excluded.
- `codex_session_launch` builds a Codex remote TUI launch against an existing
  loopback App Server URL.
- Launch defaults to `dryRun: true`; real launch requires `dryRun: false` and
  `confirm: true`.
- Launch can start fresh, resume a specific `threadId`, resume last, or open
  picker mode. Supplying `threadId` implies session mode.
- Launch does not start App Server; lifecycle start/status/stop belongs to the
  dedicated App Server lifecycle tools.
- `codex_session_replace` composes explicit-thread remote TUI cleanup with a
  same-thread remote launch against the selected App Server URL.
- Replace defaults to `dryRun: true`; real replacement requires
  `dryRun: false` and `confirm: true`.
- Replace prompt text is carried by child environment, never argv, and is
  redacted from previews, operation evidence, and failure evidence.
- Replace does not start App Server; it only composes explicit-thread close
  plus same-thread launch against an existing App Server URL.

Validation:

- Unit tests cover matching only the explicit-thread remote TUI root, excluding
  App Server and wrong-thread/wrong-url processes.
- Unit tests cover dry-run evidence, confirm refusal, durable scheduling, child
  runner completion, and argv without broad cleanup flags.
- App Server status listed `codex_session_close`.
- A fresh proof turn called `codex_session_close` in `dryRun` mode; it returned
  `ok: true`, `confirmRequired: true`, `targetCount: 0`, and
  `appServerWillBeStopped: false`.
- Unit tests cover launch dry-run preview, mode/thread validation, confirm
  refusal, durable scheduling, child runner completion through a fake executor,
  and argv without prompt text.
- App Server status listed `codex_session_launch`.
- A fresh proof turn called `codex_session_launch` in `dryRun` mode; it
  returned `ok: true`, `confirmRequired: true`, `mode: session`,
  `startsAppServer: false`, and a `<prompt>` placeholder instead of prompt
  text.
- Unit tests cover replace dry-run preview, confirm refusal, durable
  scheduling, close+launch child runner completion through fake process and
  launch executors, and argv without prompt text or broad cleanup flags.
- App Server status listed `codex_session_replace`.
- A fresh proof turn called `codex_session_replace` in `dryRun` mode; it
  returned `ok: true`, `confirmRequired: true`, `close.targetCount: 0`,
  `close.remoteProcessCount: 0`, `startsAppServer: false`, and a `<prompt>`
  placeholder instead of prompt text.

Remaining in Phase 5:

- none for the current safe-first session tool surface.

## Phase 6: Port From Experimental Repo

Port only the parts that survive the new architecture:

- loopback URL guardrails;
- cwd guardrails;
- Windows hidden stdio launcher logic if needed for installed stdio helpers;
- App Server lifecycle state;
- validation matrix patterns;
- security scan patterns.

Do not copy the old code shape blindly.

Status: cwd guardrails, read-only App Server state, security scan patterns,
repo-local `remote`, Windows hidden App Server launch, and visual popup
behavior probes promoted.

Implemented:

- `resolveWorkspaceCwd` constrains tool-provided `cwd` values to the current
  workspace.
- The guard rejects lexical escapes such as `..` and absolute outside paths.
- The guard resolves the deepest existing ancestor so symlink/junction escapes
  are rejected even when the requested final directory does not exist.
- `codex_threads_list` and `codex_thread_context` use this guard before
  querying App Server thread state.
- `codex_app_server_state_read` exposes redacted launcher state diagnostics for
  the current workspace.
- App Server URL resolution state is now centralized in typed state helpers and
  still supports legacy `.codex-mcp-hot-reloader` state for bootstrap
  compatibility.
- `security:scan`, `security:smoke`, and `audit:prod` are available for release
  hygiene.
- The security scan checks tracked files for personal paths, local workspace
  paths, concrete UUID-style thread/app ids, common credential shapes, and App
  Server URLs with credentials/path/query/fragment, while redacting findings.
- `codex-agent-session-manager remote` starts or reuses a workspace App Server
  using primary `.codex-agent-session-manager` state only, then launches Codex
  with `--remote`.
- `remote --resume <thread-id>` is accepted as the Codex-like alias for
  `--session-id <thread-id>`, and default TUI launch includes
  `--dangerously-bypass-approvals-and-sandbox` unless `--no-bypass-sandbox` is
  passed.
- The first-cut remote launcher intentionally does not read legacy
  `.codex-mcp-hot-reloader` state, so Windows popup probes can compare the new
  flow against the old launcher.
- On Windows, `remote` wraps the managed background App Server with a generated
  `.codex-agent-session-manager/windows-hidden-stdio-launcher.exe` when Codex
  resolves to native `codex.exe`.
- The visible Codex TUI remains direct; the launcher does not edit the user's
  global MCP config.

Validation:

- Unit tests cover default/nested cwd, missing final directories, lexical
  escapes, and symlink/junction escapes when supported by the platform.
- A fresh proof turn called `codex_thread_context` with `cwd: ".."` and
  received the expected guardrail failure:
  `Workspace cwd must stay inside the current workspace.`
- Unit tests cover primary/legacy state reads, corrupt state files, write/read
  behavior, env-over-state precedence, legacy omission, and workspace path
  redaction.
- A fresh proof turn called `codex_app_server_state_read`; it returned
  `resolved.source: legacy-state`, `resolved.url: ws://127.0.0.1:57798`,
  primary state absent, legacy state present, and workspace paths redacted.
- `npm run security:smoke`
- `npm run security:scan`
- `npm run audit:prod`
- Unit tests cover remote arg parsing, ignoring legacy state, preferring primary
  state, redacted dry-run output, and fake `--no-resume` App Server start state.
- `npm run remote -- --dry-run --no-resume`
- Unit tests cover the Windows hidden App Server wrapper plan while keeping the
  TUI command direct.
- `npm run remote -- --no-resume --port 4571` started
  `windows-hidden-stdio-launcher.exe` as the managed App Server root and
  `codex.exe app-server --listen ws://127.0.0.1:4571` as its child; the test
  process and state were cleaned up afterwards.

Status after operator probe:

- The operator restored global Slack/node_repl MCP config to direct stdio,
  restarted the session, ran `/mcp`, and observed no popups.
- The operator then ran `npm run remote` in this repo and `/mcp` in the opened
  session and again observed no popups.
- Decision at this phase: do not rewrite or virtualize the user's global MCP
  config by default. Later native-init probes extended the same local hidden
  launcher to the project-scoped session-manager MCP on Windows.

## Phase 7: App Server Lifecycle Tooling

- Let the agent start or reuse a workspace-managed App Server without launching
  a TUI.
- Keep App Server lifecycle separate from visible remote TUI launch.
- Reuse the CLI `remote --no-resume` plan, including Windows hidden App Server
  launcher behavior.

Status: lifecycle start/status/stop first cut implemented.

Implemented:

- `codex_app_server_start` exposes managed App Server start/reuse as an MCP
  tool.
- The tool defaults to `dryRun: true`; real execution requires
  `dryRun: false` and `confirm: true`.
- Real execution creates an `app_server_start` operation and schedules a
  detached child.
- The child runs the same no-resume remote plan used by the CLI, records output
  and exit code, and leaves TUI launch to `codex_session_launch`.
- `codex_app_server_status` reports primary workspace-managed launcher state,
  process liveness, optional `/readyz` status, and redacted process-tree
  evidence.
- `codex_app_server_stop` targets only the primary workspace-owned App Server
  process tree. It defaults to `dryRun: true`; real execution requires
  `dryRun: false` and `confirm: true`.
- Real stop creates an `app_server_stop` operation, schedules a detached child,
  stops the matched process tree, waits for it to exit, and marks primary state
  as `stopped`/`owned:false`.
- Stop does not close remote TUI windows and does not rewrite user global MCP
  configuration.

Validation:

- Unit tests cover dry-run planning, confirm refusal, durable scheduling,
  child execution through a fake executor, and argv parsing.
- Unit tests cover status `/readyz` probing, stop dry-run, confirm refusal,
  durable stop scheduling, process-tree stop evidence, stopped state write, and
  argv parsing.
- `npm run smoke` confirms the lifecycle tools are listed by MCP `tools/list`
  and calls start/status/stop in non-destructive modes.
- Fresh-turn callable proof called `codex_app_server_start` with
  `dryRun:true`, `port:"4566"` and returned
  `APP_SERVER_START_CALLABLE_PROOF_DONE`.
- Fresh-turn callable proof after App Server MCP reload called
  `codex_app_server_status` and `codex_app_server_stop` with `dryRun:true`,
  then returned `APP_SERVER_LIFECYCLE_CALLABLE_PROOF_DONE`.
- Disposable real-stop probe started a temporary workspace App Server with
  `remote --no-resume --port auto`, ran the App Server stop operation against
  that workspace, and observed operation `completed`, state `stopped`,
  `owned:false`, and no remaining process for the managed App Server root.

## Phase 8: Public CLI Surface

- Expose a stable operator CLI for the App Server/session operations already
  proven through MCP tools.
- Keep the CLI as a thin wrapper over the same typed payload builders and
  guardrails, not a separate App Server client architecture.
- Make common lifecycle and refresh workflows usable without asking an agent to
  call internal `run-*` child commands directly.

Status: first public CLI surface implemented.

Implemented:

- `codex-agent-session-manager app-server start|status|stop`.
- `codex-agent-session-manager mcp refresh`.
- `codex-agent-session-manager session launch|close|replace`.
- JSON output by default for operator parsing and future automation.
- `--confirm` switches guarded dry-run operations into real execution by
  setting `dryRun:false`; `--dry-run` remains explicit preview mode.
- `--prompt-file` is available for refresh, launch, and replace prompts when
  shell history should not contain prompt text. Prompt files are restricted to
  the current workspace and bounded before read.
- Top-level help now advertises the public CLI commands.
- The `mcp` command dispatches to the public CLI when a subcommand or help flag
  is present, while `serve` remains the explicit stdio-server command.

Validation:

- Unit tests cover public CLI parsing for App Server lifecycle, MCP refresh,
  session launch, session close, and session replace.
- Unit tests cover JSON output for an App Server start dry-run and required
  `--thread-id` validation.
- `npm run smoke` covers top-level CLI help, `mcp --help` routing, and
  `app-server start --dry-run --port 4566`.
- Manual dry-runs covered:
  - `node --import tsx src/cli.ts --help`
  - `node --import tsx src/cli.ts app-server start --dry-run --port 4566`
  - `node --import tsx src/cli.ts session launch --dry-run --url ws://127.0.0.1:4566 --thread-id thread-a`

## Phase 9: Project Init And Bootstrap

- Let an operator prepare a target project with one command.
- Keep initialization project-scoped and idempotent.
- Avoid touching `~/.codex/config.toml` or rewriting user global MCP servers.
- Make the default helpful for agents while allowing `AGENTS.md` opt-out.

Status: first project init command implemented.

Implemented:

- `codex-agent-session-manager init`.
- `--dry-run`, `--workspace <path>`, and `--no-agents`.
- Human-readable output by default with redacted workspace paths; `--json`
  keeps machine-readable output available for automation.
- Project-scoped `.codex/config.toml` registration for
  `codex_agent_session_manager`, so a normal `codex` session launched from the
  project can call the session-manager tools without using `remote`.
- The generated MCP config uses the project-local
  `node_modules/codex-agent-session-manager/dist/cli.js` entrypoint so native
  `codex` launchers do not depend on a globally installed npm shim.
- On Windows, that project-scoped MCP config uses the generated
`.codex-agent-session-manager/windows-hidden-stdio-launcher.exe`; local
  package installs run through `node node_modules/.../dist/cli.js serve`.
- `.gitignore` entries for `.codex-agent-session-manager/` runtime state and
  workspace-local `.npm-cache/`.
- `package.json` is created when absent and updated when present:
  - `devDependencies.codex-agent-session-manager`
  - `codex:init`
  - `codex:init:dry-run`
  - `codex:remote`
  - `codex:remote:dry-run`
  - `codex:app-server:status`
  - `codex:app-server:stop`
- Small managed `AGENTS.md` block by default, skipped with `--no-agents`.
- Optional `--install-shell-hook` installs or refreshes the marked PowerShell
  `codex` function hook as an explicit opt-in; default `init` remains
  project-scoped and does not edit shell profiles.
- If the local package entrypoint is missing, `init` installs the package as a
  project devDependency with `--ignore-scripts --no-audit --no-fund --cache
  ./.npm-cache`.
- Windows hidden App Server launcher preparation uses the same launcher helper
  as `remote` and remains scoped to local runtime state.
- Repo-local plugin marketplace integration was probed. A bundled-MCP plugin
  works after explicit `codex plugin marketplace add` and `codex plugin add`,
  but a generated repo marketplace alone did not make the MCP callable in a
  fresh `codex exec` session. Keep plugin packaging as a future distribution
  option; use `.codex/config.toml` for this release's native project mode.

Validation:

- Unit tests cover argument parsing, redacted dry-run output, no-write dry-run,
  target project application, idempotency, empty-workspace package creation,
  `--install-shell-hook`, and `--no-agents`.
- A fresh `codex exec` probe in a temporary project with `package.json`, local
  `codex-agent-session-manager` dependency, generated hidden Windows MCP
  config, and no `remote` call invoked
  `codex_agent_session_manager/codex_session_manager_probe` successfully.
- `npm run smoke` runs `init --dry-run` against a temporary workspace.
- The command does not edit user global Codex config.

## Phase 10: Package And Install Hardening

- Prove the package works outside the source repo.
- Keep the npm package small: published files are `dist/`, `scripts/*.cs`,
  `README.md`, `LICENSE`, and npm's required `package.json`.
- Validate target-project install and init through the generated `.tgz`.
- Keep automated install smoke dry-run for remote launch; real TUI launch stays
  a manual probe.

Status: first package/install smoke implemented.

Implemented:

- `npm run pack:dry-run`.
- `npm run pack:smoke`.
- `npm run pack:validate` runs package smoke and dry-run sequentially so
  multiple package validations do not rebuild `dist/` at the same time.
- `scripts/pack-smoke.ts` builds a tarball in a temporary directory, validates
  package contents, installs it into a temporary target project, runs installed
  `dist/cli.js`, runs `init --dry-run`, runs real `init`, validates generated
  files, and runs `npm run codex:remote:dry-run`.
- `mcp add npm` supports `envVars` / `--env-var` for secret-bearing stdio MCPs
  without writing secret values into project config.
- `mcp add npm` supports empty extra args / `--no-default-stdio-arg` for
  packages that default to stdio without a positional transport argument.
- Package content validation requires:
  - `package.json`
  - `README.md`
  - `LICENSE`
  - `dist/cli.js`
  - `scripts/windows-hidden-stdio-launcher.cs`
- Package content validation rejects source/test/docs files, `.codex*`
  runtime config, and `.exe` runtime binaries.
- README install path recommends local devDependency install:
  `npm install -D codex-agent-session-manager`.

Validation:

- `npm run pack:validate`
- Pack smoke proves installed CLI version, project init, generated scripts,
  project-scoped MCP config, runtime ignore rule, managed `AGENTS.md` block,
  and installed `codex:remote:dry-run`.
- External env/auth validation passed with Tavily MCP:
  `TAVILY_API_KEY` was forwarded through project-scoped `env_vars`, the secret
  value was not written to config, fresh `codex exec` called
  `tavily_search/tavily_search`, and managed cleanup left the scratch workspace
  empty.
- `deinit --remove-added-mcps --remove-empty-npm-project
  --remove-empty-codex-dir` can now remove a scratch npm project whose only
  remaining packages are the session manager and managed npm MCP installs.
  `.codex/` cleanup accounts for config files that the same deinit plan will
  delete.
- Public CLI subcommands now reject ignored cross-command flags and extra
  positionals before scheduling guarded operations.
- Windows detached `session launch` now uses the npm `codex.cmd` terminal shim
  through `cmd.exe /c` instead of launching native `codex.exe` directly, and
  records App Server loaded-thread verification before completing deterministic
  launch operations.

## Phase 11: Real Agent Replay Hardening

- Use disposable initialized projects to replay agent-managed MCP installation,
  refresh, proof, and cleanup flows.
- Reduce failure modes observed when an agent uses the tool from a plain
  `codex` session or from a managed remote session.
- Keep the project-scoped contract: no user global Codex config edits and no
  raw terminal cleanup as the expected path.

Status: in progress.

Implemented:

- `init` now makes empty workspaces self-contained instead of requiring a
  pre-existing npm project or global binary fallback.
- `init` and `mcp add npm` use a workspace-local npm cache so Windows agents do
  not fall into PowerShell `npm.ps1` execution-policy issues or user-global npm
  cache permissions during normal flows.
- Generated `AGENTS.md` now tells agents to prefer `mcp add npm`, avoid direct
  stdio server launches, stop once the target callable MCP tool succeeds, and
  avoid direct SDK fallbacks as proof.
- `codex_mcp_refresh` and `codex_session_continue` evidence now explicitly
  says operation completion means `turn/start` was accepted, not that the child
  turn finished.
- `codex_app_server_status` reconciles stale managed ready state when the
  recorded App Server process is gone, including stuck managed stop operations.
- `deinit` removes the managed `.npm-cache/` ignore rule along with the runtime
  ignore rule while preserving general secret-file ignore entries.
- Experimental hard process reset probes now have concrete evidence:
  - fresh remote TUI launch on Windows produces a separate
    `cmd.exe -> node.exe -> codex.exe` tree, while the App Server remains under
    `windows-hidden-stdio-launcher.exe -> codex.exe`;
  - fresh TUI argv does not include the runtime thread id, so hard close needs
    the explicit workspace+URL fallback after the target thread is discovered
    from App Server launch verification;
  - hard close of the TUI tree leaves the App Server alive;
  - relaunching the same thread with `session launch --mode session
    --thread-id <id> --prompt <text>` processes the prompt without using
    App Server `turn/start`. A `thread/read` probe confirmed both the initial
    fresh-launch marker and the relaunch prompt marker in the same thread.
- The hard reset path is currently classified as an experimental fallback over
  existing process launch/close primitives, not as the default refresh model.
- `codex_session_hard_relaunch` is implemented as the tool form of that
  fallback for plain `codex` sessions. It finds the current TUI from the MCP
  server process ancestry, resumes the current thread by default with a
  non-secret prompt, then attempts to stop the old TUI root. If the thread id
  cannot be inferred, the tool refuses and requires explicit `threadId` or
  `resumeMode: "fresh"`.
- An opt-in PowerShell shell-hook probe is implemented but not promoted to the
  default path. `shell-hook install --confirm` or
  `init --install-shell-hook` adds a marked `codex` function to the PowerShell
  profile; initialized workspaces provide a local supervisor script that routes
  `codex` to `codex-agent-session-manager remote`, preserving the familiar
  entry command while starting/reusing the managed App Server.
  The same script consumes `shell-resume-next` state with
  `mode: "managed-remote"` and relaunches the managed remote flow in the same
  terminal.

Validation:

- Unit coverage added for empty-workspace init/install behavior, local npm
  cache install args, stale App Server state reconciliation, `--no-process-tree`
  status handling, `/readyz`-alive reconciliation suppression, and managed
  `.npm-cache/` deinit cleanup.
- Unit coverage added for hard relaunch target discovery, redacted dry-run
  output, default resume behavior, explicit fresh fallback, background
  scheduling, operation argv parsing, and launch-before-stop ordering.
- Unit coverage added for shell-hook dry-run/install/status/uninstall, managed
  remote shell-supervisor generation, and `handoffMode: "shell-resume-next"`
  managed-remote state writing and consumption into
  `remote --resume/--prompt` arguments.
- Real replay findings preserved in `docs/validation-plan.md`: plain `codex`
  can expose project MCP tools, but self-management operations that need an App
  Server URL or continuation require a managed App Server path or explicit
  loopback URL.
- A disposable plain-`codex` replay proved the hard relaunch tool can bridge
  that gap for process-level self-management: Stage1 called
  `codex_session_hard_relaunch`, Stage2 launched without App Server
  `turn/start`, and `hard-relaunch-proof.txt` contained exactly
  `hard-relaunch-ok`.
