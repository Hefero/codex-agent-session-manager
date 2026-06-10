import { spawn } from 'node:child_process';
import { z } from 'zod';

import { appServerStateFileForWorkspace, readAppServerStateFile, writeAppServerState, type AppServerState } from '../app-server/state.js';
import {
  collectProcessTree,
  commandLineTokens,
  listProcesses,
  normalizeAppServerUrl,
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
  appServerUrl: z.string().optional().describe('Optional loopback App Server websocket URL to stop with force:true. Intended for reused App Servers not owned by workspace launcher state.'),
  force: z.boolean().optional().describe('Required with appServerUrl for real stops of App Servers not marked owned by this workspace.'),
  timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional().describe('Maximum wait time for the managed App Server process tree to stop.'),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Delay before the detached child stops the managed App Server process tree.'),
};

const appServerStatusInputObject = z.object(appServerStatusInputSchema);
const appServerStopInputObject = z.object(appServerStopInputSchema);

type AppServerStatusInput = z.infer<typeof appServerStatusInputObject>;
type AppServerStopInput = z.infer<typeof appServerStopInputObject> & {
  useStateUrl?: boolean;
};

export interface AppServerStopOperationInput {
  operationId: string;
  workspace: string;
  expectedPid: number;
  expectedAppServerUrl: string;
  forceByUrl?: boolean;
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

interface AppServerUrlTarget {
  url: string;
  pid: number | null;
  processTree: ProcessEntry[];
  matchCount: number;
  rootCount: number;
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
  const processAlive = pid !== null && input.processes.some((entry) => entry.pid === pid);
  const processTree = pid === null || input.includeProcessTree === false ? [] : collectProcessTree(input.processes, [pid]);

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

function basenameToken(token: unknown): string {
  return String(token ?? '')
    .replace(/^["']+|["']+$/gu, '')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? '';
}

function tokenOptionValue(tokens: readonly string[], names: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    for (const name of names) {
      if (token === name) return tokens[index + 1] ?? null;
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

function tokensInclude(tokens: readonly string[], expected: string): boolean {
  return tokens.some((token) => token === expected);
}

function isCodexLikeAppServerProcess(entry: ProcessEntry, tokens: readonly string[]): boolean {
  const hasCodexBinary = /^codex(?:\.(?:cmd|exe|js))?$/iu.test(basenameToken(entry.name))
    || tokens.some((token) => /^codex(?:\.(?:cmd|exe|js))?$/iu.test(basenameToken(token)));
  return hasCodexBinary && tokensInclude(tokens, 'app-server');
}

function appServerListenUrlFromProcess(entry: ProcessEntry): string | null {
  const tokens = commandLineTokens(entry.commandLine);
  if (!isCodexLikeAppServerProcess(entry, tokens)) return null;
  return normalizeAppServerUrl(tokenOptionValue(tokens, ['--listen']));
}

function processListensOnAppServerUrl(entry: ProcessEntry, appServerUrl: string): boolean {
  return appServerListenUrlFromProcess(entry) === normalizeAppServerUrl(appServerUrl);
}

function appServerUrlTarget(input: {
  appServerUrl: string;
  processes: readonly ProcessEntry[];
}): AppServerUrlTarget {
  const url = validateAppServerUrl(input.appServerUrl, 'Forced App Server stop URL').href;
  const matches = input.processes.filter((entry) => processListensOnAppServerUrl(entry, url));
  const matchPids = new Set(matches.map((entry) => entry.pid));
  const roots = matches.filter((entry) => entry.parentPid === null || !matchPids.has(entry.parentPid));

  let pid: number | null = null;
  let processTree: ProcessEntry[] = [];
  let canStop = false;
  let stopReason = 'No running Codex App Server process was found for the requested URL.';

  if (matches.length > 0 && roots.length === 0) {
    stopReason = 'Codex App Server URL matched processes, but no safe process-tree root was found.';
  } else if (roots.length > 1) {
    stopReason = 'Codex App Server URL matched multiple independent process-tree roots; refusing ambiguous forced stop.';
  } else if (roots.length === 1) {
    pid = roots[0]?.pid ?? null;
    processTree = pid === null ? [] : collectProcessTree(input.processes, [pid]);
    canStop = pid !== null;
    stopReason = canStop
      ? 'Codex App Server process tree for the requested URL can be stopped with force.'
      : 'Codex App Server URL matched a process without a valid pid.';
  }

  return {
    url,
    pid,
    processTree,
    matchCount: matches.length,
    rootCount: roots.length,
    canStop,
    stopReason,
  };
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

function publicUrlTarget(target: AppServerUrlTarget, workspace: string, includeProcessTree = true): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: redactSensitiveText(target.url),
    pid: target.pid,
    canStop: target.canStop,
    stopReason: target.stopReason,
    matchCount: target.matchCount,
    rootCount: target.rootCount,
    processTreeCount: target.processTree.length,
  };
  if (includeProcessTree) {
    payload.processTree = redactValue(summarizeProcesses(target.processTree), { workspace });
  }
  return payload;
}

function forcedUrlStateUpdate(input: {
  workspace: string;
  expectedAppServerUrl: string;
}): Record<string, unknown> {
  const stateFile = appServerStateFileForWorkspace(input.workspace, 'primary');
  const stateRead = readAppServerStateFile(stateFile, 'primary');
  const stateUrl = validatedStateUrl(stateRead.state);
  if (!stateRead.exists || !stateRead.ok || stateUrl !== input.expectedAppServerUrl) {
    return {
      stateUpdated: false,
      reason: 'workspace launcher state did not point at the forced-stop App Server URL',
    };
  }

  writeAppServerState(stopStateFrom(stateRead.state, input.workspace), input.workspace);
  return {
    stateUpdated: true,
    reason: 'workspace launcher state pointed at the forced-stop App Server URL and was marked stopped',
  };
}

function appServerProcessStillMatches(input: {
  pid: number;
  expectedAppServerUrl: string;
  processes: readonly ProcessEntry[];
}): boolean {
  const process = input.processes.find((entry) => entry.pid === input.pid);
  return process !== undefined && processListensOnAppServerUrl(process, input.expectedAppServerUrl);
}

function reconcileDeadManagedState(input: {
  workspace: string;
  target: ManagedAppServerTarget;
  store: OperationStore;
}): Record<string, unknown> | null {
  const target = input.target;
  if (
    !target.stateExists
    || !target.stateOk
    || !target.owned
    || !target.workspaceMatches
    || target.pid === null
    || target.url === null
    || target.processAlive
  ) {
    return null;
  }

  const stateFile = appServerStateFileForWorkspace(input.workspace, 'primary');
  const stateRead = readAppServerStateFile(stateFile, 'primary');
  writeAppServerState(stopStateFrom(stateRead.state, input.workspace), input.workspace);

  const completedStopOperationIds: string[] = [];
  for (const operation of input.store.list()) {
    if (operation.kind !== 'app_server_stop' || operation.status !== 'running') continue;
    const existingEvidence = recordFrom(operation.evidence);
    input.store.complete(operation.id, {
      evidence: {
        ...existingEvidence,
        reconciliation: {
          reason: 'managed App Server process was already gone during status reconciliation',
          pid: target.pid,
          appServerUrl: target.url,
        },
      },
      nextAction: 'Managed App Server was already stopped; launcher state was reconciled to stopped.',
    });
    completedStopOperationIds.push(operation.id);
  }

  return {
    stateUpdated: true,
    reason: 'managed App Server process from launcher state was not running',
    pid: target.pid,
    appServerUrl: redactSensitiveText(target.url),
    completedStopOperationIds,
  };
}

function requestedStopEvidence(input: {
  workspace: string;
  timeoutMs: number;
  delayMs: number;
  appServerUrl?: string | undefined;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    workspacePreview: '<workspace>',
    timeoutMs: input.timeoutMs,
    delayMs: input.delayMs,
    scope: input.appServerUrl === undefined ? 'workspace-owned-app-server' : 'forced-app-server-url',
    remoteTuiWillBeStopped: false,
  };
  if (input.appServerUrl !== undefined) payload.appServerUrl = redactSensitiveText(input.appServerUrl);
  return payload;
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
    store?: OperationStore;
  } = {},
): Promise<Record<string, unknown>> {
  const workspace = resolveWorkspaceRoot(deps.workspace);
  const includeProcessTree = input.includeProcessTree ?? true;
  const probeReady = input.probeReady ?? true;
  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const processLister = deps.processLister ?? listProcesses;
  const readyProbe = deps.readyProbe ?? defaultReadyProbe;
  const store = deps.store ?? new OperationStore({ workspace });
  let target = managedAppServerTarget({
    workspace,
    processes: processLister(),
    includeProcessTree,
  });
  const ready = probeReady && target.url !== null
    ? {
        probed: true,
        ok: await readyProbe(target.url, readyTimeoutMs),
        timeoutMs: readyTimeoutMs,
      }
    : {
        probed: false,
        ok: null,
        timeoutMs: readyTimeoutMs,
      };
  const reconciliation = ready.ok === true ? null : reconcileDeadManagedState({ workspace, target, store });
  if (reconciliation !== null) {
    target = managedAppServerTarget({
      workspace,
      processes: processLister(),
      includeProcessTree,
    });
  }

  const payload: Record<string, unknown> = {
    ok: true,
    workspacePreview: '<workspace>',
    managedAppServer: publicTarget(target, workspace, includeProcessTree),
    notes: [
      'This inspects only the primary workspace-managed App Server launcher state.',
      'It does not inspect or stop user global MCP servers.',
    ],
  };
  if (reconciliation !== null) payload.reconciliation = reconciliation;
  payload.ready = ready;

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
  if (input.forceByUrl === true) args.push('--force-by-url');
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.delayMs !== undefined) args.push('--delay-ms', String(input.delayMs));
  return args;
}

export function parseAppServerStopOperationArgs(argv: readonly string[]): AppServerStopOperationInput {
  let operationId: string | undefined;
  let workspace: string | undefined;
  let expectedPid: number | undefined;
  let expectedAppServerUrl: string | undefined;
  let forceByUrl = false;
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
    } else if (arg === '--force-by-url') {
      forceByUrl = true;
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
  if (forceByUrl) operationInput.forceByUrl = true;
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
  const explicitAppServerUrl = input.appServerUrl === undefined
    ? undefined
    : validateAppServerUrl(input.appServerUrl, 'Forced App Server stop URL').href;
  const force = input.force === true;
  const processes = processLister();
  const target = explicitAppServerUrl === undefined
    ? managedAppServerTarget({
        workspace,
        processes,
      })
    : null;
  const stateFallbackAppServerUrl = explicitAppServerUrl === undefined
    && force
    && input.useStateUrl === true
    && target !== null
    && !target.canStop
    && target.url !== null
    ? target.url
    : undefined;
  const appServerUrl = explicitAppServerUrl ?? stateFallbackAppServerUrl;
  const requested = requestedStopEvidence({ workspace, timeoutMs, delayMs, appServerUrl });
  const urlTarget = appServerUrl === undefined
    ? null
    : appServerUrlTarget({ appServerUrl, processes });
  const targetPayload = target === null ? null : publicTarget(target, workspace);
  const urlTargetPayload = urlTarget === null ? null : publicUrlTarget(urlTarget, workspace);

  if (dryRun) {
    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      notes: [
        appServerUrl === undefined
          ? 'This only targets the primary workspace-managed App Server process tree.'
          : 'This targets a loopback Codex App Server process tree by URL only when force:true and confirm:true are supplied.',
        'It does not stop remote TUI windows or user global MCP server configuration.',
      ],
    };
    if (targetPayload !== null) payload.managedAppServer = targetPayload;
    if (urlTargetPayload !== null) payload.appServerUrlTarget = urlTargetPayload;
    return payload;
  }

  if (!confirm) {
    const payload: Record<string, unknown> = {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      message: 'Pass confirm:true with dryRun:false to schedule App Server stop.',
    };
    if (targetPayload !== null) payload.managedAppServer = targetPayload;
    if (urlTargetPayload !== null) payload.appServerUrlTarget = urlTargetPayload;
    return payload;
  }

  if (appServerUrl !== undefined && !force) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: false,
      forceRequired: true,
      ...requested,
      appServerUrlTarget: urlTargetPayload,
      message: 'Stopping an App Server by URL requires force:true in addition to confirm:true.',
    };
  }

