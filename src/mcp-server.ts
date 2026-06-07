import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  buildMcpStatusListPayload,
  buildThreadsListPayload,
  mcpStatusListInputSchema,
  threadsListInputSchema,
} from './tools/app-server.js';
import {
  buildOperationReadPayload,
  buildOperationWaitPayload,
  operationReadInputSchema,
  operationStore,
  operationWaitInputSchema,
} from './tools/operations.js';
import { buildProbePayload, probeInputSchema } from './tools/probe.js';
import { buildMcpReloadPayload, mcpReloadInputSchema } from './tools/reload.js';
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
      description: 'Wait for a session-manager operation to complete or fail.',
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
