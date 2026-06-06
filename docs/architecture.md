# Architecture

Status: Phase 3 complete
Date: 2026-06-06

## Thesis

`codex-agent-session-manager` is an agent-facing wrapper around selected Codex
App Server operations.

Most App Server wrappers are human-facing clients, external task gateways, or
language SDKs. This project is different:

```text
Codex agent -> MCP tool -> Codex App Server -> Codex thread/session runtime
```

The agent should not need to write one-off JSON-RPC scripts every time it needs
to find a thread, reload MCP servers, schedule a continuation, close stale
remote sessions, or prove that a new MCP callable tool is really available.

## Layers

1. MCP surface
   - Exposes a small set of agent-callable tools.
   - Exposes resources for operation state, logs, thread evidence, and
     validation results.

2. Operation model
   - Every mutating or long-running action gets an operation id.
   - Operations expose status, timestamps, evidence, and next actions.
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

## Initial MCP Surface

The current MCP surface exposes:

- `codex_session_manager_probe`
- `codex_threads_list`
- `codex_mcp_status_list`
- `codex_thread_context`
- `codex_operation_read`
- `codex_operation_wait`
- `codex-session-manager://operations`

Planned next tools:

- `codex_mcp_reload`
- `codex_session_continue`
- `codex_session_launch`
- `codex_session_close`
- `codex_session_replace`

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

## Boundaries

This project is not:

- a general App Server SDK;
- a generic "call any JSON-RPC method" proxy;
- a human session browser;
- a broad subagent worker with auto-approval defaults.

The project may later grow a preloader UI or CLI, but the core artifact is the
MCP wrapper that lets a Codex agent manage the Codex session/control-plane
problem from inside its own workflow.