  const selectedManagedTarget = target?.canStop === true ? target : null;
  const selectedUrlTarget = selectedManagedTarget === null && urlTarget?.canStop === true ? urlTarget : null;
  const selectedPid = selectedManagedTarget?.pid ?? selectedUrlTarget?.pid ?? null;
  const selectedUrl = selectedManagedTarget?.url ?? selectedUrlTarget?.url ?? null;
  const selectedForceByUrl = selectedManagedTarget === null && selectedUrlTarget !== null;
  const canStop = selectedManagedTarget !== null || selectedUrlTarget !== null;
  if (!canStop || selectedPid === null || selectedUrl === null) {
    const payload: Record<string, unknown> = {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: false,
      ...requested,
      message: appServerUrl === undefined
        ? 'No owned running workspace App Server target is safe to stop.'
        : 'No running Codex App Server target for the requested URL is safe to stop.',
    };
    if (targetPayload !== null) payload.managedAppServer = targetPayload;
    if (urlTargetPayload !== null) payload.appServerUrlTarget = urlTargetPayload;
    return payload;
  }

  const operation = store.create({
    kind: 'app_server_stop',
    status: 'running',
    evidence: {
      requested,
      ...(targetPayload === null ? {} : { managedAppServer: targetPayload }),
      ...(urlTargetPayload === null ? {} : { appServerUrlTarget: urlTargetPayload }),
    },
    nextAction: STOP_NEXT_ACTION,
  });

