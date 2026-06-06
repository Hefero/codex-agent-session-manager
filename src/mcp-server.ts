import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { operationStore } from './tools/operations.js';
import { buildProbePayload, probeInputSchema } from './tools/probe.js';
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

  server.registerResource(
    'operations',
    'codex-session-manager://operations',
    {
      title: 'Operation List',
      description: 'Current in-memory session-manager operations.',
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

