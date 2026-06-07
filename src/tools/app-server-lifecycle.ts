import { spawn } from 'node:child_process';
import { z } from 'zod';

import { appServerStateFileForWorkspace, readAppServerStateFile, writeAppServerState, type AppServerState } from '../app-server/state.js';
import {
  collectProcessTree,
  listProcesses,
  pathsMatch,
  stopProcessTree,
  summarizeProcesses,
  type ProcessEntry,
} from '../processes.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { validateAppServerUrl } from '../security/url.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 1_000;
const MAX_READY_TIMEOUT_MS = 10_000;
const INTERNAL_COMMAND = 'run-app-server-stop-operation';
const STOP_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then codex_operation_read for final App Server stop evidence.';

export const appServerStatusInputSchema = {
  probeReady: z.boolean().optional().describe('Defaults true. Probe /readyz for the managed App Server state URL.'),
  includeProcessTree: z.boolean().optional().describe('Defaults true. Include redacted process tree evidence for the managed App Server pid.'),
  readyTimeoutMs: z.number().int().min(100).max(MAX_READY_TIMEOUT_MS).optional().describe('Maximum /readyz probe time in milliseconds.'),
};

export const appServerStopInputSchema = {
  dryRun: z.boolean().optional().describe('Defaults true. When true, only reports the managed App Server stop target.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
  timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional().describe('Maximum wait time for the managed App Server process tree to stop.'),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Delay before the detached child stops the managed App Server process tree.'),
};

const appServerStatusInputObject = z.object(appServerStatusInputSchema);
const appServerStopInputObject = z.object(appServerStopInputSchema);

type AppServerStatusInput = z.infer<typeof appServerStatusInputObject>;
type AppServerStopInput = z.infer<typeof appServerStopInputObject>;

export interface AppServerStopOperationInput {
  operationId: string;
  workspace: string;
  expectedPid: number;
  expectedAppServerUrl: string;
  timeoutMs?: number;
  delayMs?: number;
}

export interface AppServerStopBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesSecrets: false;
  delayMs: number;
}

export type ProcessLister = () => ProcessEntry[];
export type ProcessStopper = (rootPid: number, tree: readonly ProcessEntry[]) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};
export type ReadyProbe = (url: string, timeoutMs: number) => Promise<boolean>;
export type AppServerStopScheduler = (input: AppServerStopOperationInput) => AppServerStopBackgroundEvidence;

