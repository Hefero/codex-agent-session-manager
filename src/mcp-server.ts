import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { errorPayload } from './errors.js';
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
import { buildGuidancePayload, guidanceInputSchema, guidanceResources } from './tools/guidance.js';
import { buildGlobalMcpAddNpmPayload, buildGlobalMcpRemovePayload, globalMcpAddNpmInputSchema, globalMcpRemoveInputSchema } from './tools/global-mcp-npm.js';
import { buildLocalMcpAddNpmPayload, localMcpAddNpmInputSchema } from './tools/mcp-add-npm.js';
import { buildMcpCleanupReportPayload, mcpCleanupReportInputSchema } from './tools/mcp-report.js';
import { buildMcpRefreshPayload, mcpRefreshInputSchema } from './tools/mcp-refresh.js';
import { buildLocalMcpRemovePayload, localMcpRemoveInputSchema } from './tools/mcp-remove.js';
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
  'Call codex_session_manager_help when you need operational guidance; do not rely on project AGENTS.md guidance.',
  'Use tools for selected session operations only; do not treat App Server status alone as callable MCP proof.',
  'For MCP catalog changes, validate with a real tool call from the correct continuation or replacement boundary.',
].join(' ');

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolResult(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: jsonText(payload) }],
    structuredContent: payload,
  };
}

