# Validation Plan

Status: Phase 5 close started

## Scaffold Checks

```powershell
npm run check
npm test
npm run smoke
npm run build
```

The smoke must prove:

- MCP initialize succeeds.
- `tools/list` includes:
  - `codex_session_manager_probe`
  - `codex_threads_list`
  - `codex_mcp_status_list`
  - `codex_thread_context`
  - `codex_operation_read`
  - `codex_operation_wait`
  - `codex_mcp_reload`
  - `codex_session_continue`
  - `codex_session_close`
- `tools/call` can call `codex_session_manager_probe`.
- `resources/list` includes `codex-session-manager://operations`.

## App Server Checks

Current read-only checks:

- reject non-loopback App Server URLs;
- reject URL credentials, path, query, and fragment;
- initialize App Server connection before any other request;
- list loaded threads;
- list stored threads scoped by cwd;
- read MCP server status for a target thread.
- recommend a target thread by marker/cwd/status evidence;
- read and wait for operation records.
- persist operation records under local workspace runtime state;
- observe operation completion written by another store/process instance.
- schedule MCP reload through durable operation state and detached child process;
- record diagnostic MCP status before/after reload when a thread id is supplied.
- schedule a continuation through durable operation state and a detached child
  process;
- pass continuation prompt text outside argv, structured output, operation
  evidence, and failure evidence;
- wait for idle/stable thread boundary before `turn/start`.
- prove `codex_session_continue` by a real model-callable invocation, then
  confirm the child turn started and replied from the scheduled continuation.
- report matching remote TUI process roots for explicit-thread cleanup in
  `dryRun` mode;
- refuse real remote TUI cleanup unless `dryRun:false` and `confirm:true`;
- exclude App Server processes from remote TUI cleanup targets.

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
