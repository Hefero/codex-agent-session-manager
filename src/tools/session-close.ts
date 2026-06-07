import { spawn } from 'node:child_process';
import { z } from 'zod';

import { resolveAppServerUrl } from '../app-server/config.js';
import {
  collectProcessTree,
  findRemoteTuiTargets,
  listProcesses,
  stopProcessTree,
  summarizeProcesses,
  type ProcessEntry,
} from '../processes.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const INTERNAL_COMMAND = 'run-session-close-operation';
const CLOSE_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then codex_operation_read for final close evidence.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

export const sessionCloseInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).describe('Explicit target thread id. Required; this first implementation does not support broad --all cleanup.'),
  dryRun: z.boolean().optional().describe('Defaults true. When true, only returns matching process evidence and does not close anything.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
  timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional().describe('Maximum wait time for matching remote TUI processes to stop.'),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Delay before the detached child closes processes.'),
};

const sessionCloseInputObject = z.object(sessionCloseInputSchema);
type SessionCloseInput = z.infer<typeof sessionCloseInputObject>;

export interface SessionCloseOperationInput {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  workspace: string;
  timeoutMs?: number;
  delayMs?: number;
}

export interface SessionCloseBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesSecrets: false;
  delayMs: number;
}

export type SessionCloseScheduler = (input: SessionCloseOperationInput) => SessionCloseBackgroundEvidence;
export type ProcessLister = () => ProcessEntry[];
export type ProcessStopper = (rootPid: number, tree: readonly ProcessEntry[]) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

interface ClosePlan {
  targetCount: number;
  remoteProcessCount: number;
  targets: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
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

function requestedEvidence(input: {
  appServerUrl: string;
  threadId: string;
  workspace: string;
  timeoutMs?: number | undefined;
  delayMs?: number | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: redactSensitiveText(input.appServerUrl),
    threadId: input.threadId,
    workspacePreview: '<workspace>',
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    delayMs: input.delayMs ?? DEFAULT_DELAY_MS,
    scope: 'explicit-thread',
    appServerWillBeStopped: false,
  };
}

function closePlanFromProcesses(processes: readonly ProcessEntry[], input: {
  appServerUrl: string;
  threadId: string;
  workspace: string;
}): ClosePlan {
  const targets = findRemoteTuiTargets(processes, {
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
    workspace: input.workspace,
  });
  return {
    targetCount: targets.roots.length,
    remoteProcessCount: targets.remoteProcesses.length,
    targets: redactValue(summarizeProcesses(targets.roots), { workspace: input.workspace }),
  };
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  threadId: string;
  workspace: string;
  timeoutMs?: number | undefined;
  delayMs?: number | undefined;
}): SessionCloseOperationInput {
  const operationInput: SessionCloseOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
    workspace: input.workspace,
  };
  if (input.timeoutMs !== undefined) operationInput.timeoutMs = input.timeoutMs;
  if (input.delayMs !== undefined) operationInput.delayMs = input.delayMs;
  return operationInput;
}

export function buildSessionCloseOperationArgs(input: SessionCloseOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--app-server-url',
    input.appServerUrl,
    '--thread-id',
    input.threadId,
    '--workspace',
    input.workspace,
  ];
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.delayMs !== undefined) args.push('--delay-ms', String(input.delayMs));
  return args;
}