async function safeToolCall(
  toolName: string,
  buildPayload: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<ReturnType<typeof toolResult>> {
  try {
    return toolResult(await buildPayload());
  } catch (error) {
    return toolResult(errorPayload(error, { tool: toolName }));
  }
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
    'codex_session_manager_help',
    {
      title: 'Session Manager Help',
      description:
        'Return concise operational guidance for this MCP server. Use this when unsure which session, reload, refresh, npm MCP install, or safety workflow to follow.',
      inputSchema: guidanceInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_session_manager_help', () => buildGuidancePayload(input)),
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
    async ({ echo }) => safeToolCall('codex_session_manager_probe', () => buildProbePayload({ echo })),
  );

  server.registerTool(
    'codex_threads_list',
    {
      title: 'List Codex Threads',
      description:
        'List loaded Codex App Server thread ids, with optional redacted stored-thread summaries. Use before mutating session operations when the target thread id is unknown.',
      inputSchema: threadsListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_threads_list', () => buildThreadsListPayload(input)),
  );

  server.registerTool(
    'codex_mcp_status_list',
    {
      title: 'List Codex MCP Status',
      description:
        'Read App Server MCP status for a thread as diagnostic evidence only. This can show server/tool registration after reload, but final proof still requires a real model-callable tool call.',
      inputSchema: mcpStatusListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_mcp_status_list', () => buildMcpStatusListPayload(input)),
  );

  server.registerTool(
    'codex_app_server_state_read',
    {
      title: 'Read App Server Launcher State',
      description:
        'Read redacted workspace App Server launcher state and report which loopback URL source session tools would use. Does not start, stop, or probe MCP callability.',
      inputSchema: appServerStateReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_app_server_state_read', () => buildAppServerStateReadPayload(input)),
  );

  server.registerTool(
    'codex_thread_context',
    {
      title: 'Recommend Codex Thread Context',
      description:
        'Summarize loaded-thread evidence and recommend a target thread without exposing raw thread payloads. Prefer this over guessing when multiple threads or stale windows exist.',
      inputSchema: threadContextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_thread_context', () => buildThreadContextPayload(input)),
  );

  server.registerTool(
    'codex_operation_read',
    {
      title: 'Read Operation',
      description:
        'Read a session-manager operation by id. Use from a later turn or different thread; do not use it to keep the same target thread active while waiting for its continuation.',
      inputSchema: operationReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_operation_read', () => buildOperationReadPayload(input)),
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
    async (input) => safeToolCall('codex_operation_wait', () => buildOperationWaitPayload(input)),
  );

  server.registerTool(
    'codex_local_mcp_add_npm',
    {
      title: 'Add Project-Local npm MCP Server',
      description:
        'Install an npm MCP package into this project, disabling lifecycle scripts by default, and register a project-scoped .codex/config.toml server block. Stores env var names only. After install, use codex_mcp_refresh and prove success with a real call to the new MCP tool.',
      inputSchema: localMcpAddNpmInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safeToolCall('codex_local_mcp_add_npm', () => buildLocalMcpAddNpmPayload(input)),
  );

  server.registerTool(
    'codex_local_mcp_remove',
    {
      title: 'Remove Project-Local Managed MCP Server',
      description:
        'Remove a project-scoped MCP server block created by codex_local_mcp_add_npm. Defaults to dry-run and only removes managed blocks. Set uninstallPackage:true to also uninstall the inferred npm package when no other managed MCP block still references it. After removal, use codex_mcp_refresh and validate that the removed namespace is absent.',
      inputSchema: localMcpRemoveInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safeToolCall('codex_local_mcp_remove', () => buildLocalMcpRemovePayload(input)),
  );

  server.registerTool(
    'codex_global_mcp_add_npm',
    {
      title: 'Add User-Global npm MCP Server',
      description:
        'Install an npm MCP package into an isolated user-global runtime and register a marked ~/.codex/config.toml server block. Defaults to dry-run, disables lifecycle scripts by default, stores env var names only, and affects Codex sessions outside the current project until removed.',
      inputSchema: globalMcpAddNpmInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safeToolCall('codex_global_mcp_add_npm', () => buildGlobalMcpAddNpmPayload(input)),
  );

  server.registerTool(
    'codex_global_mcp_remove',
    {
      title: 'Remove User-Global Managed MCP Server',
      description:
        'Remove a user-global MCP server block created by codex_global_mcp_add_npm. Defaults to dry-run and only removes managed blocks. Set uninstallPackage:true to also remove the isolated package directory.',
      inputSchema: globalMcpRemoveInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safeToolCall('codex_global_mcp_remove', () => buildGlobalMcpRemovePayload(input)),
  );

  server.registerTool(
    'codex_mcp_cleanup_report',
    {
      title: 'Report Managed MCP Cleanup State',
      description:
        'Inspect managed project-local and user-global MCP config/package cleanup state, plus recent durable operations. Read-only; does not prove App Server callable catalog state.',
      inputSchema: mcpCleanupReportInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_mcp_cleanup_report', () => buildMcpCleanupReportPayload(input)),
  );

  server.registerTool(
    'codex_mcp_reload',
    {
      title: 'Reload Codex MCP Servers',
      description:
        'Schedule a Codex App Server MCP process reload as a durable operation. This refreshes server processes but does not prove the current model-callable catalog changed.',
      inputSchema: mcpReloadInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_mcp_reload', () => buildMcpReloadPayload(input)),
  );

  server.registerTool(
    'codex_mcp_refresh',
    {
      title: 'Reload MCP And Continue',
      description:
        'Schedule MCP reload, collect before/after status evidence, then start a continuation turn after the target thread is idle. Prefer this after MCP config/tool/schema changes.',
      inputSchema: mcpRefreshInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_mcp_refresh', () => buildMcpRefreshPayload(input)),
  );

  server.registerTool(
    'codex_app_server_start',
    {
      title: 'Start Codex App Server',
      description:
        'Start or reuse a workspace-managed loopback Codex App Server in the background without launching a TUI. Use before session tools that need a managed App Server URL.',
      inputSchema: appServerStartInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_app_server_start', () => buildAppServerStartPayload(input)),
  );

  server.registerTool(
    'codex_app_server_status',
    {
      title: 'Inspect Managed App Server',
      description:
        'Inspect workspace-managed App Server launcher state, process liveness, and optional /readyz status. Diagnostic only; does not prove MCP callability.',
      inputSchema: appServerStatusInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_app_server_status', () => buildAppServerStatusPayload(input)),
  );

  server.registerTool(
    'codex_app_server_stop',
    {
      title: 'Stop Managed App Server',
      description:
        'Safely schedule shutdown of the workspace-owned App Server process tree. With appServerUrl plus force:true, can stop a loopback Codex App Server reused by this workspace. Dry-run first unless the operator explicitly asked to stop it.',
      inputSchema: appServerStopInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_app_server_stop', () => buildAppServerStopPayload(input)),
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
    async (input) => safeToolCall('codex_session_continue', () => buildSessionContinuePayload(input)),
  );

  server.registerTool(
    'codex_session_close',
    {
      title: 'Close Codex Remote Session',
      description:
        'Safely schedule cleanup of matching Codex remote TUI processes for an explicit threadId without stopping App Server. Use for stale remote windows, not for MCP callable proof.',
      inputSchema: sessionCloseInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_session_close', () => buildSessionClosePayload(input)),
  );

  server.registerTool(
    'codex_session_launch',
    {
      title: 'Launch Codex Remote Session',
      description:
        'Build or schedule a Codex remote TUI launch against an existing loopback App Server. Use codex_app_server_start first if no managed App Server is active.',
      inputSchema: sessionLaunchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_session_launch', () => buildSessionLaunchPayload(input)),
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
    async (input) => safeToolCall('codex_session_hard_relaunch', () => buildSessionHardRelaunchPayload(input)),
  );

  server.registerTool(
    'codex_session_replace',
    {
      title: 'Replace Codex Remote Session',
      description:
        'Safely close matching remote TUI processes for an explicit threadId, then relaunch that thread against the same App Server. Use as a harder fallback when continuation-only refresh is stale.',
      inputSchema: sessionReplaceInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safeToolCall('codex_session_replace', () => buildSessionReplacePayload(input)),
  );

  for (const resource of guidanceResources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: resource.text,
          },
        ],
      }),
    );
  }

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