  try {
    const background = scheduler({
      operationId: operation.id,
      workspace,
      expectedPid: selectedPid,
      expectedAppServerUrl: selectedUrl,
      ...(selectedForceByUrl ? { forceByUrl: true } : {}),
      timeoutMs,
      delayMs,
    });
    const updatedOperation =
      store.update(operation.id, {
        evidence: {
          requested,
          ...(targetPayload === null ? {} : { managedAppServer: targetPayload }),
          ...(urlTargetPayload === null ? {} : { appServerUrlTarget: urlTargetPayload }),
          background,
        },
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
      evidence: {
        requested,
        ...(targetPayload === null ? {} : { managedAppServer: targetPayload }),
        ...(urlTargetPayload === null ? {} : { appServerUrlTarget: urlTargetPayload }),
        background: { scheduled: false },
      },
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
  const requested = requestedStopEvidence({
    workspace,
    timeoutMs,
    delayMs,
    appServerUrl: input.forceByUrl === true ? input.expectedAppServerUrl : undefined,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };

  try {
    if (delayMs > 0) await sleep(delayMs);
    const processes = processLister();
    const stateFile = appServerStateFileForWorkspace(workspace, 'primary');
    const stateRead = readAppServerStateFile(stateFile, 'primary');
    const state = stateRead.state;
    if (input.forceByUrl === true) {
      if (!appServerProcessStillMatches({
        pid: input.expectedPid,
        expectedAppServerUrl: input.expectedAppServerUrl,
        processes,
      })) {
        return store.fail(input.operationId, {
          failure: {
            name: 'AppServerProcessChanged',
            message: 'Codex App Server process no longer matches the expected forced-stop URL.',
          },
          evidence: {
            ...evidence,
            current: {
              appServerUrlTarget: publicUrlTarget(appServerUrlTarget({
                appServerUrl: input.expectedAppServerUrl,
                processes,
              }), workspace),
            },
          },
          nextAction: 'Inspect current App Server process evidence before retrying.',
        });
      }
    } else {
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
            current: publicTarget(managedAppServerTarget({ workspace, processes }), workspace),
          },
          nextAction: 'Inspect current App Server state before retrying.',
        });
      }
    }

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
      evidence.state = input.forceByUrl === true
        ? forcedUrlStateUpdate({ workspace, expectedAppServerUrl: input.expectedAppServerUrl })
        : { stateUpdated: true, reason: 'workspace-owned launcher state was marked stopped' };
      if (input.forceByUrl !== true) {
        writeAppServerState(stopStateFrom(state, workspace), workspace);
      }
      return store.complete(input.operationId, {
        evidence,
        nextAction: input.forceByUrl === true
          ? 'Forced App Server URL stopped. Start/reuse an App Server again with codex_app_server_start or npm run remote.'
          : 'Managed App Server stopped. Start/reuse it again with codex_app_server_start or npm run remote.',
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
