# ADR-001: TypeScript MCP And App Server Foundation

Status: Accepted
Date: 2026-06-06

## Context

The experimental repo used plain Node ESM because the original problem was a
small hot-reload helper. The new project is broader: it wraps selected Codex App
Server operations as agent-callable MCP tools and needs durable operation state,
typed schemas, validation evidence, and security guardrails.

The official MCP TypeScript SDK is a Tier 1 SDK, uses Zod, and exposes the
server/client primitives this project needs. Codex App Server can generate
version-specific TypeScript schemas. Nearby projects such as `codex-gateway`
and `mcp-codex-worker` are also TypeScript.

## Decision

Use TypeScript, Node ESM, `@modelcontextprotocol/sdk`, and Zod from the start.

Use the official MCP SDK directly for the initial implementation. Treat FastMCP
and MCP Framework as references for ergonomics, not as foundation dependencies.

## Consequences

- Tool input schemas are Zod-first.
- App Server protocol wrappers should be typed.
- Compile-time checks become part of the required validation path.
- The first scaffold stays small but executable.
- The project avoids framework auto-discovery until the operation surface is
  stable enough to justify it.

