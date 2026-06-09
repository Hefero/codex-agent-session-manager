import { spawn } from 'node:child_process';
import { z } from 'zod';

import { connectAppServerClient } from '../app-server/client.js';
import { resolveAppServerUrl } from '../app-server/config.js';
import type { ThreadReadResult, TurnStartParams, TurnStartResult } from '../app-server/protocol.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const DEFAULT_PROMPT = 'Codex session continuation turn. Refresh callable tool context and continue validation.';
const CONTINUE_PROMPT_ENV = 'CODEX_AGENT_SESSION_MANAGER_CONTINUE_PROMPT';
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
const MAX_ATTEMPTS_EVIDENCE = 20;
const INTERNAL_COMMAND = 'run-session-continue-operation';
const CONTINUE_NEXT_ACTION =
  'Let the current turn finish when this targets the current thread. The background operation waits for the target thread to become idle, starts the continuation, and only that continuation can provide final callable proof. Use codex_operation_wait/read only from a later turn or another thread.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

export const sessionContinueInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).describe('Explicit target Codex thread id. Required in this first implementation.'),
  prompt: z
    .string()
    .max(MAX_PROMPT_CHARS)
    .optional()
    .describe('Continuation prompt text. It is passed to the child via environment, never argv or operation evidence.'),
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

const sessionContinueInputObject = z.object(sessionContinueInputSchema);
type SessionContinueInput = z.infer<typeof sessionContinueInputObject>;

export interface SessionContinueOperationInput {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  timeoutMs?: number;
  continuationTimeoutMs?: number;
  continuationPollMs?: number;
  continuationStableMs?: number;
}

export interface SessionContinueBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesPrompt: false;
  promptTransport: 'environment';
}

export interface SessionContinueClient {
  initialize(): Promise<unknown>;
  readThread(input: { threadId: string; includeTurns: boolean }): Promise<ThreadReadResult>;
  startTurn(input: TurnStartParams): Promise<TurnStartResult>;
  close(): void;
}

export type SessionContinueClientFactory = (options: { url: string; requestTimeoutMs?: number }) => Promise<SessionContinueClient>;
export type SessionContinueScheduler = (input: SessionContinueOperationInput, prompt: string) => SessionContinueBackgroundEvidence;

export interface ThreadReadyStatus {
  type: string | null;
  activeFlags: string[] | null;
}

export interface ThreadReadyAttempt {
  elapsedMs: number;
  status: string | null;
  activeFlags: string[] | null;
  idleStableForMs: number;
}

export interface ThreadReadyResult {
  ok: boolean;
  status: string | null;
  activeFlags: string[] | null;
  elapsedMs: number;
  stableMs: number;
  stableForMs: number;
  attemptCount: number;
  attempts: ThreadReadyAttempt[];
  error?: string;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function redactContinuationPrompt(text: string, promptToRedact: string | undefined): string {
  const redacted = redactSensitiveText(text);
  if (promptToRedact === undefined || promptToRedact.length === 0) return redacted;
  return redacted.split(promptToRedact).join('<redacted:continuation-prompt>');
}

function publicFailure(error: unknown, promptToRedact?: string): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactContinuationPrompt(error.message, promptToRedact),
    };
  }
  return redactContinuationPrompt(String(redactValue(String(error))), promptToRedact);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  timeoutMs?: number | undefined;
  continuationTimeoutMs?: number | undefined;
  continuationPollMs?: number | undefined;
  continuationStableMs?: number | undefined;
}): SessionContinueOperationInput {
  const operationInput: SessionContinueOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
  };
  if (input.timeoutMs !== undefined) operationInput.timeoutMs = input.timeoutMs;
  if (input.continuationTimeoutMs !== undefined) operationInput.continuationTimeoutMs = input.continuationTimeoutMs;
  if (input.continuationPollMs !== undefined) operationInput.continuationPollMs = input.continuationPollMs;
  if (input.continuationStableMs !== undefined) operationInput.continuationStableMs = input.continuationStableMs;
  return operationInput;
}

