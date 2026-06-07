import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';

import { connectAppServerClient } from '../app-server/client.js';
import { resolveAppServerUrl } from '../app-server/config.js';
import type { McpServerStatusEntry } from '../app-server/protocol.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';
import { waitForThreadIdle, type SessionContinueClient } from './session-continue.js';

const DEFAULT_PROMPT = 'Codex MCP refresh turn. Refresh callable tool context and continue validation.';
const REFRESH_PROMPT_ENV = 'CODEX_AGENT_SESSION_MANAGER_MCP_REFRESH_PROMPT';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONTINUATION_TIMEOUT_MS = 180_000;
const DEFAULT_CONTINUATION_POLL_MS = 1_000;
const DEFAULT_CONTINUATION_STABLE_MS = 0;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONTINUATION_TIMEOUT_MS = 300_000;
const MIN_CONTINUATION_POLL_MS = 100;
const MAX_CONTINUATION_POLL_MS = 10_000;
const MAX_CONTINUATION_STABLE_MS = 10_000;
const MAX_PROMPT_CHARS = 4_000;
const INTERNAL_COMMAND = 'run-mcp-refresh-operation';
const REFRESH_NEXT_ACTION = 'Let the current turn finish. The background operation waits for the target thread to become idle, starts the continuation, and only that continuation can provide final callable proof by calling the changed MCP tool.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

export const mcpRefreshInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).describe('Explicit target Codex thread id for MCP status evidence and continuation.'),
  prompt: z
    .string()
    .max(MAX_PROMPT_CHARS)
    .optional()
    .describe('Continuation prompt text. It is passed to the child via environment, never argv or operation evidence.'),
  highlightTools: z.array(z.string().min(1)).max(50).optional().describe('Tool names to flag in before/after MCP status summaries.'),
  timeoutMs: z.number().int().min(1_000).max(MAX_REQUEST_TIMEOUT_MS).optional().describe('App Server request timeout in milliseconds.'),
  continuationTimeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTINUATION_TIMEOUT_MS)
    .optional()
    .describe('Maximum time to wait for target thread idle/stable before turn/start.'),
  continuationPollMs: z
    .number()
    .int()
    .min(MIN_CONTINUATION_POLL_MS)
    .max(MAX_CONTINUATION_POLL_MS)
    .optional()
    .describe('Thread status polling interval in milliseconds.'),
  continuationStableMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTINUATION_STABLE_MS)
    .optional()
    .describe('Extra idle stability window before turn/start.'),
};

const mcpRefreshInputObject = z.object(mcpRefreshInputSchema);
type McpRefreshInput = z.infer<typeof mcpRefreshInputObject>;

export interface McpRefreshOperationInput {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  highlightTools?: string[];
  timeoutMs?: number;
  continuationTimeoutMs?: number;
  continuationPollMs?: number;
  continuationStableMs?: number;
}

export interface McpRefreshBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesPrompt: false;
  promptTransport: 'environment';
}

export interface McpRefreshClient extends SessionContinueClient {
  reloadMcpServers(): Promise<unknown>;
  listMcpServerStatuses(input: { threadId: string; limit?: number }): Promise<{
    statuses: McpServerStatusEntry[];
    pageCount: number;
  }>;
}

export type McpRefreshClientFactory = (options: { url: string; requestTimeoutMs?: number }) => Promise<McpRefreshClient>;
export type McpRefreshScheduler = (input: McpRefreshOperationInput, prompt: string) => McpRefreshBackgroundEvidence;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
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
  client: McpRefreshClient,
  input: { threadId: string; highlightTools?: string[] },
): Promise<Record<string, unknown>> {
  const result = await client.listMcpServerStatuses({ threadId: input.threadId, limit: 100 });
  return {
    threadId: input.threadId,
    pageCount: result.pageCount,
    serverCount: result.statuses.length,
    servers: summarizeMcpStatus(result.statuses, input.highlightTools),
  };
}

function redactRefreshPrompt(text: string, promptToRedact: string | undefined): string {
  const redacted = redactSensitiveText(text);
  if (promptToRedact === undefined || promptToRedact.length === 0) return redacted;
  return redacted.split(promptToRedact).join('<redacted:mcp-refresh-prompt>');
}

