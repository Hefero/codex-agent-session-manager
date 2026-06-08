# Current Session Handoff

Date: 2026-06-07

## Goal

Continue building `codex-agent-session-manager` as an agent-facing Codex App
Server session manager plus MCP validation harness.

The old repo is frozen as a reference. Work in this repo:

```text
<workspace>
```

## Current State

Phases 1 through 10 are implemented and validated locally. Check `git log` and
`git status` for the latest commit state.

Implemented:

- `package.json` with TypeScript, `@modelcontextprotocol/sdk`, Zod, `tsx`, and
  build/check/test/smoke scripts.
- `tsconfig.json` and `tsconfig.build.json`.
- MCP stdio server in `src/mcp-server.ts`.
- CLI entry in `src/cli.ts`.
- Probe tool `codex_session_manager_probe`.
- Read-only tools `codex_threads_list` and `codex_mcp_status_list`.
- Read-only App Server launcher state tool `codex_app_server_state_read`.
- Read-only thread recommendation tool `codex_thread_context`.
- Operation tools `codex_operation_read` and `codex_operation_wait`.
- Reload tool `codex_mcp_reload`.
- Refresh workflow tool `codex_mcp_refresh`.
- Continuation tool `codex_session_continue`.
- App Server lifecycle tools `codex_app_server_start`,
  `codex_app_server_status`, and `codex_app_server_stop`.
- Remote TUI cleanup tool `codex_session_close`.
- Remote TUI launch tool `codex_session_launch`.
- Remote TUI replacement tool `codex_session_replace`.
- Public CLI surface:
  `init`, `app-server start|status|stop`, `mcp refresh`, and
  `session launch|close|replace`.
- Resource `codex-session-manager://operations`.
- Runtime operation state under
  `.codex-agent-session-manager/state/operations.json`.
- Workspace cwd guardrails for tools that accept `cwd`.
- Repo-local remote launcher through `npm run remote`; it uses primary
  `.codex-agent-session-manager` state and ignores legacy hot-reloader state.
- Security scripts `security:smoke`, `security:scan`, and `audit:prod`.
- Package hardening script `pack:validate`, which runs package smoke and pack
  dry-run sequentially.
- Env/auth npm MCP hardening target: Tavily MCP with `--env-var
  TAVILY_API_KEY` and `--no-default-stdio-arg`. Never store secret values in
  TOML.
- Raw JSON-RPC MCP smoke in `scripts/smoke.ts`.
- Unit test in `test/probe.test.ts`.
- Initial docs and ADRs.

Important docs:

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/project-plan.md`
- `docs/validation-plan.md`
- `docs/handoff-template.md`
- `docs/mcp-typescript-architecture-research.md`
- `docs/research/hot-reloader-origin-notes.md`
- `docs/adr/001-typescript-mcp-app-server-foundation.md`

## Validations Already Run

These passed:

```powershell
npm run check
npm test
npm run smoke
npm run build
node dist/cli.js --version
npm run security:smoke
npm run security:scan
npm run audit:prod
npm run remote -- --dry-run --no-resume
node --import tsx src/cli.ts init --dry-run --workspace . --no-agents
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts mcp --help
node --import tsx src/cli.ts app-server start --dry-run --port 4566
npm run pack:validate
git diff --check
```

`git diff --check` only printed the normal Windows LF/CRLF warning for
`README.md`; it did not report whitespace errors.

## Architecture Decisions

- Use TypeScript from the start.
- Use Node ESM.
- Use `@modelcontextprotocol/sdk` directly.
- Use Zod as the tool schema source of truth.
- Keep operation state and evidence as first-class resources.
- Persist operation state before implementing detached reload/continue children;
  in-memory-only state cannot be updated across processes.
- Do not expose arbitrary App Server JSON-RPC to the model.
- Treat App Server MCP status as diagnostic only; callable proof requires an
  actual model-callable tool invocation from the correct continuation or
  replacement boundary.
- Resolve App Server URL from explicit tool input, `CODEX_APP_SERVER_URL`, or
  workspace launcher state. Prefer `.codex-agent-session-manager` state when
  available; `.codex-mcp-hot-reloader` state is bootstrap compatibility only.
- Keep continuation prompts out of argv, structured output, operation evidence,
  and log-like failure evidence. The first `codex_session_continue`
  implementation requires an explicit `threadId`.
- Keep session cleanup safe-first: `codex_session_close` only targets explicit
  `threadId`, current workspace, and selected App Server URL; it defaults to
  `dryRun:true` and requires `confirm:true` for real cleanup.
- Keep session launch scoped to an already-known App Server URL.
  `codex_session_launch` does not start App Server; lifecycle start/status/stop
  stay in `codex_app_server_start`, `codex_app_server_status`, and
  `codex_app_server_stop`.
- Keep session replacement as an explicit-thread composition of close plus
  launch. `codex_session_replace` does not start App Server in its first cut.
- Keep tool-provided `cwd` values scoped to the current workspace. Lexical
  escapes, symlink escapes, and junction escapes must be rejected before thread
  discovery queries App Server.
- Keep App Server lifecycle tools scoped to primary workspace-managed state.
  `codex_app_server_state_read` reports resolution source and redacted state,
  `codex_app_server_status` reports liveness, and `codex_app_server_stop`
  requires `dryRun:false` plus `confirm:true`.

## Latest Phase 3 Evidence

`codex_thread_context` was validated locally and by dogfood replacement proof:

```text
callable: true
call succeeded: true
recommendedThreadIdSource: loaded-marker-match
recommendationConfidence: high
ambiguous: false
target markerMatched: true
```

Before replacement, App Server status listed the tool but same-thread
reload/continuation still did not expose it in the model-callable catalog. Do
not count status alone as final proof.

`codex_operation_read` and `codex_operation_wait` were also validated by
replacement proof after same-thread reload/continuation remained stale:

```text
codex_operation_read:
  callable: true
  ok true: true
  found false: true