function requestedEvidence(input: {
  appServerUrl: string;
  threadId: string;
  prompt: string;
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
    cwdPreview: '<workspace>',
    timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    continuationTimeoutMs: input.continuationTimeoutMs ?? DEFAULT_CONTINUATION_TIMEOUT_MS,
    continuationPollMs: input.continuationPollMs ?? DEFAULT_CONTINUATION_POLL_MS,
    continuationStableMs: input.continuationStableMs ?? DEFAULT_CONTINUATION_STABLE_MS,
  };
}

function threadReadyStatus(read: ThreadReadResult): ThreadReadyStatus {
  const status = read.thread?.status ?? null;
  return {
    type: typeof status?.type === 'string' ? status.type : null,
    activeFlags: Array.isArray(status?.activeFlags) ? status.activeFlags.filter((entry) => typeof entry === 'string') : null,
  };
}

function pushAttempt(attempts: ThreadReadyAttempt[], attempt: ThreadReadyAttempt): void {
  attempts.push(attempt);
  if (attempts.length > MAX_ATTEMPTS_EVIDENCE) {
    attempts.shift();
  }
}

export async function waitForThreadIdle(
  client: SessionContinueClient,
  input: {
    threadId: string;
    timeoutMs: number;
    pollMs: number;
    stableMs: number;
  },
): Promise<ThreadReadyResult> {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const attempts: ThreadReadyAttempt[] = [];
  let attemptCount = 0;
  let idleSince: number | null = null;
  let lastStatus: ThreadReadyStatus = { type: null, activeFlags: null };

  while (Date.now() <= deadline) {
    const elapsedMs = Date.now() - startedAt;
    const read = await client.readThread({ threadId: input.threadId, includeTurns: false });
    const status = threadReadyStatus(read);
    lastStatus = status;
    const idleStableForMs = idleSince === null ? 0 : Date.now() - idleSince;
    attemptCount += 1;
    pushAttempt(attempts, {
      elapsedMs,
      status: status.type,
      activeFlags: status.activeFlags,
      idleStableForMs,
    });

    if (status.type === 'idle') {
      idleSince ??= Date.now();
      const stableForMs = Date.now() - idleSince;
      if (stableForMs >= input.stableMs) {
        return {
          ok: true,
          status: status.type,
          activeFlags: status.activeFlags,
          elapsedMs,
          stableMs: input.stableMs,
          stableForMs,
          attemptCount,
          attempts,
        };
      }
    } else {
      idleSince = null;
    }

    if (status.type === 'systemError' || status.type === 'notLoaded') {
      return {
        ok: false,
        status: status.type,
        activeFlags: status.activeFlags,
        elapsedMs,
        stableMs: input.stableMs,
        stableForMs: 0,
        attemptCount,
        attempts,
        error: `Thread ${input.threadId} entered status ${status.type}.`,
      };
    }

    await sleep(Math.min(input.pollMs, Math.max(0, deadline - Date.now())));
  }

  return {
    ok: false,
    status: lastStatus.type,
    activeFlags: lastStatus.activeFlags,
    elapsedMs: Date.now() - startedAt,
    stableMs: input.stableMs,
    stableForMs: 0,
    attemptCount,
    attempts,
    error: `Timed out waiting ${input.timeoutMs}ms for thread ${input.threadId} to become idle for ${input.stableMs}ms.`,
  };
}

function promptFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const prompt = env[CONTINUE_PROMPT_ENV] ?? DEFAULT_PROMPT;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Continuation prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return prompt;
}

function childEnvWithPrompt(prompt: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[CONTINUE_PROMPT_ENV];
  env[CONTINUE_PROMPT_ENV] = prompt;
  return env;
}

export function buildSessionContinueOperationArgs(input: SessionContinueOperationInput): string[] {
  const args = [INTERNAL_COMMAND, '--operation-id', input.operationId, '--app-server-url', input.appServerUrl, '--thread-id', input.threadId];
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.continuationTimeoutMs !== undefined) args.push('--continuation-timeout-ms', String(input.continuationTimeoutMs));
  if (input.continuationPollMs !== undefined) args.push('--continuation-poll-ms', String(input.continuationPollMs));
  if (input.continuationStableMs !== undefined) args.push('--continuation-stable-ms', String(input.continuationStableMs));
  return args;
}