interface ManagedAppServerTarget {
  stateFile: string;
  stateExists: boolean;
  stateOk: boolean;
  stateError?: string;
  url: string | null;
  pid: number | null;
  owned: boolean;
  workspaceMatches: boolean;
  stateStatus: string | null;
  processAlive: boolean;
  processTree: ProcessEntry[];
  canStop: boolean;
  stopReason: string;
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

function validatedStateUrl(state: AppServerState | null): string | null {
  if (typeof state?.url !== 'string' || state.url.length === 0) return null;
  try {
    return validateAppServerUrl(state.url, 'App Server URL from primary launcher state').href;
  } catch {
    return null;
  }
}

function statePid(state: AppServerState | null): number | null {
  return Number.isSafeInteger(state?.pid) && Number(state?.pid) > 0 ? Number(state?.pid) : null;
}

function managedAppServerTarget(input: {
  workspace: string;
  processes: readonly ProcessEntry[];
  includeProcessTree?: boolean | undefined;
}): ManagedAppServerTarget {
  const stateFile = appServerStateFileForWorkspace(input.workspace, 'primary');
  const read = readAppServerStateFile(stateFile, 'primary');
  const state = read.state;
  const pid = statePid(state);
  const url = validatedStateUrl(state);
  const owned = state?.owned === true;
  const workspaceMatches = typeof state?.workspace === 'string' && pathsMatch(state.workspace, input.workspace);
  const processTree = pid === null || input.includeProcessTree === false ? [] : collectProcessTree(input.processes, [pid]);
  const processAlive = pid !== null && processTree.some((entry) => entry.pid === pid);

  let canStop = false;
  let stopReason = 'No primary App Server launcher state exists for this workspace.';
  if (read.exists && !read.ok) {
    stopReason = 'Primary App Server launcher state is invalid JSON.';
  } else if (!owned) {
    stopReason = 'Primary App Server launcher state is not marked owned by this workspace.';
  } else if (!workspaceMatches) {
    stopReason = 'Primary App Server launcher state workspace does not match the current workspace.';
  } else if (url === null) {
    stopReason = 'Primary App Server launcher state does not contain a valid loopback App Server URL.';
  } else if (pid === null) {
    stopReason = 'Primary App Server launcher state does not contain a live process pid.';
  } else if (!processAlive) {
    stopReason = 'Managed App Server process from primary launcher state is not currently running.';
  } else {
    canStop = true;
    stopReason = 'Managed App Server process tree can be stopped.';
  }

  const target: ManagedAppServerTarget = {
    stateFile,
    stateExists: read.exists,
    stateOk: read.ok,
    url,
    pid,
    owned,
    workspaceMatches,
    stateStatus: typeof state?.status === 'string' ? state.status : null,
    processAlive,
    processTree,
    canStop,
    stopReason,
  };
  if (read.error !== undefined) target.stateError = read.error;
  return target;
}

function publicTarget(target: ManagedAppServerTarget, workspace: string, includeProcessTree = true): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    stateFilePreview: redactSensitiveText(target.stateFile.replace(resolveWorkspaceRoot(workspace), '<workspace>')),
    stateExists: target.stateExists,
    stateOk: target.stateOk,
    url: target.url === null ? null : redactSensitiveText(target.url),
    pid: target.pid,
    owned: target.owned,
    workspaceMatches: target.workspaceMatches,
    stateStatus: target.stateStatus,
    processAlive: target.processAlive,
    canStop: target.canStop,
    stopReason: target.stopReason,
    processTreeCount: target.processTree.length,
  };
  if (target.stateError !== undefined) payload.stateError = redactSensitiveText(target.stateError);
  if (includeProcessTree) {
    payload.processTree = redactValue(summarizeProcesses(target.processTree), { workspace });
  }
  return payload;
}

function requestedStopEvidence(input: {
  workspace: string;
  timeoutMs: number;
  delayMs: number;
}): Record<string, unknown> {
  return {
    workspacePreview: '<workspace>',
    timeoutMs: input.timeoutMs,
    delayMs: input.delayMs,
    scope: 'workspace-owned-app-server',
    remoteTuiWillBeStopped: false,
  };
}

function readyzUrl(wsUrl: string): string {
  const parsed = new URL(validateAppServerUrl(wsUrl).href);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/readyz';
  return parsed.toString();
}

async function defaultReadyProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(readyzUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function buildAppServerStatusPayload(
  input: AppServerStatusInput,
  deps: {
    workspace?: string;
    processLister?: ProcessLister;
    readyProbe?: ReadyProbe;
  } = {},
): Promise<Record<string, unknown>> {
  const workspace = resolveWorkspaceRoot(deps.workspace);
  const includeProcessTree = input.includeProcessTree ?? true;
  const probeReady = input.probeReady ?? true;
  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const processLister = deps.processLister ?? listProcesses;
  const readyProbe = deps.readyProbe ?? defaultReadyProbe;
  const target = managedAppServerTarget({
    workspace,
    processes: processLister(),
    includeProcessTree,
  });

  const payload: Record<string, unknown> = {
    ok: true,
    workspacePreview: '<workspace>',
    managedAppServer: publicTarget(target, workspace, includeProcessTree),
    notes: [
      'This inspects only the primary workspace-managed App Server launcher state.',
      'It does not inspect or stop user global MCP servers.',
    ],
  };

  if (probeReady && target.url !== null) {
    payload.ready = {
      probed: true,
      ok: await readyProbe(target.url, readyTimeoutMs),
      timeoutMs: readyTimeoutMs,
    };
  } else {
    payload.ready = {
      probed: false,
      ok: null,
      timeoutMs: readyTimeoutMs,
    };
  }

  return payload;
}

export function buildAppServerStopOperationArgs(input: AppServerStopOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--workspace',
    input.workspace,
    '--expected-pid',
    String(input.expectedPid),
    '--expected-app-server-url',
    input.expectedAppServerUrl,
  ];
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.delayMs !== undefined) args.push('--delay-ms', String(input.delayMs));
  return args;
}

