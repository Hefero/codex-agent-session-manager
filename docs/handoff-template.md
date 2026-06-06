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
- Resource: codex-session-manager://operations.
- Smoke: raw MCP JSON-RPC initialize, tools/list, tools/call, resources/list.

Important docs:
- AGENTS.md
- docs/architecture.md
- docs/project-plan.md
- docs/validation-plan.md
- docs/mcp-typescript-architecture-research.md
- docs/research/hot-reloader-origin-notes.md

Validation already expected for the scaffold:
- npm run check
- npm test
- npm run smoke
- npm run build

Next likely work:
1. Review current scaffold and validation output.
2. Implement the typed App Server client and loopback URL guardrails.
3. Add thread loaded/list/read wrappers.
4. Add codex_thread_context with marker/cwd/status evidence.
5. Keep tool schemas explicit and do not expose raw arbitrary App Server RPC.

Do not:
- log secrets or full continuation prompts;
- copy the old hot-reloader structure blindly;
- treat App Server MCP status as final callable proof;
- implement broad auto-approval defaults from worker projects.
```

