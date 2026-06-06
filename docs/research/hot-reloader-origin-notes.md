# Hot Reloader Origin Notes

Status: migrated lessons from `codex-mcp-hot-reloader`
Date: 2026-06-06

## What The Experimental Repo Solved

The original repo started as `codex-mcp-hot-reloader` and solved a concrete MCP
development problem:

- Windows stdio MCP launchers could create visible `cmd`/`conhost` popups.
- MCP server process reload was not enough to update the model-callable tool
  catalog inside the current turn.
- Agents needed a reliable way to schedule reload plus continuation, and later
  close or replace stale remote sessions.

The repo is now frozen as a reference. This repo extracts the broader
architecture.

## Durable Findings

1. App Server status and model-callable catalog are separate layers.

   `mcpServerStatus/list` can report a new tool while the current model turn
   still cannot call it. Status is diagnostic. Callable proof requires a real
   tool invocation from the right model-callable boundary.

2. Timing matters more than process restart.

   Handler, schema, new-tool, removal, and restoration probes passed when a
   continuation turn was scheduled after the thread reached idle. Hard process
   replacement was useful as fallback, but not the default minimum path.

3. Rename cases are stricter.

   MCP server/tool renames can leave stale callable namespaces in ways that
   status does not reveal. Treat rename proof as requiring continuation first,
   then replacement/fresh remote or fresh exec fallback if stale.

4. Thread identity must be explicit.

   Multiple loaded threads make heuristic selection dangerous. Use explicit
   `threadId` when known. When lost, recover by cwd, marker text, active status,
   and stored-thread search evidence.

5. Stale remote sessions need cleanup tools.

   A remote TUI can get stuck waiting for approval or become stale after a
   replacement flow. Closing stale owned remote sessions is a separate operation
   from stopping App Server.

6. Windows process behavior needs first-class handling.

   Avoid npm `.cmd` wrappers and visible console processes where possible. The
   old repo used a hidden stdio launcher for Windows local MCP helpers. Port
   only if the new package needs Windows stdio helper installation.

## Parts To Port Later

- Loopback URL validation.
- App Server URL redaction.
- cwd escape and symlink/junction guardrails.
- operation background logs with prompt redaction.
- App Server managed state ownership.
- remote launch/close/replace process matching.
- validation matrix labels and proof modes.
- Windows hidden stdio launcher logic if this package installs project-local
  stdio helpers.

## Parts Not To Port Blindly

- The old `.mjs` module shape.
- `init` behavior tied to hot-reloader naming.
- sample fixture naming.
- broad package scripts that exist only for the old release process.
- old docs that frame the project as only MCP hot reload.