function publicFailure(error: unknown, promptToRedact?: string): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactRefreshPrompt(error.message, promptToRedact),
    };
  }
  return redactRefreshPrompt(String(redactValue(String(error))), promptToRedact);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function requestedEvidence(input: {
  appServerUrl: string;
  threadId: string;
  prompt: string;
  highlightTools?: string[] | undefined;
  timeoutMs?: number | undefined;
  continuationTimeoutMs?: number | undefined;
  continuationPollMs?: number | undefined;
  continuationStableMs?: number | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: redactSensitiveText(input.appServerUrl),
    threadId: input.threadId,
    promptProvided: input.prompt.length > 0,
    promptCharCount: input.prompt.length,
    promptTransport: 'environment',
    highlightTools: input.highlightTools ?? [],
    cwdPreview: '<workspace>',
    timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    continuationTimeoutMs: input.continuationTimeoutMs ?? DEFAULT_CONTINUATION_TIMEOUT_MS,
    continuationPollMs: input.continuationPollMs ?? DEFAULT_CONTINUATION_POLL_MS,
    continuationStableMs: input.continuationStableMs ?? DEFAULT_CONTINUATION_STABLE_MS,
    statusEvidenceRequested: true,
  };
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  highlightTools?: string[] | undefined;
  timeoutMs?: number | undefined;
  continuationTimeoutMs?: number | undefined;
  continuationPollMs?: number | undefined;
  continuationStableMs?: number | undefined;
}): McpRefreshOperationInput {
  const operationInput: McpRefreshOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
  };
  if (input.highlightTools !== undefined) operationInput.highlightTools = input.highlightTools;
  if (input.timeoutMs !== undefined) operationInput.timeoutMs = input.timeoutMs;
  if (input.continuationTimeoutMs !== undefined) operationInput.continuationTimeoutMs = input.continuationTimeoutMs;
  if (input.continuationPollMs !== undefined) operationInput.continuationPollMs = input.continuationPollMs;
  if (input.continuationStableMs !== undefined) operationInput.continuationStableMs = input.continuationStableMs;
  return operationInput;
}

function promptFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const prompt = env[REFRESH_PROMPT_ENV] ?? DEFAULT_PROMPT;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`MCP refresh prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return prompt;
}

function childEnvWithPrompt(prompt: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[REFRESH_PROMPT_ENV];
  env[REFRESH_PROMPT_ENV] = prompt;
  return env;
}

export function buildMcpRefreshOperationArgs(input: McpRefreshOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--app-server-url',
    input.appServerUrl,
    '--thread-id',
    input.threadId,
  ];
  for (const toolName of input.highlightTools ?? []) {
    args.push('--highlight-tool', toolName);
  }
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.continuationTimeoutMs !== undefined) args.push('--continuation-timeout-ms', String(input.continuationTimeoutMs));
  if (input.continuationPollMs !== undefined) args.push('--continuation-poll-ms', String(input.continuationPollMs));
  if (input.continuationStableMs !== undefined) args.push('--continuation-stable-ms', String(input.continuationStableMs));
  return args;
}

export function parseMcpRefreshOperationArgs(argv: readonly string[]): McpRefreshOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let threadId: string | undefined;
  let timeoutMs: number | undefined;
  let continuationTimeoutMs: number | undefined;
  let continuationPollMs: number | undefined;
  let continuationStableMs: number | undefined;
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
    } else if (arg === '--continuation-timeout-ms' && value !== undefined) {
      continuationTimeoutMs = Number(value);
      index += 1;
    } else if (arg === '--continuation-poll-ms' && value !== undefined) {
      continuationPollMs = Number(value);
      index += 1;
    } else if (arg === '--continuation-stable-ms' && value !== undefined) {
      continuationStableMs = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!appServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --app-server-url.`);
  if (!threadId) throw new Error(`${INTERNAL_COMMAND} requires --thread-id.`);

  return operationInputForOptionalValues({
    operationId,
    appServerUrl: resolveAppServerUrl(appServerUrl),
    threadId,
    highlightTools: highlightTools.length > 0 ? highlightTools : undefined,
    timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    continuationTimeoutMs: typeof continuationTimeoutMs === 'number' && Number.isFinite(continuationTimeoutMs)
      ? continuationTimeoutMs
      : undefined,
    continuationPollMs: typeof continuationPollMs === 'number' && Number.isFinite(continuationPollMs)
      ? continuationPollMs
      : undefined,
    continuationStableMs: typeof continuationStableMs === 'number' && Number.isFinite(continuationStableMs)
      ? continuationStableMs
      : undefined,
  });
}

export function spawnMcpRefreshOperation(input: McpRefreshOperationInput, prompt: string): McpRefreshBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule MCP refresh operation because the current CLI entry path is unavailable.');
  }

  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildMcpRefreshOperationArgs(input)], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: childEnvWithPrompt(prompt),
  });
  child.unref();

  return {
    scheduled: true,
    pid: child.pid ?? null,
    detached: true,
    windowsHide: true,
    internalCommand: INTERNAL_COMMAND,
    argvIncludesPrompt: false,
    promptTransport: 'environment',
  };
}

