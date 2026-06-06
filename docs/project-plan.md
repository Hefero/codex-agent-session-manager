# Project Plan

Status: Phase 2 complete; Phase 3 next

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
thread context, operation read/wait, MCP reload, continuation scheduling, and
fresh-turn callable proof.

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

Status: next.

## Phase 4: Reload And Continuation

- Implement MCP reload.
- Implement continuation scheduling after idle/stable boundary.
- Record status-before/status-after as evidence.
- Require follow-up callable proof for pass.

Exit criteria:

- Handler/schema/new-tool fixture probes pass by continuation.
- Same-turn stale behavior is recorded as diagnostic, not pass.

Status: not started.

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