codex_operation_wait:
  callable: true
  ok true: true
  found false: true
  timedOut false: true
```

## Latest Phase 4 Preflight Evidence

Durable operation state was validated by writing `proof-durable-op` through the
store, reloading MCP, observing same-thread continuation stale behavior, then
using replacement proof:

```text
codex_operation_read:
  callable: true
  ok true: true
  found true: true
  status completed: true

codex_operation_wait:
  callable: true
  ok true: true
  found true: true
  completed true: true
  timedOut false: true
```

## Latest Phase 4 Reload Evidence

`codex_mcp_reload` was validated by replacement proof after App Server status
listed the tool but same-thread continuation remained stale:

```text
callable: true
background scheduled: true
final operation status: completed
evidence.background exists: true
evidence.statusBefore exists: true
evidence.statusAfter exists: true
final nextAction mentions continuation/fresh proof: true
```

Readback from durable operation state confirmed the final operation retained:

```text
requested, background, statusBefore, reload, statusAfter
```

## Latest Phase 4 Continuation Evidence

Local validation currently covers:

```text
npm run check
npm test
npm run smoke
npm run build
git diff --check
```

Unit tests cover scheduling a durable `session_continue` operation, carrying
the prompt to the child without argv, omitting prompt text from structured
payload/evidence, waiting for idle status, and calling `turn/start`.

External App Server reload and fresh-turn callable proof also passed:

```text
codex_session_continue callable: true
operationId: <operation-id>
background scheduled: true
operation status: completed
ready.ok: true
turnStart recorded: true
argvIncludesPrompt: false
prompt text present in operation JSON: false
child turn marker: PHASE5_CONTINUE_CHILD_PROOF_RECEIVED
```

## Latest Phase 5 Close Evidence

`codex_session_close` was validated locally and by fresh-turn callable dry-run
proof:

```text
callable: true
ok: true
dryRun: true
confirmRequired: true
targetCount: 0
remoteProcessCount: 0
appServerWillBeStopped: false
```

## Latest Phase 5 Launch Evidence

`codex_session_launch` was validated locally and by fresh-turn callable dry-run
proof:

```text
callable: true
ok: true
dryRun: true
confirmRequired: true
mode: session
promptProvided: true
startsAppServer: false
prompt text omitted from preview/evidence: true
```

## Latest Phase 5 Replace Evidence

`codex_session_replace` was validated locally and by fresh-turn callable
dry-run proof:

```text
callable: true
ok: true
dryRun: true
confirmRequired: true
close.targetCount: 0
close.remoteProcessCount: 0
startsAppServer: false
prompt text omitted from preview/evidence: true
```

## Latest Phase 6 Cwd Guardrail Evidence

Workspace cwd guardrails were validated locally and by fresh-turn callable
proof:

```text
callable tool: codex_thread_context
input cwd: ..
tool status: failed
expected error: Workspace cwd must stay inside the current workspace.
```

## Latest Phase 6 App Server State Evidence

`codex_app_server_state_read` was validated locally and by fresh-turn callable
proof:

```text
callable: true
ok: true
resolved.source: legacy-state
resolved.url: ws://127.0.0.1:57798
states count: 2
primary exists: false
legacy exists: true
raw workspace path omitted/redacted: true
```

## Latest Phase 6 Security Evidence

Security scan patterns were promoted:

```text
npm run security:smoke: pass
npm run security:scan: pass, scannedFiles: 53
npm run audit:prod: pass, found 0 vulnerabilities
```

## Latest Phase 6 Remote Evidence

The repo-local traditional remote launcher was added:

```text
npm run remote -- --dry-run --no-resume: pass
source: port-auto when only legacy state exists
state file: <workspace>/.codex-agent-session-manager/state/app-server.json
tests: parse args, ignore legacy state, prefer primary state, redacted dry-run,
fake no-resume state write
```

Operator-visible Windows popup behavior was promoted:

```powershell
cd <workspace>
npm run remote
# then run /mcp inside the opened Codex session
```

Result: after restoring global MCP config to direct stdio, `npm run remote` and
`/mcp` produced no popups. Keep the hidden launcher only for the managed App
Server initial process.

## Latest Phase 7 Lifecycle Evidence

Lifecycle tools are promoted:

```text
codex_app_server_start: callable proof pass
codex_app_server_status: callable proof pass
codex_app_server_stop dry-run: callable proof pass
```

`codex_mcp_refresh` is also promoted as the default reload-plus-continuation
workflow. Fresh-turn proof called `codex_mcp_refresh`; the resulting operation
completed with `statusBefore`, `statusAfter`, `ready`, and `turnStart`
evidence. The continuation turn called `codex_session_manager_probe` and
replied `MCP_REFRESH_CHILD_PROOF_DONE`.

## Latest Phase 8 Public CLI Evidence

Public CLI commands are promoted as operator-facing wrappers over the same
guarded payload builders used by MCP tools:

```text
codex-agent-session-manager app-server start|status|stop
codex-agent-session-manager mcp refresh
codex-agent-session-manager session launch|close|replace
```

Validation covers:

```text
parsePublicCommand: app-server, mcp refresh, session launch/close/replace
runPublicCommand: app-server start dry-run JSON
smoke: top-level help, mcp --help dispatch, app-server start dry-run
```

The `mcp` command now routes to the public CLI when a subcommand or help flag is
present; `serve` remains the explicit stdio-server command.

## Latest Phase 9 Init Evidence

Project init is promoted:

```text
codex-agent-session-manager init --dry-run
codex-agent-session-manager init
```

Implemented behavior:

```text
project-scoped .codex/config.toml: codex_agent_session_manager
.gitignore: .codex-agent-session-manager/
package.json: scripts and devDependency when package.json exists
AGENTS.md: small managed block by default, skipped by --no-agents
global Codex config: untouched
```

Validation covers parsing, redacted dry-run output, no-write dry-run,
application to a target project, idempotency, missing package.json, and
`--no-agents`. The smoke runs `init --dry-run` against a temporary workspace.

## Latest Phase 10 Package Evidence

Package/install hardening is promoted:

```text
npm run pack:validate
```

Pack smoke behavior:

```text
creates npm tarball in a temporary directory
validates package includes dist, README, LICENSE, package metadata, launcher .cs
rejects source, tests, docs, .codex runtime state, and .exe binaries
installs the .tgz into a temporary target project
runs installed dist/cli.js
runs init --dry-run and init from the installed package
validates generated config, gitignore, scripts, and AGENTS.md
runs npm run codex:remote:dry-run in the target project
```

Automated smoke intentionally stops at remote dry-run. Real TUI launch remains
an operator-visible manual probe.

Do not run `pack:dry-run` and `pack:smoke` concurrently; both rebuild `dist/`.
Use `pack:validate` for release/package validation.

Next external package probe is Tavily MCP: operator supplies `TAVILY_API_KEY`
only in the launch environment, the installer writes `env_vars`, MCP refresh
starts a continuation, and the proof turn calls a Tavily search tool before
managed cleanup.

## Bootstrap Rule

Lifecycle, Windows launcher, and refresh workflow probes are now promoted, but
this session is still a dogfood worker while commits/release boundaries are
controlled externally. A separate controller session may inject narrow
checkpoints, schedule reloads/continuations, and authorize commits/pushes.

Do not try to fully self-manage yet. Use the repo-local MCP tools when they are
available, and report whether they are callable.

## Next Work

1. Inspect the scaffold and current git status.
2. Prepare the next release boundary: optional real remote probe from an
   installed package, version choice, commit, push, and publish decision.
3. Keep all future session-manager tools small, typed, and explicitly guarded.
4. Continue treating App Server MCP status as diagnostic, not final callable
   proof.

## Do Not Do

- Do not continue editing `codex-mcp-hot-reloader` except as a reference.
- Do not copy the old `.mjs` architecture blindly.
- Do not log secrets, full prompts, or credential-bearing URLs.
- Do not implement broad auto-approval defaults from worker projects.
- Do not treat `mcpServerStatus/list` alone as proof that the model-callable MCP
  bridge refreshed.
