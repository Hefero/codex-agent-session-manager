import { resolve } from 'node:path';
import { z } from 'zod';

import { connectAppServerClient } from '../app-server/client.js';
import { resolveAppServerUrl } from '../app-server/config.js';
import type { McpServerStatusDetail, McpServerStatusEntry, ThreadListEntry } from '../app-server/protocol.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STORED_LIMIT = 10;
const MAX_STORED_LIMIT = 100;

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. Defaults to CODEX_APP_SERVER_URL or workspace launcher state.');
const timeoutMsSchema = z.number().int().min(1_000).max(120_000).optional().describe('Request timeout in milliseconds.');

export const threadsListInputSchema = {
  appServerUrl: appServerUrlSchema,
  cwd: z.string().min(1).optional().describe('Workspace cwd used to scope stored-thread search. Defaults to process cwd.'),
  includeStored: z.boolean().optional().describe('Also query persisted threads with thread/list for the cwd.'),
  storedLimit: z.number().int().min(1).max(MAX_STORED_LIMIT).optional().describe('Maximum stored threads to return.'),
  searchTerm: z.string().max(300).optional().describe('Optional stored-thread search term. Do not pass secrets.'),
  timeoutMs: timeoutMsSchema,
};

export const mcpStatusListInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).describe('Loaded or persisted Codex thread id to inspect.'),
  detail: z.enum(['toolsAndAuthOnly', 'full']).optional().describe('App Server status detail level.'),
  limit: z.number().int().min(1).max(500).optional().describe('Page size for mcpServerStatus/list.'),
  highlightTools: z.array(z.string().min(1)).max(50).optional().describe('Tool names to flag in the status summary.'),
  timeoutMs: timeoutMsSchema,
};

const threadsListInputObject = z.object(threadsListInputSchema);
const mcpStatusListInputObject = z.object(mcpStatusListInputSchema);

type ThreadsListInput = z.infer<typeof threadsListInputObject>;
type McpStatusListInput = z.infer<typeof mcpStatusListInputObject>;

function normalizedPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsMatch(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || left.length === 0) return false;
  return normalizedPath(left) === normalizedPath(right);
}

function publicPreview(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return redactValue(value.slice(0, 180)) as string;
}

function publicCwdPreview(value: unknown, requestedCwd: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return pathsMatch(value, requestedCwd) ? '<requested-cwd>' : '<path:redacted>';
}

function summarizeStoredThread(entry: ThreadListEntry, requestedCwd: string): Record<string, unknown> {
  const status = entry.status;
  return {
    threadId: typeof entry.id === 'string' ? entry.id : null,
    namePreview: publicPreview(entry.name),
    preview: publicPreview(entry.preview),
    status: status?.type ?? null,
    activeFlags: Array.isArray(status?.activeFlags) ? status.activeFlags : null,
    cwdMatches: pathsMatch(entry.cwd, requestedCwd),
    cwdPreview: publicCwdPreview(entry.cwd, requestedCwd),
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    sourceKind: entry.sourceKind ?? entry.source_kind ?? null,
    ephemeral: entry.ephemeral ?? null,
  };
}

function namesFromCollection(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const name = (entry as Record<string, unknown>).name;
        return typeof name === 'string' ? name : null;
      })
      .filter((name): name is string => name !== null)
      .sort();
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort();
  }
  return [];
}

function summarizeMcpStatus(
  statuses: McpServerStatusEntry[],
  highlightedTools: readonly string[] = [],
): Array<Record<string, unknown>> {
  const highlightSet = new Set(highlightedTools);
  return statuses.map((server) => {
    const toolNames = namesFromCollection(server.tools);
    const resourceNames = namesFromCollection(server.resources);
    const resourceTemplateNames = namesFromCollection(server.resourceTemplates);
    const requestedToolPresence = Object.fromEntries([...highlightSet].map((name) => [name, toolNames.includes(name)]));

    return {
      name: server.name ?? null,
      serverName: server.serverInfo?.name ?? null,
      serverVersion: server.serverInfo?.version ?? null,
      toolCount: toolNames.length,
      resourceCount: resourceNames.length,
      resourceTemplateCount: resourceTemplateNames.length,
      requestedToolPresence,
      toolNames,
      authStatusIncluded: server.authStatus !== undefined,
    };
  });
}

export async function buildThreadsListPayload(input: ThreadsListInput): Promise<Record<string, unknown>> {
  const url = resolveAppServerUrl(input.appServerUrl);
  const cwd = resolve(input.cwd ?? process.cwd());
  const includeStored = input.includeStored ?? false;
  const client = await connectAppServerClient({ url, requestTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  try {
    await client.initialize();
    const loaded = await client.listLoadedThreads();
    const payload: Record<string, unknown> = {
      ok: true,
      appServerUrl: redactSensitiveText(url),
      loadedThreadIds: loaded.threadIds,
      loadedCount: loaded.threadIds.length,
      storedIncluded: includeStored,
    };

    if (includeStored) {
      const storedInput: {
        cwd: string;
        limit: number;
        searchTerm?: string;
      } = {
        cwd,
        limit: input.storedLimit ?? DEFAULT_STORED_LIMIT,
      };
      if (input.searchTerm !== undefined) {
        storedInput.searchTerm = input.searchTerm;
      }
      const stored = await client.listStoredThreads(storedInput);
      payload.storedThreads = stored.threads.map((entry) => summarizeStoredThread(entry, cwd));
      payload.storedCount = stored.threads.length;
    }

    return payload;
  } finally {
    client.close();
  }
}

export async function buildMcpStatusListPayload(input: McpStatusListInput): Promise<Record<string, unknown>> {
  const url = resolveAppServerUrl(input.appServerUrl);
  const client = await connectAppServerClient({ url, requestTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  try {
    await client.initialize();
    const detail: McpServerStatusDetail = input.detail ?? 'toolsAndAuthOnly';
    const statusInput: {
      threadId: string;
      detail: McpServerStatusDetail;
      limit?: number;
    } = {
      threadId: input.threadId,
      detail,
    };
    if (input.limit !== undefined) {
      statusInput.limit = input.limit;
    }
    const result = await client.listMcpServerStatuses(statusInput);

    return {
      ok: true,
      diagnosticOnly: true,
      nextAction:
        'Use this status as diagnostic evidence only; callable MCP proof requires a real model-callable tool invocation from the correct turn/session boundary.',
      appServerUrl: redactSensitiveText(url),
      threadId: input.threadId,
      detail,
      pageCount: result.pageCount,
      serverCount: result.statuses.length,
      servers: summarizeMcpStatus(result.statuses, input.highlightTools),
    };
  } finally {
    client.close();
  }
}
