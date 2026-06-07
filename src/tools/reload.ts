import { spawn } from 'node:child_process';
import { z } from 'zod';

import { connectAppServerClient } from '../app-server/client.js';
import { resolveAppServerUrl } from '../app-server/config.js';
import type { McpServerStatusEntry } from '../app-server/protocol.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const INTERNAL_COMMAND = 'run-mcp-reload-operation';
const RELOAD_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then codex_operation_read for final evidence.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

export const mcpReloadInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).optional().describe('Optional loaded Codex thread id for before/after MCP status evidence.'),
  highlightTools: z.array(z.string().min(1)).max(50).optional().describe('Tool names to flag in optional status summaries.'),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().describe('App Server request timeout in milliseconds.'),
};

const mcpReloadInputObject = z.object(mcpReloadInputSchema);
type McpReloadInput = z.infer<typeof mcpReloadInputObject>;

export interface McpReloadOperationInput {
  operationId: string;
  appServerUrl: string;
  threadId?: string;
  highlightTools?: string[];
  timeoutMs?: number;
}

export interface BackgroundScheduleEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesSecrets: false;
}

export interface McpReloadClient {
  initialize(): Promise<unknown>;
  reloadMcpServers(): Promise<unknown>;
  listMcpServerStatuses(input: { threadId: string; limit?: number }): Promise<{
    statuses: McpServerStatusEntry[];
    pageCount: number;
  }>;
  close(): void;
}

export type McpReloadClientFactory = (options: { url: string; requestTimeoutMs?: number }) => Promise<McpReloadClient>;
export type McpReloadScheduler = (input: McpReloadOperationInput) => BackgroundScheduleEvidence;

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

function summarizeMcpStatus(statuses: McpServerStatusEntry[], highlightedTools: readonly string[] = []): Array<Record<string, unknown>> {
  const highlightSet = new Set(highlightedTools);
  return statuses.map((server) => {
    const toolNames = namesFromCollection(server.tools);
    return {
      name: server.name ?? null,
      serverName: server.serverInfo?.name ?? null,
      serverVersion: server.serverInfo?.version ?? null,
      toolCount: toolNames.length,
      requestedToolPresence: Object.fromEntries([...highlightSet].map((name) => [name, toolNames.includes(name)])),
      authStatusIncluded: server.authStatus !== undefined,
    };
  });
}

async function collectStatusEvidence(
  client: McpReloadClient,
  input: { threadId?: string; highlightTools?: string[] },
): Promise<Record<string, unknown> | null> {
  if (input.threadId === undefined) return null;
  const result = await client.listMcpServerStatuses({ threadId: input.threadId, limit: 100 });
  return {
    threadId: input.threadId,
    pageCount: result.pageCount,
    serverCount: result.statuses.length,
    servers: summarizeMcpStatus(result.statuses, input.highlightTools),
  };
}

function requestedEvidence(input: {
  appServerUrl: string;
  threadId?: string | undefined;
  highlightTools?: string[] | undefined;
  timeoutMs?: number | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: redactSensitiveText(input.appServerUrl),
    threadId: input.threadId ?? null,
    highlightTools: input.highlightTools ?? [],
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    statusEvidenceRequested: input.threadId !== undefined,
  };
}

function publicFailure(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveText(error.message),
    };
  }
  return redactValue(String(error));
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  threadId?: string | undefined;
  highlightTools?: string[] | undefined;
  timeoutMs?: number | undefined;
}): McpReloadOperationInput {
  const operationInput: McpReloadOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
  };
  if (input.threadId !== undefined) {
    operationInput.threadId = input.threadId;
  }
  if (input.highlightTools !== undefined) {
    operationInput.highlightTools = input.highlightTools;
  }
  if (input.timeoutMs !== undefined) {
    operationInput.timeoutMs = input.timeoutMs;
  }
  return operationInput;
}

export function buildMcpReloadOperationArgs(input: McpReloadOperationInput): string[] {
  const args = [INTERNAL_COMMAND, '--operation-id', input.operationId, '--app-server-url', input.appServerUrl];
  if (input.threadId !== undefined) {
    args.push('--thread-id', input.threadId);
  }
  for (const toolName of input.highlightTools ?? []) {
    args.push('--highlight-tool', toolName);
  }
  if (input.timeoutMs !== undefined) {
    args.push('--timeout-ms', String(input.timeoutMs));
  }
  return args;
}

