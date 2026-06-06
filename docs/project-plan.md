# Project Plan

Status: initial scaffold

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

## Phase 3: Thread Context And Operations

- Implement `codex_thread_context`.
- Add operation store and resources.
- Add `codex_operation_read` and `codex_operation_wait`.
- Preserve evidence for cwd, marker, status, loaded/stored source, and
  ambiguity.

Exit criteria:

- Same-cwd thread discovery works with multiple loaded threads.
- Marker match wins over active-but-stale candidates.

## Phase 4: Reload And Continuation

- Implement MCP reload.
- Implement continuation scheduling after idle/stable boundary.
- Record status-before/status-after as evidence.
- Require follow-up callable proof for pass.

Exit criteria:

- Handler/schema/new-tool fixture probes pass by continuation.
- Same-turn stale behavior is recorded as diagnostic, not pass.

## Phase 5: Session Launch, Close, Replace

- Start managed remote sessions.
- Close stale owned remote sessions.
- Replace remote TUI sessions as fallback.
- Keep App Server ownership and remote TUI ownership separate.

Exit criteria:

- Stale remote TUI cleanup works without stopping App Server.
- Replacement fallback can validate a callable MCP change when continuation is
  stale.

## Phase 6: Port From Experimental Repo

Port only the parts that survive the new architecture:

- loopback URL guardrails;
- cwd guardrails;
- Windows hidden stdio launcher logic if needed for installed stdio helpers;
- App Server lifecycle state;
- validation matrix patterns;
- security scan patterns.

Do not copy the old code shape blindly.

