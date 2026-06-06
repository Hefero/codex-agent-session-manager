# MCP TypeScript Architecture Research

Status: pre-scaffold research
Date: 2026-06-06

## Decision

Start `codex-agent-session-manager` in TypeScript, ESM, and Node, not plain
`.mjs`.

The previous `codex-mcp-hot-reloader` stayed in plain ESM because it was a small
experimental helper. The new project is not small in the same way. It is an
agent-facing session manager for Codex App Server, with MCP tools, operation
state, validation evidence, process/session lifecycle controls, and safety
boundaries. Those contracts are large enough that compile-time structure is
worth the setup cost.

## Source Findings

### Official MCP SDK

The official MCP TypeScript SDK is a Tier 1 SDK and is explicitly designed for
building servers and clients with tools, resources, prompts, stdio, and
Streamable HTTP transports:

- https://modelcontextprotocol.io/docs/sdk
- https://ts.sdk.modelcontextprotocol.io/

The SDK uses `McpServer`, `registerTool`, `registerResource`,
`registerPrompt`, `StdioServerTransport`, and Streamable HTTP. It has a required
Zod peer dependency for schema validation. The server docs also describe
structured tool output, tool list change notifications, resources, prompts,
completions, logging, and DNS rebinding protection for localhost HTTP servers:

- https://ts.sdk.modelcontextprotocol.io/documents/server.html

Implication: the base implementation should use `@modelcontextprotocol/sdk`
directly, with Zod schemas as the source of truth for tool inputs.

### MCP Semantics

MCP separates host, client, and server. Hosts manage clients and security
policy; each MCP client has a 1:1 stateful connection to a server; servers
expose focused resources, tools, and prompts:

- https://modelcontextprotocol.io/specification/2025-06-18/architecture
- https://modelcontextprotocol.io/docs/learn/architecture
- https://modelcontextprotocol.io/docs/learn/server-concepts

The protocol distinguishes:

- Tools: model-controlled actions.
- Resources: application-controlled read-only context.
- Prompts: user-controlled templates.

Implication: session operations such as launch, continue, close, reload, and
replace should be tools; durable logs, operation details, thread inventories,
and validation evidence should also be exposed as resources.

### Codex App Server

Codex App Server is Codex's JSON-RPC 2.0 control plane for rich clients. It
exposes thread and turn primitives, streamed events, auth, approvals, MCP server
reload/status, thread listing, loaded-thread listing, `turn/start`,
`turn/steer`, and experimental APIs:

- https://developers.openai.com/codex/app-server

Important design points from the official docs:

- The client must `initialize` and then send `initialized` before other calls.
- `thread/start`, `thread/resume`, and `turn/start` are the core control path.
- `config/mcpServer/reload` reloads MCP server configuration and queues a
  refresh for loaded threads.
- `mcpServerStatus/list` reports MCP servers, tools, resources, and auth status.
- App Server can generate version-specific TypeScript or JSON Schema artifacts:
  `codex app-server generate-ts --out ./schemas`.

Implication: the new project should generate or vendor local App Server protocol
types during development, then wrap only selected App Server methods as safe MCP
tools. It should not expose a raw "call arbitrary App Server method" tool.

### Codex MCP Configuration

Codex supports stdio and Streamable HTTP MCP servers, reads `instructions` from
MCP initialization, supports project-scoped `.codex/config.toml`, and can
configure approval modes, allow/deny tool lists, timeouts, OAuth, and HTTP
headers:

- https://developers.openai.com/codex/mcp

Implication: our MCP server should include concise server instructions for
cross-tool workflow rules, but the high-risk decisions still belong in tool
schemas, implementation guards, and validations.

### Public Projects Nearby

`@agentrq/codex-gateway` bridges an AgentRQ MCP workspace to `codex app-server`.
It is TypeScript, spawns `codex app-server`, initializes JSON-RPC, maps external
tasks to Codex threads/turns, and streams assistant output back:

- https://agentrq.com/docs/connect-codex-gateway
- https://github.com/agentrq/codex-gateway

This is the closest public architecture found so far for "external manager
driving Codex App Server", but it is a gateway between AgentRQ and Codex. It is
not an agent-facing MCP server that lets the Codex agent manage its own Codex
session environment.

`mcp-codex-worker@1.0.34` is a TypeScript npm package that exposes Codex task
orchestration through MCP. Its published package uses:

- TypeScript + ESM.
- `@modelcontextprotocol/sdk`.
- Zod tool schemas.
- `tsx` for dev/smoke.
- file-backed task state and resources.
- task tools such as spawn, wait, respond, message, and cancel.

Useful patterns:

- `operation_id` / task ID style handles.
- explicit state machine.
- `wait` + `respond` loop.
- resources for scoreboard, details, summary logs, verbose logs, and raw events.
- "what to do next" guidance returned from tools.

Rejected or deferred patterns:

- unconditional auto-approval.
- relying on API key auth as the normal path.
- treating the project primarily as a subagent worker.

### Local AppBuilder/Jitterbit Evidence