export function parseMcpReloadOperationArgs(argv: readonly string[]): McpReloadOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let threadId: string | undefined;
  let timeoutMs: number | undefined;
  const highlightTools: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--operation-id' && value !== undefined) {
      operationId = value;
      index += 1;
    } else if (arg === '--app-server-url' && value !== undefined) {
      appServerUrl = value;
      index += 1;
    } else if (arg === '--thread-id' && value !== undefined) {
      threadId = value;
      index += 1;
    } else if (arg === '--highlight-tool' && value !== undefined) {
      highlightTools.push(value);
      index += 1;
    } else if (arg === '--timeout-ms' && value !== undefined) {
      timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!appServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --app-server-url.`);
  return operationInputForOptionalValues({
    operationId,
    appServerUrl: resolveAppServerUrl(appServerUrl),
    threadId,
    highlightTools: highlightTools.length > 0 ? highlightTools : undefined,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });
}

export function spawnMcpReloadOperation(input: McpReloadOperationInput): BackgroundScheduleEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule MCP reload operation because the current CLI entry path is unavailable.');
  }

  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildMcpReloadOperationArgs(input)], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  child.unref();

  return {
    scheduled: true,
    pid: child.pid ?? null,
    detached: true,
    windowsHide: true,
    internalCommand: INTERNAL_COMMAND,
    argvIncludesSecrets: false,
  };
}

export function buildMcpReloadPayload(
  input: McpReloadInput,
  deps: {
    store?: OperationStore;
    scheduler?: McpReloadScheduler;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnMcpReloadOperation;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    highlightTools: input.highlightTools,
    timeoutMs: input.timeoutMs,
  });

  const operation = store.create({
    kind: 'mcp_reload',
    status: 'running',
    evidence: { requested },
    nextAction: RELOAD_NEXT_ACTION,
  });

  try {
    const background = scheduler(
      operationInputForOptionalValues({
        operationId: operation.id,
        appServerUrl,
        threadId: input.threadId,
        highlightTools: input.highlightTools,
        timeoutMs: input.timeoutMs,
      }),
    );
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, background },
        nextAction: RELOAD_NEXT_ACTION,
      }) ?? operation;

    return {
      ok: true,
      operationId: operation.id,
      operation: updatedOperation,
      background,
    };
  } catch (error) {
    store.fail(operation.id, {
      failure: publicFailure(error),
      evidence: { requested, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

export async function runMcpReloadOperation(
  input: McpReloadOperationInput,
  deps: {
    store?: OperationStore;
    connectClient?: McpReloadClientFactory;
  } = {},
): Promise<OperationRecord | null> {
  const store = deps.store ?? operationStore;
  const connectClient = deps.connectClient ?? connectAppServerClient;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    highlightTools: input.highlightTools,
    timeoutMs: input.timeoutMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);

  let client: McpReloadClient | null = null;
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };
  try {
    const clientOptions: { url: string; requestTimeoutMs?: number } = { url: appServerUrl };
    if (input.timeoutMs !== undefined) {
      clientOptions.requestTimeoutMs = input.timeoutMs;
    }
    client = await connectClient(clientOptions);
    await client.initialize();

    const statusBefore = await collectStatusEvidence(client, input);
    if (statusBefore) {
      evidence.statusBefore = statusBefore;
    }

    await client.reloadMcpServers();
    evidence.reload = { requested: true };

    const statusAfter = await collectStatusEvidence(client, input);
    if (statusAfter) {
      evidence.statusAfter = statusAfter;
    }

    return store.complete(input.operationId, {
      evidence,
      nextAction: 'Reload requested. Use a continuation or fresh replacement session for callable MCP proof.',
    });
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error),
      evidence,
      nextAction: 'Inspect failure details with codex_operation_read before retrying.',
    });
  } finally {
    client?.close();
  }
}

export async function runMcpReloadOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runMcpReloadOperation(parseMcpReloadOperationArgs(argv));
}