export function buildMcpRefreshPayload(
  input: McpRefreshInput,
  deps: {
    store?: OperationStore;
    scheduler?: McpRefreshScheduler;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnMcpRefreshOperation;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const prompt = input.prompt ?? DEFAULT_PROMPT;
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    prompt,
    highlightTools: input.highlightTools,
    timeoutMs: input.timeoutMs,
    continuationTimeoutMs: input.continuationTimeoutMs,
    continuationPollMs: input.continuationPollMs,
    continuationStableMs: input.continuationStableMs,
  });

  const operation = store.create({
    kind: 'mcp_refresh',
    status: 'running',
    evidence: { requested },
    nextAction: REFRESH_NEXT_ACTION,
  });

  try {
    const operationInput = operationInputForOptionalValues({
      operationId: operation.id,
      appServerUrl,
      threadId: input.threadId,
      highlightTools: input.highlightTools,
      timeoutMs: input.timeoutMs,
      continuationTimeoutMs: input.continuationTimeoutMs,
      continuationPollMs: input.continuationPollMs,
      continuationStableMs: input.continuationStableMs,
    });
    const background = scheduler(operationInput, prompt);
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, background },
        nextAction: REFRESH_NEXT_ACTION,
      }) ?? operation;

    return {
      ok: true,
      operationId: operation.id,
      operation: updatedOperation,
      background,
    };
  } catch (error) {
    store.fail(operation.id, {
      failure: publicFailure(error, prompt),
      evidence: { requested, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

export async function runMcpRefreshOperation(
  input: McpRefreshOperationInput,
  deps: {
    store?: OperationStore;
    connectClient?: McpRefreshClientFactory;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OperationRecord | null> {
  const store = deps.store ?? operationStore;
  const connectClient = deps.connectClient ?? connectAppServerClient;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const prompt = promptFromEnv(deps.env);
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, MAX_REQUEST_TIMEOUT_MS);
  const continuationTimeoutMs = boundedInteger(input.continuationTimeoutMs, DEFAULT_CONTINUATION_TIMEOUT_MS, 0, MAX_CONTINUATION_TIMEOUT_MS);
  const continuationPollMs = boundedInteger(input.continuationPollMs, DEFAULT_CONTINUATION_POLL_MS, MIN_CONTINUATION_POLL_MS, MAX_CONTINUATION_POLL_MS);
  const continuationStableMs = boundedInteger(input.continuationStableMs, DEFAULT_CONTINUATION_STABLE_MS, 0, MAX_CONTINUATION_STABLE_MS);
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    prompt,
    highlightTools: input.highlightTools,
    timeoutMs,
    continuationTimeoutMs,
    continuationPollMs,
    continuationStableMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);

  let client: McpRefreshClient | null = null;
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };
  try {
    client = await connectClient({ url: appServerUrl, requestTimeoutMs: timeoutMs });
    await client.initialize();

    const statusInput: { threadId: string; highlightTools?: string[] } = { threadId: input.threadId };
    if (input.highlightTools !== undefined) statusInput.highlightTools = input.highlightTools;
    evidence.statusBefore = await collectStatusEvidence(client, statusInput);
    await client.reloadMcpServers();
    evidence.reload = { requested: true };
    evidence.statusAfter = await collectStatusEvidence(client, statusInput);

    const ready = await waitForThreadIdle(client, {
      threadId: input.threadId,
      timeoutMs: continuationTimeoutMs,
      pollMs: continuationPollMs,
      stableMs: continuationStableMs,
    });
    evidence.ready = ready;
    if (!ready.ok) {
      return store.fail(input.operationId, {
        failure: { name: 'ThreadNotReady', message: ready.error ?? 'Thread did not become ready for MCP refresh continuation.' },
        evidence,
        nextAction: 'Inspect ready evidence and retry refresh when the target thread is idle.',
      });
    }

    const clientUserMessageId = `codex-session-manager-refresh-${Date.now()}`;
    const cwd = resolve(process.cwd());
    const started = await client.startTurn({
      threadId: input.threadId,
      cwd,
      clientUserMessageId,
      input: [{ type: 'text', text: prompt }],
    });
    evidence.turnStart = {
      requested: true,
      threadId: input.threadId,
      cwdPreview: '<workspace>',
      clientUserMessageId,
      turnId: started.turn?.id ?? started.id ?? null,
      inputIncluded: true,
    };

    return store.complete(input.operationId, {
      evidence,
      nextAction: 'Continuation turn started. Final proof still requires that fresh turn to call the changed MCP tool; App Server status or direct SDK calls are diagnostic only.',
    });
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error, prompt),
      evidence,
      nextAction: 'Inspect failure details with codex_operation_read before retrying.',
    });
  } finally {
    client?.close();
  }
}

export async function runMcpRefreshOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runMcpRefreshOperation(parseMcpRefreshOperationArgs(argv));
}
