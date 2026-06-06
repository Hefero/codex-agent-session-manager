# Validation Plan

Status: initial scaffold

## Scaffold Checks

```powershell
npm run check
npm test
npm run smoke
npm run build
```

The smoke must prove:

- MCP initialize succeeds.
- `tools/list` includes `codex_session_manager_probe`.
- `tools/call` can call `codex_session_manager_probe`.
- `resources/list` includes `codex-session-manager://operations`.

## App Server Checks

To be added in Phase 2:

- reject non-loopback App Server URLs;
- reject URL credentials, path, query, and fragment;
- initialize App Server connection before any other request;
- list loaded threads;
- list stored threads scoped by cwd;
- read MCP server status for a target thread.

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
  staleness, especially rename cases.
- Stale remote TUI cleanup is session hygiene, not callable proof.

