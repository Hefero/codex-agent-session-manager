# Current Session Handoff

Date: 2026-06-07

## Goal

Continue building `codex-agent-session-manager` as the clean TypeScript
successor to `codex-mcp-hot-reloader`.

The old repo is frozen as a reference. Work in this repo:

```text
<workspace>
```

## Current State

Phases 1, 2, 3, and 4 are implemented and validated. Phase 5 now has
`codex_session_close`, `codex_session_launch`, and `codex_session_replace`
implemented with fresh-turn callable proof. Check `git log` and `git status`
for the latest commit state.

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
- Continuation tool `codex_session_continue`.
- Remote TUI cleanup tool `codex_session_close`.
- Remote TUI launch tool `codex_session_launch`.
- Remote TUI replacement tool `codex_session_replace`.
- Resource `codex-session-manager://operations`.
- Runtime operation state under
  `.codex-agent-session-manager/state/operations.json`.
- Workspace cwd guardrails for tools that accept `cwd`.
- Security scripts `security:smoke`, `security:scan`, and `audit:prod`.
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
- Keep session launch scoped to an already-known App Server URL until lifecycle
  probes are promoted. `codex_session_launch` does not start App Server in its
  first cut.
- Keep session replacement as an explicit-thread composition of close plus
  launch. `codex_session_replace` does not start App Server in its first cut.
- Keep tool-provided `cwd` values scoped to the current workspace. Lexical
  escapes, symlink escapes, and junction escapes must be rejected before thread
  discovery queries App Server.
- Keep App Server lifecycle state visibility read-only until start/stop probes
  are promoted. `codex_app_server_state_read` reports resolution source and
  redacted state; it does not prove process liveness.

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

## Bootstrap Rule

Until Phase 6 lifecycle and Windows launcher probes are promoted, this session
is still a dogfood worker, not the primary controller. A separate controller
session may inject narrow checkpoints, schedule reloads/continuations, and
authorize commits/pushes.

Do not try to fully self-manage yet. Use the repo-local MCP tools when they are
available, and report whether they are callable.

## Next Work

1. Inspect the scaffold and current git status.
2. Continue Phase 6 probes. Windows hidden stdio launcher remains explicitly
   probe-gated by the operator decision.
3. Keep all future session-manager tools small, typed, and explicitly guarded.

## Do Not Do

- Do not continue editing `codex-mcp-hot-reloader` except as a reference.
- Do not copy the old `.mjs` architecture blindly.
- Do not log secrets, full prompts, or credential-bearing URLs.
- Do not implement broad auto-approval defaults from worker projects.
- Do not treat `mcpServerStatus/list` alone as proof that the model-callable MCP
  bridge refreshed.
