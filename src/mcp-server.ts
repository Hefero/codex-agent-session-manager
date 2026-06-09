import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  buildMcpStatusListPayload,
  buildThreadsListPayload,
  mcpStatusListInputSchema,
  threadsListInputSchema,
} from './tools/app-server.js';
import {
  appServerStatusInputSchema,
  appServerStopInputSchema,
  buildAppServerStatusPayload,
  buildAppServerStopPayload,
} from './tools/app-server-lifecycle.js';
import { appServerStateReadInputSchema, buildAppServerStateReadPayload } from './tools/app-server-state.js';
import { appServerStartInputSchema, buildAppServerStartPayload } from './tools/app-server-start.js';
import {
  buildOperationReadPayload,
  buildOperationWaitPayload,
  operationReadInputSchema,
  operationStore,
  operationWaitInputSchema,
} from './tools/operations.js';
import { buildProbePayload, probeInputSchema } from './tools/probe.js';
import { buildMcpAddNpmPayload, mcpAddNpmInputSchema } from './tools/mcp-add-npm.js';
import { buildMcpRefreshPayload, mcpRefreshInputSchema } from './tools/mcp-refresh.js';
import { buildMcpReloadPayload, mcpReloadInputSchema } from './tools/reload.js';
import { buildSessionClosePayload, sessionCloseInputSchema } from './tools/session-close.js';
import { buildSessionContinuePayload, sessionContinueInputSchema } from './tools/session-continue.js';
import { buildSessionHardRelaunchPayload, sessionHardRelaunchInputSchema } from './tools/session-hard-relaunch.js';
import { buildSessionLaunchPayload, sessionLaunchInputSchema } from './tools/session-launch.js';
import { buildSessionReplacePayload, sessionReplaceInputSchema } from './tools/session-replace.js';
import { buildThreadContextPayload, threadContextInputSchema } from './tools/thread-context.js';
import { packageName, packageVersion } from './version.js';

const instructions = [
  'Agent-facing Codex App Server session manager.',
  'Use tools for selected session operations only; do not treat App Server status alone as callable MCP proof.',
  'For MCP catalog changes, validate with a real tool call from the correct continuation or replacement boundary.',
].join(' ');

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: packageName,
      title: 'Codex Agent Session Manager',
      version: packageVersion,
    },
    {
      instructions,
    },
  );

  server.registerTool(
    'codex_session_manager_probe',
    {
      title: 'Session Manager Probe',
      description: 'Return a stable marker proving this MCP server is callable.',
      inputSchema: probeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ echo }) => {
      const payload = buildProbePayload({ echo });
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_threads_list',
    {
      title: 'List Codex Threads',
      description: 'List loaded Codex App Server thread ids, with optional redacted stored-thread summaries.',
      inputSchema: threadsListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildThreadsListPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_mcp_status_list',
    {
      title: 'List Codex MCP Status',
      description: 'Read App Server MCP status for a thread as diagnostic evidence, not callable proof.',
      inputSchema: mcpStatusListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildMcpStatusListPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_app_server_state_read',
    {
      title: 'Read App Server Launcher State',
      description: 'Read redacted workspace App Server launcher state and report the URL source that session tools would use.',
      inputSchema: appServerStateReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildAppServerStateReadPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_thread_context',
    {
      title: 'Recommend Codex Thread Context',
      description: 'Summarize loaded thread evidence and recommend a target thread without exposing raw thread payloads.',
      inputSchema: threadContextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildThreadContextPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_operation_read',
    {
      title: 'Read Operation',
      description: 'Read a session-manager operation by id.',
      inputSchema: operationReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildOperationReadPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_operation_wait',
    {
      title: 'Wait For Operation',
      description:
        'Wait for a session-manager operation to complete or fail. Do not use this from the same active thread after scheduling a continuation for that thread; finish the turn first so the continuation can observe an idle boundary.',
      inputSchema: operationWaitInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildOperationWaitPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_mcp_add_npm',
      {
        title: 'Add npm MCP Server',
        description: 'Install an npm MCP package locally with lifecycle scripts disabled by default and register a project-scoped .codex/config.toml server block. Callable proof still requires codex_mcp_refresh and a real tool call from the continuation.',
        inputSchema: mcpAddNpmInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const payload = buildMcpAddNpmPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_mcp_reload',
    {
      title: 'Reload Codex MCP Servers',
      description: 'Schedule a Codex App Server MCP reload as a durable operation. Callable proof still requires a later tool call from the right turn/session boundary.',
      inputSchema: mcpReloadInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildMcpReloadPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_mcp_refresh',
    {
      title: 'Reload MCP And Continue',
      description: 'Schedule MCP reload, collect before/after status evidence, then start a continuation turn after the target thread is idle.',
      inputSchema: mcpRefreshInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildMcpRefreshPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_app_server_start',
    {
      title: 'Start Codex App Server',
      description: 'Start or reuse a workspace-managed loopback Codex App Server in the background without launching a TUI.',
      inputSchema: appServerStartInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildAppServerStartPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_app_server_status',
    {
      title: 'Inspect Managed App Server',
      description: 'Inspect workspace-managed App Server launcher state, process liveness, and optional /readyz status.',
      inputSchema: appServerStatusInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = await buildAppServerStatusPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_app_server_stop',
    {
      title: 'Stop Managed App Server',
      description: 'Safely schedule shutdown of the workspace-owned App Server process tree without touching user global MCP config.',
      inputSchema: appServerStopInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildAppServerStopPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_session_continue',
    {
      title: 'Continue Codex Session',
      description:
        'Schedule a continuation turn after the target thread reaches an idle boundary. If targeting the current thread, return after scheduling and let the current turn finish; waiting inside the same turn keeps the target active. Prompt text is never returned in operation evidence.',
      inputSchema: sessionContinueInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildSessionContinuePayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_session_close',
    {
      title: 'Close Codex Remote Session',
      description: 'Safely schedule cleanup of matching Codex remote TUI processes for an explicit threadId without stopping App Server.',
      inputSchema: sessionCloseInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildSessionClosePayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_session_launch',
    {
      title: 'Launch Codex Remote Session',
      description: 'Build or schedule a Codex remote TUI launch against an existing loopback App Server. Does not start App Server in this first cut.',
      inputSchema: sessionLaunchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildSessionLaunchPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_session_hard_relaunch',
    {
      title: 'Hard Relaunch Current Codex TUI',
      description:
        'Experimental escape hatch: find the current Codex TUI process by this MCP server process ancestry, then resume the current thread by default before stopping the old TUI root. Detached mode starts plain Codex in a new terminal. shell-resume-next mode requires the opt-in shell hook and relaunches through codex-agent-session-manager remote in the same terminal. Does not use App Server turn/start directly.',
      inputSchema: sessionHardRelaunchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const payload = buildSessionHardRelaunchPayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    'codex_session_replace',
    {
      title: 'Replace Codex Remote Session',
      description: 'Safely close matching remote TUI processes for an explicit threadId, then relaunch that thread against the same App Server.',
      inputSchema: sessionReplaceInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const payload = buildSessionReplacePayload(input);
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload,
      };
    },
  );

  server.registerResource(
    'operations',
    'codex-session-manager://operations',
    {
      title: 'Operation List',
      description: 'Current session-manager operations.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: jsonText(operationStore.snapshot()),
        },
      ],
    }),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
