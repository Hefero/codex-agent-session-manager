# Handoff Template

Use this when starting a new Codex remote session for this repo.

```text
Goal:
Continue building codex-agent-session-manager in
<workspace>.

Context:
- The project goal is an agent-facing Codex App Server session manager plus MCP
  validation harness.
- The target direction is:
  Codex agent -> MCP tool -> Codex App Server -> Codex thread/session runtime.
- The old hot-reloader repo is frozen as historical reference only.

Current foundation:
- TypeScript ESM package.
- MCP stdio server using @modelcontextprotocol/sdk.
- Zod-backed probe tool: codex_session_manager_probe.
- App Server read-only tools: codex_threads_list and codex_mcp_status_list.
- App Server state read tool: codex_app_server_state_read.
- Thread context tool: codex_thread_context.
- Operation tools: codex_operation_read and codex_operation_wait.
- Reload tool: codex_mcp_reload.
- Refresh workflow tool: codex_mcp_refresh.
- App Server lifecycle tools: codex_app_server_start,
  codex_app_server_status, and codex_app_server_stop.
- Continuation tool: codex_session_continue.
- Remote TUI cleanup tool: codex_session_close.
- Remote TUI launch tool: codex_session_launch.
- Remote TUI replacement tool: codex_session_replace.
- Durable operation resource: codex-session-manager://operations.
- Runtime operation state: .codex-agent-session-manager/state/operations.json.
- Workspace cwd guardrails reject lexical and symlink/junction escapes.
- Repo-local remote launcher: npm run remote. It uses primary
  .codex-agent-session-manager state and ignores legacy hot-reloader state.
- Public CLI:
  codex-agent-session-manager init,
  codex-agent-session-manager app-server start|status|stop,
  codex-agent-session-manager mcp refresh, and
  codex-agent-session-manager session launch|close|replace.
- Project init writes project-scoped `.codex/config.toml`, local runtime ignore
  rules, package scripts when `package.json` exists, and an `AGENTS.md` block
  unless `--no-agents` is used.
- Package hardening script: npm run pack:validate. Do not parallelize
  pack:dry-run and pack:smoke because both rebuild dist.
- Security scripts: security:smoke, security:scan, audit:prod.
- Smoke: raw MCP JSON-RPC initialize, tools/list, tools/call, resources/list.

Important docs:
- AGENTS.md
- docs/architecture.md
- docs/project-plan.md
- docs/validation-plan.md
- docs/mcp-typescript-architecture-research.md
- docs/research/hot-reloader-origin-notes.md

Validation already expected:
- npm run check
- npm test
- npm run smoke
- npm run build
- npm run security:smoke
- npm run security:scan
- npm run audit:prod
- npm run remote -- --dry-run --no-resume

Next likely work:
1. Inspect git status and read `docs/project-plan.md`.
2. Prefer `codex_mcp_refresh` for MCP reload plus continuation proof.
3. Keep tool schemas explicit and do not expose raw arbitrary App Server RPC.
4. Do not assume broad session cleanup is safe without explicit thread/process
   ownership evidence.

Do not:
- log secrets or full continuation prompts;
- copy the old hot-reloader structure blindly;
- treat App Server MCP status as final callable proof;
- implement broad auto-approval defaults from worker projects.
```
