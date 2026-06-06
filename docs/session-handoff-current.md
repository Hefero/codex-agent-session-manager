# Current Session Handoff

Date: 2026-06-06

## Goal

Continue building `codex-agent-session-manager` as the clean TypeScript
successor to `codex-mcp-hot-reloader`.

The old repo is frozen as a reference. Work in this repo:

```text
C:\Users\Guilherme\Documents\Claude\codex-agent-session-manager
```

## Current State

Phase 1 and Phase 2 have been pushed. Phase 3 first slice is implemented and
validated; check `git log` and `git status` for the latest commit state.

Implemented:

- `package.json` with TypeScript, `@modelcontextprotocol/sdk`, Zod, `tsx`, and
  build/check/test/smoke scripts.
- `tsconfig.json` and `tsconfig.build.json`.
- MCP stdio server in `src/mcp-server.ts`.
- CLI entry in `src/cli.ts`.
- Probe tool `codex_session_manager_probe`.
- Read-only tools `codex_threads_list` and `codex_mcp_status_list`.
- Read-only thread recommendation tool `codex_thread_context`.
- Resource `codex-session-manager://operations`.
- Raw JSON-RPC MCP smoke in `scripts/smoke.ts`.
- Unit test in `test/probe.test.ts`.
- Initial docs and ADRs.

Important docs:

- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/project-plan.md`
- `docs/validation-plan.md`
- `docs/handoff-template.md`
- `docs/mcp-typescript-architecture-research.md`
- `docs/research/hot-reloader-origin-notes.md`
- `docs/adr/001-typescript-mcp-app-server-foundation.md`

## Validations Already Run

These passed:

```powershell
npm run check
npm test
npm run smoke
npm run build
node dist/cli.js --version
git diff --check
```

`git diff --check` only printed the normal Windows LF/CRLF warning for
`README.md`; it did not report whitespace errors.

## Architecture Decisions

- Use TypeScript from the start.
- Use Node ESM.
- Use `@modelcontextprotocol/sdk` directly.
- Use Zod as the tool schema source of truth.
- Keep operation state and evidence as first-class resources.
- Do not expose arbitrary App Server JSON-RPC to the model.
- Treat App Server MCP status as diagnostic only; callable proof requires an
  actual model-callable tool invocation from the correct continuation or
  replacement boundary.
- Resolve App Server URL from explicit tool input, `CODEX_APP_SERVER_URL`, or
  workspace launcher state. Prefer `.codex-agent-session-manager` state when
  available; `.codex-mcp-hot-reloader` state is bootstrap compatibility only.

## Latest Phase 3 Evidence

`codex_thread_context` was validated locally and by dogfood replacement proof:

```text
callable: true
call succeeded: true
recommendedThreadIdSource: loaded-marker-match
recommendationConfidence: high
ambiguous: false
target markerMatched: true
```

Before replacement, App Server status listed the tool but same-thread
reload/continuation still did not expose it in the model-callable catalog. Do
not count status alone as final proof.

## Bootstrap Rule

Until Phase 4 minimum exists, this session is a dogfood worker, not the primary
controller. A separate controller session may inject narrow checkpoints,
schedule reloads/continuations, and authorize commits/pushes.

Do not try to fully self-manage yet. Use the repo-local MCP tools when they are
available, and report whether they are callable.

## Next Work

1. Inspect the scaffold and current git status.
2. If Phase 3 first slice is still uncommitted, review and commit it.
3. Continue Phase 3 with:
   - operation store/resources;
   - `codex_operation_read`;
   - `codex_operation_wait`.
4. Keep all future session-manager tools small, typed, and explicitly guarded.

## Do Not Do

- Do not continue editing `codex-mcp-hot-reloader` except as a reference.
- Do not copy the old `.mjs` architecture blindly.
- Do not log secrets, full prompts, or credential-bearing URLs.
- Do not implement broad auto-approval defaults from worker projects.
- Do not treat `mcpServerStatus/list` alone as proof that the model-callable MCP
  bridge refreshed.
