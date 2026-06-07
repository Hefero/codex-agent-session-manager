# Codex Agent Session Manager

Agent-facing Codex App Server session manager with an MCP validation harness.

This repository is a clean extraction from the `codex-mcp-hot-reloader`
research and validation work. The goal is to expose selected Codex App Server
session operations as safe MCP tools that a Codex agent can call from inside its
own workflow.

Early scope:

- discover loaded and persisted Codex threads;
- identify the intended thread with cwd, status, and marker evidence;
- reload MCP server processes and continue after an idle boundary;
- close or replace stale managed remote sessions;
- track operations with status, logs, and next actions;
- validate MCP callable-catalog changes from a fresh model turn.

The project is intentionally starting from the session-management architecture,
not from a generic App Server SDK or a human session browser.

## Current Surface

The current MCP surface is still small, but already dogfooded:

- TypeScript ESM package.
- MCP stdio server using `@modelcontextprotocol/sdk`.
- Zod-backed tools:
  - `codex_session_manager_probe`
  - `codex_threads_list`
  - `codex_mcp_status_list`
  - `codex_app_server_state_read`
  - `codex_thread_context`
  - `codex_operation_read`
  - `codex_operation_wait`
  - `codex_mcp_reload`
  - `codex_mcp_refresh`
  - `codex_app_server_start`
  - `codex_app_server_status`
  - `codex_app_server_stop`
  - `codex_session_continue`
  - `codex_session_close`
  - `codex_session_launch`
  - `codex_session_replace`
- Durable operation resource: `codex-session-manager://operations`.
- Raw JSON-RPC smoke test for MCP initialization, tool listing, tool call, and
  resource listing.

MCP status from App Server is treated as diagnostic only. Callable-catalog proof
requires a real model-callable tool invocation from the correct continuation or
replacement boundary.

For the common “MCP changed, refresh and continue” path, use
`codex_mcp_refresh`: it reloads MCP servers, records before/after status
evidence, waits for the target thread to become idle, and starts the
continuation turn. The continuation must still perform the actual proof call.

## Development

```powershell
npm install
npm run check
npm test
npm run smoke
npm run build
npm run security:smoke
npm run security:scan
npm run audit:prod
npm run remote -- --dry-run --no-resume
```

Start the MCP server:

```powershell
npm run serve
```

Start a Codex remote session from this repo's own launcher:

```powershell
npm run remote -- --dry-run --no-resume
npm run remote
```

The `remote` command reads and writes only
`.codex-agent-session-manager/state/app-server.json`; it intentionally ignores
legacy hot-reloader launcher state so Windows popup tests can compare the new
flow against the old launcher.

On Windows, `remote` starts the managed App Server through a generated
`.codex-agent-session-manager/windows-hidden-stdio-launcher.exe` when the Codex
binary resolves to `codex.exe`. The visible Codex TUI still launches normally;
only the background App Server process is wrapped. This does not edit the
user's global `~/.codex/config.toml`.

Agents can start or reuse the same managed App Server path through
`codex_app_server_start`. The tool records a durable operation and leaves TUI
launching to `codex_session_launch`, keeping App Server lifecycle and visible
session launch as separate operations. Agents can inspect the managed process
with `codex_app_server_status` and stop only the workspace-owned App Server
tree with `codex_app_server_stop`; neither operation rewrites user global MCP
configuration.

## Documentation

- `docs/architecture.md`: target architecture.
- `docs/project-plan.md`: phase plan.
- `docs/validation-plan.md`: initial validation matrix.
- `docs/handoff-template.md`: handoff for starting a fresh Codex session.
- `docs/mcp-typescript-architecture-research.md`: stack research.
- `docs/research/hot-reloader-origin-notes.md`: lessons from the experimental
  repo.