export function parseSessionContinueOperationArgs(argv: readonly string[]): SessionContinueOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let threadId: string | undefined;
  let timeoutMs: number | undefined;
  let continuationTimeoutMs: number | undefined;
  let continuationPollMs: number | undefined;
  let continuationStableMs: number | undefined;

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
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    continuationTimeoutMs: Number.isFinite(continuationTimeoutMs) ? continuationTimeoutMs : undefined,
    continuationPollMs: Number.isFinite(continuationPollMs) ? continuationPollMs : undefined,
    continuationStableMs: Number.isFinite(continuationStableMs) ? continuationStableMs : undefined,
  });
}

export function spawnSessionContinueOperation(input: SessionContinueOperationInput, prompt: string): SessionContinueBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule session continuation because the current CLI entry path is unavailable.');
  }

  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildSessionContinueOperationArgs(input)], {
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

export function buildSessionContinuePayload(
  input: SessionContinueInput,
  deps: {
    store?: OperationStore;
    scheduler?: SessionContinueScheduler;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnSessionContinueOperation;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const prompt = input.prompt ?? DEFAULT_PROMPT;
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    prompt,
    timeoutMs: input.timeoutMs,
    continuationTimeoutMs: input.continuationTimeoutMs,
    continuationPollMs: input.continuationPollMs,
    continuationStableMs: input.continuationStableMs,
  });

  const operation = store.create({
    kind: 'session_continue',
    status: 'running',
    evidence: { requested },
    nextAction: CONTINUE_NEXT_ACTION,
  });

  try {
    const operationInput = operationInputForOptionalValues({
      operationId: operation.id,
      appServerUrl,
      threadId: input.threadId,
      timeoutMs: input.timeoutMs,
      continuationTimeoutMs: input.continuationTimeoutMs,
      continuationPollMs: input.continuationPollMs,
      continuationStableMs: input.continuationStableMs,
    });
    const background = scheduler(operationInput, prompt);
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, background },
        nextAction: CONTINUE_NEXT_ACTION,
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

export async function runSessionContinueOperation(
  input: SessionContinueOperationInput,
  deps: {
    store?: OperationStore;
    connectClient?: SessionContinueClientFactory;
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
    timeoutMs,
    continuationTimeoutMs,
    continuationPollMs,
    continuationStableMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);

  let client: SessionContinueClient | null = null;
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };
  try {
    client = await connectClient({ url: appServerUrl, requestTimeoutMs: timeoutMs });
    await client.initialize();

    const ready = await waitForThreadIdle(client, {
      threadId: input.threadId,
      timeoutMs: continuationTimeoutMs,
      pollMs: continuationPollMs,
      stableMs: continuationStableMs,
    });
    evidence.ready = ready;
    if (!ready.ok) {
      return store.fail(input.operationId, {
        failure: { name: 'ThreadNotReady', message: ready.error ?? 'Thread did not become ready for continuation.' },
        evidence,
        nextAction: 'Inspect ready evidence and retry continuation when the target thread is idle.',
      });
    }

    const clientUserMessageId = `codex-session-manager-continue-${Date.now()}`;
    const cwd = resolveWorkspaceRoot();
    const started = await client.startTurn({
      threadId: input.threadId,
      cwd,
      clientUserMessageId,
      input: [{ type: 'text', text: prompt }],
    });
    evidence.turnStart = {
      requested: true,
      operationCompletionMeaning: 'turn-started-not-turn-finished',
      threadId: input.threadId,
      cwdPreview: '<workspace>',
      clientUserMessageId,
      turnId: started.turn?.id ?? started.id ?? null,
      inputIncluded: true,
    };

    return store.complete(input.operationId, {
      evidence,
      nextAction: 'Continuation turn was started, but this operation does not include the child turn result. Count proof only after that fresh turn calls the target model-callable tool; once the target call succeeds, stop validation and report the result.',
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

export async function runSessionContinueOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runSessionContinueOperation(parseSessionContinueOperationArgs(argv));
}
