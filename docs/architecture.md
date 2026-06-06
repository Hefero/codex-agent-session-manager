# Architecture

Status: initial scaffold
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

## Initial MCP Surface

The first scaffold exposes:

- `codex_session_manager_probe`
- `codex-session-manager://operations`

Planned next tools:

- `codex_threads_list`
- `codex_thread_context`
- `codex_mcp_reload`
- `codex_session_continue`
- `codex_session_launch`
- `codex_session_close`
- `codex_session_replace`
- `codex_operation_wait`
- `codex_operation_read`

## Boundaries

This project is not:

- a general App Server SDK;
- a generic "call any JSON-RPC method" proxy;
- a human session browser;
- a broad subagent worker with auto-approval defaults.

The project may later grow a preloader UI or CLI, but the core artifact is the
MCP wrapper that lets a Codex agent manage the Codex session/control-plane
problem from inside its own workflow.