The AppBuilder MCP ecosystem already converged on TypeScript, Zod, shared tool
definitions, typed MCP results, runtime readbacks, and evidence-first workflow.
Relevant local references:

- `C:\Users\Guilherme\Documents\Claude\Jitterbit-driver\AGENTS.md`
- `C:\Users\Guilherme\Documents\Claude\appbuilder-mcp-common\docs\architecture\README.md`
- `C:\Users\Guilherme\Documents\Claude\appbuilder-mcp-common\docs\architecture\agent-operating-model.md`
- `C:\Users\Guilherme\Documents\Claude\appbuilder-mcp-common\src\tool-definition.ts`

Useful patterns:

- keep domain tools focused;
- resolve context before mutation;
- retrieve/read before guessing;
- plan proof before mutation;
- validate by readback/runtime behavior;
- use resources/logs for durable evidence;
- keep reusable tool definitions host-agnostic where possible;
- put diagnostics on stderr, not stdout, for stdio MCP servers.

## Recommended Stack

- Runtime: Node ESM.
- Language: TypeScript.
- MCP SDK: `@modelcontextprotocol/sdk`.
- Schema: Zod, preferably Zod v4-compatible imports where the SDK expects them.
- Dev runner: `tsx`.
- Build: `tsc -p tsconfig.json`.
- Tests: Node test runner or Vitest. Start with Node test runner if no
  snapshot/fixture complexity appears; switch to Vitest if protocol fixtures
  become easier that way.
- Formatting/linting: defer heavy lint until the first implementation pass
  stabilizes; use TypeScript strictness first.

Initial scripts:

```json
{
  "build": "tsc -p tsconfig.json",
  "check": "tsc --noEmit",
  "serve": "node --import tsx src/mcp-server.ts",
  "smoke": "node --import tsx scripts/smoke.ts",
  "test": "node --import tsx --test test/**/*.test.ts"
}
```

## Initial Architecture

Use the official SDK directly first. Do not start with FastMCP or MCP Framework
as a dependency.

Rationale:

- Our hard part is App Server lifecycle, timing, stale callable catalogs,
  process/session ownership, and validation evidence.
- High-level MCP frameworks optimize generic MCP server ergonomics.
- Framework auto-discovery is attractive, but this project needs explicit
  ordering, explicit tool naming, and tight safety review more than minimal
  boilerplate.
- FastMCP and MCP Framework remain useful references for ergonomics, session
  context, auth, and transport patterns.

Proposed layout:

```text
src/
  cli.ts
  mcp-server.ts
  app-server/
    client.ts
    protocol.ts
    schemas/
  operations/
    store.ts
    types.ts
    resources.ts
  tools/
    reload.ts
    continue.ts
    thread-context.ts
    launch.ts
    close.ts
    replace.ts
  validation/
    callable-proof.ts
    matrix.ts
  security/
    redaction.ts
    url.ts
    cwd.ts
scripts/
  smoke.ts
  generate-app-server-schema.ts
test/
  *.test.ts
```

## Tool Contract Pattern

Each tool should have:

- stable name;
- short model-facing description;
- Zod input schema;
- explicit annotations;
- handler;
- typed result builder;
- focused unit/smoke coverage;
- validation proof expectation when it mutates runtime state.

Avoid generic "do anything" tools. Prefer small operations:

- `codex_threads_list`
- `codex_thread_context`
- `codex_session_continue`
- `codex_mcp_reload`
- `codex_session_launch`
- `codex_session_close`
- `codex_session_replace`
- `codex_operation_wait`
- `codex_operation_read`

## Resource Pattern

Expose durable state as MCP resources:

- `codex-session-manager://operations`
- `codex-session-manager://operations/{id}`
- `codex-session-manager://operations/{id}/log`
- `codex-session-manager://threads/loaded`
- `codex-session-manager://validation/matrix`

This matches MCP's resource semantics and lets agents inspect evidence without
rerunning side-effectful tools.

## Security Baseline

Use MCP security guidance as a design constraint:

- local MCP commands are privileged local code;
- prefer stdio for local private servers;
- restrict HTTP listeners to loopback and protect against DNS rebinding when
  adding HTTP;
- validate every input server-side;
- redact secrets, prompts, tokens, and sensitive paths in logs and previews;
- reject non-loopback App Server URLs unless an explicit future remote mode is
  designed;
- require confirmation fields for stop/close/replace operations;
- never expose a raw App Server JSON-RPC proxy tool.

Sources:

- https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

## Open Questions

- Whether to generate App Server protocol types on install, on build, or as a
  checked-in schema snapshot.
- Whether `codex-agent-session-manager` should expose only stdio MCP at first,
  or also a loopback Streamable HTTP mode.
- Whether to keep a CLI in the same package or split it later.
- Whether to build a small human preloader UI after the core agent-facing MCP
  tools stabilize.

## Recommendation For Scaffold

Start TypeScript now.

Use the official MCP SDK directly, Zod schemas, typed App Server client
wrappers, explicit operation state, and MCP resources for logs/evidence. Keep
FastMCP, MCP Framework, `mcp-codex-worker`, and `codex-gateway` as references,
not foundations.