export function parseSessionCloseOperationArgs(argv: readonly string[]): SessionCloseOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let threadId: string | undefined;
  let workspace: string | undefined;
  let timeoutMs: number | undefined;
  let delayMs: number | undefined;

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
    } else if (arg === '--workspace' && value !== undefined) {
      workspace = value;
      index += 1;
    } else if (arg === '--timeout-ms' && value !== undefined) {
      timeoutMs = Number(value);
      index += 1;
    } else if (arg === '--delay-ms' && value !== undefined) {
      delayMs = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!appServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --app-server-url.`);
  if (!threadId) throw new Error(`${INTERNAL_COMMAND} requires --thread-id.`);
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);

  return operationInputForOptionalValues({
    operationId,
    appServerUrl: resolveAppServerUrl(appServerUrl),
    threadId,
    workspace: resolveWorkspaceRoot(workspace),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
  });
}

export function spawnSessionCloseOperation(input: SessionCloseOperationInput): SessionCloseBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule session close operation because the current CLI entry path is unavailable.');
  }
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildSessionCloseOperationArgs(input)], {
    cwd: input.workspace,
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
    delayMs,
  };
}

export function buildSessionClosePayload(
  input: SessionCloseInput,
  deps: {
    store?: OperationStore;
    scheduler?: SessionCloseScheduler;
    processLister?: ProcessLister;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnSessionCloseOperation;
  const processLister = deps.processLister ?? listProcesses;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolveWorkspaceRoot();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const dryRun = input.dryRun ?? true;
  const confirm = input.confirm === true;
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    workspace,
    timeoutMs,
    delayMs,
  });

  if (dryRun) {
    const plan = closePlanFromProcesses(processLister(), { appServerUrl, threadId: input.threadId, workspace });
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      ...plan,
      notes: [
        'This only targets matching Codex remote TUI processes for this workspace, App Server URL, and explicit threadId.',
        'It does not stop the App Server or archive thread history.',
      ],
    };
  }

  if (!confirm) {
    const plan = closePlanFromProcesses(processLister(), { appServerUrl, threadId: input.threadId, workspace });
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      ...plan,
      message: 'Pass confirm:true with dryRun:false to schedule remote TUI cleanup.',
    };
  }

  const operation = store.create({
    kind: 'session_close',
    status: 'running',
    evidence: { requested },
    nextAction: CLOSE_NEXT_ACTION,
  });

  try {
    const background = scheduler(
      operationInputForOptionalValues({
        operationId: operation.id,
        appServerUrl,
        threadId: input.threadId,
        workspace,
        timeoutMs,
        delayMs,
      }),
    );
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, background },
        nextAction: CLOSE_NEXT_ACTION,
      }) ?? operation;
    return {
      ok: true,
      dryRun: false,
      confirmRequired: false,
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

export function stopRemoteRoots(processes: readonly ProcessEntry[], roots: readonly ProcessEntry[], stopProcess: ProcessStopper): Array<Record<string, unknown>> {
  return roots.map((root) => {
    const tree = collectProcessTree(processes, [root.pid]);
    const result = stopProcess(root.pid, tree);
    return {
      rootPid: root.pid,
      treePids: tree.map((entry) => entry.pid),
      exitCode: result.status,
      stdout: String(result.stdout ?? '').trim(),
      stderr: String(result.stderr ?? '').trim(),
    };
  });
}

export async function waitForRemoteGone(input: {
  appServerUrl: string;
  threadId: string;
  workspace: string;
  timeoutMs: number;
  processLister: ProcessLister;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= input.timeoutMs) {
    const current = findRemoteTuiTargets(input.processLister(), {
      appServerUrl: input.appServerUrl,
      threadId: input.threadId,
      workspace: input.workspace,
    });
    if (current.remoteProcesses.length === 0) {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await sleep(Math.min(250, Math.max(0, input.timeoutMs - (Date.now() - startedAt))));
  }

  const remaining = findRemoteTuiTargets(input.processLister(), {
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
    workspace: input.workspace,
  });
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    remaining: redactValue(summarizeProcesses(remaining.remoteProcesses), { workspace: input.workspace }),
  };
}

export async function runSessionCloseOperation(
  input: SessionCloseOperationInput,
  deps: {
    store?: OperationStore;
    processLister?: ProcessLister;
    processStopper?: ProcessStopper;
  } = {},
): Promise<OperationRecord | null> {
  const store = deps.store ?? operationStore;
  const processLister = deps.processLister ?? listProcesses;
  const processStopper = deps.processStopper ?? stopProcessTree;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolveWorkspaceRoot(input.workspace);
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS);
  const delayMs = boundedInteger(input.delayMs, DEFAULT_DELAY_MS, 0, MAX_DELAY_MS);
  const requested = requestedEvidence({
    appServerUrl,
    threadId: input.threadId,
    workspace,
    timeoutMs,
    delayMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };

  try {
    if (delayMs > 0) await sleep(delayMs);
    const processes = processLister();
    const targets = findRemoteTuiTargets(processes, { appServerUrl, threadId: input.threadId, workspace });
    evidence.match = {
      targetCount: targets.roots.length,
      remoteProcessCount: targets.remoteProcesses.length,
      targets: redactValue(summarizeProcesses(targets.roots), { workspace }),
    };
    evidence.stop = redactValue(stopRemoteRoots(processes, targets.roots, processStopper), { workspace });
    const stopped = await waitForRemoteGone({
      appServerUrl,
      threadId: input.threadId,
      workspace,
      timeoutMs,
      processLister,
    });
    evidence.stopped = stopped;
    if ((stopped as { ok?: unknown }).ok === true) {
      return store.complete(input.operationId, {
        evidence,
        nextAction: 'Remote TUI cleanup completed. App Server was not stopped.',
      });
    }
    return store.fail(input.operationId, {
      failure: { name: 'RemoteTuiStillRunning', message: 'Matching remote TUI processes remained after timeout.' },
      evidence,
      nextAction: 'Inspect remaining process evidence before retrying.',
    });
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error),
      evidence,
      nextAction: 'Inspect failure details with codex_operation_read before retrying.',
    });
  }
}

export async function runSessionCloseOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runSessionCloseOperation(parseSessionCloseOperationArgs(argv));
}
