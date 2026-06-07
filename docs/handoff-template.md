# Handoff Template

Use this when starting a new Codex remote session for this repo.

```text
Goal:
Continue building codex-agent-session-manager in
C:\Users\Guilherme\Documents\Claude\codex-agent-session-manager.

Context:
- This is the clean TypeScript extraction from codex-mcp-hot-reloader.
- The old repo is frozen; do not keep editing it except as a reference.
- The project goal is an agent-facing Codex App Server session manager plus MCP
  validation harness.
- The target direction is:
  Codex agent -> MCP tool -> Codex App Server -> Codex thread/session runtime.

Current foundation:
- TypeScript ESM package.
- MCP stdio server using @modelcontextprotocol/sdk.
- Zod-backed probe tool: codex_session_manager_probe.
- App Server read-only tools: codex_threads_list and codex_mcp_status_list.
- Thread context tool: codex_thread_context.
- Operation tools: codex_operation_read and codex_operation_wait.
- Reload tool: codex_mcp_reload.
- Continuation tool: codex_session_continue.
- Durable operation resource: codex-session-manager://operations.
- Runtime operation state: .codex-agent-session-manager/state/operations.json.
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

Next likely work:
1. Confirm Phase 4 reload and continuation tools are present and callable when
   the controller asks.
2. Tie reload plus continuation into a proof flow.
4. Keep tool schemas explicit and do not expose raw arbitrary App Server RPC.
5. Do not assume the worker is fully self-managing until reload/continue are
   implemented and proven.

Do not:
- log secrets or full continuation prompts;
- copy the old hot-reloader structure blindly;
- treat App Server MCP status as final callable proof;
- implement broad auto-approval defaults from worker projects.
```
