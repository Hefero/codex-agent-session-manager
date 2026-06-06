# Project Plan

Status: Phase 4 preflight complete; MCP reload next

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

Status: preflight complete; reload and continuation not started.

Implemented:

- Runtime operation state is file-backed at
  `.codex-agent-session-manager/state/operations.json`.
- `.codex-agent-session-manager/` is ignored as local runtime state.
- Operation reads and waits reload state from disk, so an active MCP server can
  observe updates written by another process.
- Writes use temp-file plus rename.

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

## Phase 5: Session Launch, Close, Replace

- Start managed remote sessions.
- Close stale owned remote sessions.
- Replace remote TUI sessions as fallback.
- Keep App Server ownership and remote TUI ownership separate.

Exit criteria:

- Stale remote TUI cleanup works without stopping App Server.
- Replacement fallback can validate a callable MCP change when continuation is
  stale.

Status: not started.

## Phase 6: Port From Experimental Repo

Port only the parts that survive the new architecture:

- loopback URL guardrails;
- cwd guardrails;
- Windows hidden stdio launcher logic if needed for installed stdio helpers;
- App Server lifecycle state;
- validation matrix patterns;
- security scan patterns.

Do not copy the old code shape blindly.

Status: ongoing reference only.
