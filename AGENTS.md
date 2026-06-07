# Codex Agent Session Manager

This repo is the clean TypeScript extraction from the
`codex-mcp-hot-reloader` research work.

## Operating Rules

1. Treat Codex App Server process reload, thread continuation, remote TUI
   replacement, and model-callable MCP proof as separate layers.
2. Do not expose raw arbitrary App Server JSON-RPC as an MCP tool. Wrap only
   selected operations with explicit schemas, guardrails, and result shapes.
3. Prefer loopback-only App Server URLs. Reject credentials, paths, query
   strings, fragments, and non-loopback hosts until a remote mode is designed.
4. Never log tokens, environment secrets, full continuation prompts, or private
   App Server credentials.
5. Every mutating session operation must return an operation id, status, and a
   concrete next action.
6. App Server status is diagnostic evidence. Callable MCP validation requires a
   real model-callable tool invocation from the correct turn/session boundary.
7. Keep the implementation TypeScript-first: Zod schemas, typed handlers,
   structured results, and focused smokes.

## Required Local Checks

Run these before claiming a scaffold or feature is complete:

```powershell
npm run check
npm test
npm run smoke
npm run build
npm run security:smoke
npm run security:scan
npm run audit:prod
```

## Documentation Map

- `docs/architecture.md`: target architecture and boundaries.
- `docs/project-plan.md`: phase plan.
- `docs/validation-plan.md`: validation matrix.
- `docs/handoff-template.md`: prompt template for migrating to a new session.
- `docs/mcp-typescript-architecture-research.md`: pre-scaffold stack research.
- `docs/research/hot-reloader-origin-notes.md`: lessons carried from the
  experimental repo.