export function parseAppServerStopOperationArgs(argv: readonly string[]): AppServerStopOperationInput {
  let operationId: string | undefined;
  let workspace: string | undefined;
  let expectedPid: number | undefined;
  let expectedAppServerUrl: string | undefined;
  let timeoutMs: number | undefined;
  let delayMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--operation-id' && value !== undefined) {
      operationId = value;
      index += 1;
    } else if (arg === '--workspace' && value !== undefined) {
      workspace = value;
      index += 1;
    } else if (arg === '--expected-pid' && value !== undefined) {
      expectedPid = Number(value);
      index += 1;
    } else if (arg === '--expected-app-server-url' && value !== undefined) {
      expectedAppServerUrl = value;
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
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);
  if (!Number.isSafeInteger(expectedPid) || Number(expectedPid) <= 0) {
    throw new Error(`${INTERNAL_COMMAND} requires --expected-pid.`);
  }
  if (!expectedAppServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --expected-app-server-url.`);
  const parsedExpectedPid = Number(expectedPid);

  const operationInput: AppServerStopOperationInput = {
    operationId,
    workspace: resolveWorkspaceRoot(workspace),
    expectedPid: parsedExpectedPid,
    expectedAppServerUrl: validateAppServerUrl(expectedAppServerUrl, 'Expected App Server URL').href,
  };
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) operationInput.timeoutMs = timeoutMs;
  if (typeof delayMs === 'number' && Number.isFinite(delayMs)) operationInput.delayMs = delayMs;
  return operationInput;
}

export function spawnAppServerStopOperation(input: AppServerStopOperationInput): AppServerStopBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule App Server stop operation because the current CLI entry path is unavailable.');
  }
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildAppServerStopOperationArgs(input)], {
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

export function buildAppServerStopPayload(
  input: AppServerStopInput,
  deps: {
    workspace?: string;
    store?: OperationStore;
    scheduler?: AppServerStopScheduler;
    processLister?: ProcessLister;
  } = {},
): Record<string, unknown> {
  const workspace = resolveWorkspaceRoot(deps.workspace);
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnAppServerStopOperation;
  const processLister = deps.processLister ?? listProcesses;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const dryRun = input.dryRun ?? true;
  const confirm = input.confirm === true;
  const requested = requestedStopEvidence({ workspace, timeoutMs, delayMs });
  const target = managedAppServerTarget({
    workspace,
    processes: processLister(),
  });
  const targetPayload = publicTarget(target, workspace);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      managedAppServer: targetPayload,
      notes: [
        'This only targets the primary workspace-managed App Server process tree.',
        'It does not stop remote TUI windows or user global MCP server configuration.',
      ],
    };
  }

  if (!confirm) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      managedAppServer: targetPayload,
      message: 'Pass confirm:true with dryRun:false to schedule App Server stop.',
    };
  }

  if (!target.canStop || target.pid === null || target.url === null) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: false,
      ...requested,
      managedAppServer: targetPayload,
      message: 'No owned running workspace App Server target is safe to stop.',
    };
  }

  const operation = store.create({
    kind: 'app_server_stop',
    status: 'running',
    evidence: { requested, managedAppServer: targetPayload },
    nextAction: STOP_NEXT_ACTION,
  });

  try {
    const background = scheduler({
      operationId: operation.id,
      workspace,
      expectedPid: target.pid,
      expectedAppServerUrl: target.url,
      timeoutMs,
      delayMs,
    });
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, managedAppServer: targetPayload, background },
        nextAction: STOP_NEXT_ACTION,
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
      evidence: { requested, managedAppServer: targetPayload, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

function stopStateFrom(state: AppServerState | null, workspace: string): AppServerState {
  return {
    ...(state ?? {}),
    pid: null,
    owned: false,
    reusedServer: false,
    status: 'stopped',
    workspace,
    updatedAt: new Date().toISOString(),
  };
}

function stopProcessEvidence(rootPid: number, processes: readonly ProcessEntry[], stopProcess: ProcessStopper): Record<string, unknown> {
  const tree = collectProcessTree(processes, [rootPid]);
  const result = tree.length > 0
    ? stopProcess(rootPid, tree)
    : { status: 0, stdout: '', stderr: '' };
  return {
    rootPid,
    treePids: tree.map((entry) => entry.pid),
    exitCode: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function waitForProcessIdsGone(input: {
  processIds: readonly number[];
  timeoutMs: number;
  processLister: ProcessLister;
}): Promise<Record<string, unknown>> {
  const processIds = new Set(input.processIds);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= input.timeoutMs) {
    const remaining = input.processLister().filter((entry) => processIds.has(entry.pid));
    if (remaining.length === 0) {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await sleep(Math.min(250, Math.max(0, input.timeoutMs - (Date.now() - startedAt))));
  }

  const remaining = input.processLister().filter((entry) => processIds.has(entry.pid));
  return {
    ok: remaining.length === 0,
    elapsedMs: Date.now() - startedAt,
    remaining: summarizeProcesses(remaining),
  };
}

export async function runAppServerStopOperation(
  input: AppServerStopOperationInput,
  deps: {
    store?: OperationStore;
    processLister?: ProcessLister;
    processStopper?: ProcessStopper;
  } = {},
): Promise<OperationRecord | null> {
  const workspace = resolveWorkspaceRoot(input.workspace);
  const store = deps.store ?? new OperationStore({ workspace });
  const processLister = deps.processLister ?? listProcesses;
  const processStopper = deps.processStopper ?? stopProcessTree;
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS);
  const delayMs = boundedInteger(input.delayMs, DEFAULT_DELAY_MS, 0, MAX_DELAY_MS);
  const requested = requestedStopEvidence({ workspace, timeoutMs, delayMs });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };

  try {
    if (delayMs > 0) await sleep(delayMs);
    const stateFile = appServerStateFileForWorkspace(workspace, 'primary');
    const stateRead = readAppServerStateFile(stateFile, 'primary');
    const state = stateRead.state;
    const url = validatedStateUrl(state);
    const pid = statePid(state);
    if (url !== input.expectedAppServerUrl || pid !== input.expectedPid) {
      return store.fail(input.operationId, {
        failure: {
          name: 'AppServerStateChanged',
          message: 'Workspace App Server launcher state changed before stop operation executed.',
        },
        evidence: {
          ...evidence,
          current: publicTarget(managedAppServerTarget({ workspace, processes: processLister() }), workspace),
        },
        nextAction: 'Inspect current App Server state before retrying.',
      });
    }

    const processes = processLister();
    const tree = collectProcessTree(processes, [input.expectedPid]);
    evidence.match = {
      processTreeCount: tree.length,
      processTree: redactValue(summarizeProcesses(tree), { workspace }),
    };
    evidence.stop = redactValue(stopProcessEvidence(input.expectedPid, processes, processStopper), { workspace });
    const stopped = await waitForProcessIdsGone({
      processIds: tree.length > 0 ? tree.map((entry) => entry.pid) : [input.expectedPid],
      timeoutMs,
      processLister,
    });
    evidence.stopped = redactValue(stopped, { workspace });

    if ((stopped as { ok?: unknown }).ok === true) {
      writeAppServerState(stopStateFrom(state, workspace), workspace);
      return store.complete(input.operationId, {
        evidence,
        nextAction: 'Managed App Server stopped. Start/reuse it again with codex_app_server_start or npm run remote.',
      });
    }

    return store.fail(input.operationId, {
      failure: { name: 'AppServerStillRunning', message: 'Managed App Server process tree remained after timeout.' },
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

export async function runAppServerStopOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runAppServerStopOperation(parseAppServerStopOperationArgs(argv));
}
