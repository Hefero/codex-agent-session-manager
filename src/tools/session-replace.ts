import { spawn } from 'node:child_process';
import { z } from 'zod';

import { resolveAppServerUrl } from '../app-server/config.js';
import {
  findRemoteTuiTargets,
  listProcesses,
  summarizeProcesses,
  stopProcessTree,
  type ProcessEntry,
} from '../processes.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';
import {
  buildCodexArgs,
  launchCodexRemote,
  launchPlanPreview,
  resolveCodexDetachedTerminalCommand,
  type LaunchExecutionResult,
  type LaunchExecutor,
  type LaunchPlan,
} from './session-launch.js';
import { stopRemoteRoots, waitForRemoteGone, type ProcessLister, type ProcessStopper } from './session-close.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const MAX_PROMPT_CHARS = 4_000;
const REPLACE_PROMPT_ENV = 'CODEX_AGENT_SESSION_MANAGER_REPLACE_PROMPT';
const INTERNAL_COMMAND = 'run-session-replace-operation';
const REPLACE_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then inspect replacement evidence.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

export const sessionReplaceInputSchema = {
  appServerUrl: appServerUrlSchema,
  threadId: z.string().min(1).describe('Explicit thread id to close and resume. Required.'),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().describe('Optional initial prompt for the replacement TUI. Do not include secrets.'),
  dryRun: z.boolean().optional().describe('Defaults true. When true, only returns close and launch plan evidence.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
  bypassSandbox: z.boolean().optional().describe('When true, passes --dangerously-bypass-approvals-and-sandbox for trusted local workspaces.'),
  enableImageGeneration: z.boolean().optional().describe('When true, does not pass --disable image_generation.'),
  timeoutMs: z.number().int().min(0).max(MAX_TIMEOUT_MS).optional().describe('Maximum wait time for matching old remote TUI processes to stop.'),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Delay before the detached child closes and relaunches.'),
};

const sessionReplaceInputObject = z.object(sessionReplaceInputSchema);
type SessionReplaceInput = z.infer<typeof sessionReplaceInputObject>;

export interface SessionReplaceOperationInput {
  operationId: string;
  appServerUrl: string;
  workspace: string;
  threadId: string;
  bypassSandbox?: boolean;
  enableImageGeneration?: boolean;
  timeoutMs?: number;
  delayMs?: number;
}

export interface SessionReplaceBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesPrompt: false;
  promptTransport: 'environment';
  delayMs: number;
}

export type SessionReplaceScheduler = (input: SessionReplaceOperationInput, prompt: string | null) => SessionReplaceBackgroundEvidence;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function publicFailure(error: unknown, promptToRedact?: string | null): unknown {
  const prompt = promptToRedact ?? '';
  const scrub = (text: string): string => {
    const redacted = redactSensitiveText(text);
    return prompt.length > 0 ? redacted.split(prompt).join('<redacted:replace-prompt>') : redacted;
  };
  if (error instanceof Error) {
    return {
      name: error.name,
      message: scrub(error.message),
    };
  }
  return scrub(String(redactValue(String(error))));
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function requestedEvidence(input: {
  appServerUrl: string;
  workspace: string;
  threadId: string;
  prompt: string | null;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  timeoutMs?: number | undefined;
  delayMs?: number | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: redactSensitiveText(input.appServerUrl),
    workspacePreview: '<workspace>',
    threadId: input.threadId,
    promptProvided: Boolean(input.prompt && input.prompt.length > 0),
    promptCharCount: input.prompt?.length ?? 0,
    promptTransport: 'environment',
    bypassSandbox: input.bypassSandbox === true,
    enableImageGeneration: input.enableImageGeneration === true,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    delayMs: input.delayMs ?? DEFAULT_DELAY_MS,
    startsAppServer: false,
    closeScope: 'explicit-thread',
  };
}

function closePlan(input: {
  processes: readonly ProcessEntry[];
  appServerUrl: string;
  workspace: string;
  threadId: string;
}): Record<string, unknown> {
  const targets = findRemoteTuiTargets(input.processes, {
    appServerUrl: input.appServerUrl,
    workspace: input.workspace,
    threadId: input.threadId,
  });
  return {
    targetCount: targets.roots.length,
    remoteProcessCount: targets.remoteProcesses.length,
    targets: redactValue(summarizeProcesses(targets.roots), { workspace: input.workspace }),
  };
}

function replacementLaunchPlan(input: {
  codexCommand: string;
  appServerUrl: string;
  workspace: string;
  threadId: string;
  prompt: string | null;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): LaunchPlan {
  return {
    codexCommand: input.codexCommand,
    args: buildCodexArgs({
      appServerUrl: input.appServerUrl,
      workspace: input.workspace,
      mode: 'session',
      threadId: input.threadId,
      prompt: input.prompt,
      bypassSandbox: input.bypassSandbox,
      enableImageGeneration: input.enableImageGeneration,
    }),
    workspace: input.workspace,
    appServerUrl: input.appServerUrl,
    mode: 'session',
    promptIncluded: Boolean(input.prompt && input.prompt.length > 0),
  };
}

function promptFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const prompt = env[REPLACE_PROMPT_ENV];
  if (prompt === undefined) return null;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Replacement prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return prompt;
}

function childEnvWithPrompt(prompt: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[REPLACE_PROMPT_ENV];
  if (prompt !== null) env[REPLACE_PROMPT_ENV] = prompt;
  return env;
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  workspace: string;
  threadId: string;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  timeoutMs?: number | undefined;
  delayMs?: number | undefined;
}): SessionReplaceOperationInput {
  const operationInput: SessionReplaceOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
    workspace: input.workspace,
    threadId: input.threadId,
  };
  if (input.bypassSandbox !== undefined) operationInput.bypassSandbox = input.bypassSandbox;
  if (input.enableImageGeneration !== undefined) operationInput.enableImageGeneration = input.enableImageGeneration;
  if (input.timeoutMs !== undefined) operationInput.timeoutMs = input.timeoutMs;
  if (input.delayMs !== undefined) operationInput.delayMs = input.delayMs;
  return operationInput;
}

export function buildSessionReplaceOperationArgs(input: SessionReplaceOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--app-server-url',
    input.appServerUrl,
    '--workspace',
    input.workspace,
    '--thread-id',
    input.threadId,
  ];
  if (input.bypassSandbox === true) args.push('--bypass-sandbox');
  if (input.enableImageGeneration === true) args.push('--enable-image-generation');
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  if (input.delayMs !== undefined) args.push('--delay-ms', String(input.delayMs));
  return args;
}

export function parseSessionReplaceOperationArgs(argv: readonly string[]): SessionReplaceOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let workspace: string | undefined;
  let threadId: string | undefined;
  let bypassSandbox: boolean | undefined;
  let enableImageGeneration: boolean | undefined;
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
    } else if (arg === '--workspace' && value !== undefined) {
      workspace = value;
      index += 1;
    } else if (arg === '--thread-id' && value !== undefined) {
      threadId = value;
      index += 1;
    } else if (arg === '--bypass-sandbox') {
      bypassSandbox = true;
    } else if (arg === '--enable-image-generation') {
      enableImageGeneration = true;
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
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);
  if (!threadId) throw new Error(`${INTERNAL_COMMAND} requires --thread-id.`);

  return operationInputForOptionalValues({
    operationId,
    appServerUrl: resolveAppServerUrl(appServerUrl),
    workspace: resolveWorkspaceRoot(workspace),
    threadId,
    bypassSandbox,
    enableImageGeneration,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
  });
}

export function spawnSessionReplaceOperation(input: SessionReplaceOperationInput, prompt: string | null): SessionReplaceBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule session replacement because the current CLI entry path is unavailable.');
  }
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildSessionReplaceOperationArgs(input)], {
    cwd: input.workspace,
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
    delayMs,
  };
}

export function buildSessionReplacePayload(
  input: SessionReplaceInput,
  deps: {
    store?: OperationStore;
    scheduler?: SessionReplaceScheduler;
    processLister?: ProcessLister;
    codexCommandResolver?: () => string;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnSessionReplaceOperation;
  const processLister = deps.processLister ?? listProcesses;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexDetachedTerminalCommand;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolveWorkspaceRoot();
  const prompt = input.prompt ?? null;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const dryRun = input.dryRun ?? true;
  const confirm = input.confirm === true;
  const requested = requestedEvidence({
    appServerUrl,
    workspace,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
    timeoutMs,
    delayMs,
  });
  const processes = processLister();
  const close = closePlan({ processes, appServerUrl, workspace, threadId: input.threadId });
  const launch = launchPlanPreview(
    replacementLaunchPlan({
      codexCommand: codexCommandResolver(),
      appServerUrl,
      workspace,
      threadId: input.threadId,
      prompt,
      bypassSandbox: input.bypassSandbox,
      enableImageGeneration: input.enableImageGeneration,
    }),
  );

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      close,
      launch,
    };
  }

  if (!confirm) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      close,
      launch,
      message: 'Pass confirm:true with dryRun:false to schedule remote TUI replacement.',
    };
  }

  const operation = store.create({
    kind: 'session_replace',
    status: 'running',
    evidence: { requested, close, launch },
    nextAction: REPLACE_NEXT_ACTION,
  });

  try {
    const background = scheduler(
      operationInputForOptionalValues({
        operationId: operation.id,
        appServerUrl,
        workspace,
        threadId: input.threadId,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
        timeoutMs,
        delayMs,
      }),
      prompt,
    );
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, close, launch, background },
        nextAction: REPLACE_NEXT_ACTION,
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
      failure: publicFailure(error, prompt),
      evidence: { requested, close, launch, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

export async function runSessionReplaceOperation(
  input: SessionReplaceOperationInput,
  deps: {
    store?: OperationStore;
    processLister?: ProcessLister;
    processStopper?: ProcessStopper;
    codexCommandResolver?: () => string;
    launchExecutor?: LaunchExecutor;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OperationRecord | null> {
  const store = deps.store ?? operationStore;
  const processLister = deps.processLister ?? listProcesses;
  const processStopper = deps.processStopper ?? stopProcessTree;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexDetachedTerminalCommand;
  const launchExecutor = deps.launchExecutor ?? launchCodexRemote;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolveWorkspaceRoot(input.workspace);
  const prompt = promptFromEnv(deps.env);
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS);
  const delayMs = boundedInteger(input.delayMs, DEFAULT_DELAY_MS, 0, MAX_DELAY_MS);
  const requested = requestedEvidence({
    appServerUrl,
    workspace,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
    timeoutMs,
    delayMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);
  const evidence: Record<string, unknown> = { ...existingEvidence, requested };

  try {
    if (delayMs > 0) await sleep(delayMs);
    const processes = processLister();
    const targets = findRemoteTuiTargets(processes, { appServerUrl, workspace, threadId: input.threadId });
    evidence.close = {
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
    if ((stopped as { ok?: unknown }).ok !== true) {
      return store.fail(input.operationId, {
        failure: { name: 'RemoteTuiStillRunning', message: 'Matching remote TUI processes remained after timeout.' },
        evidence,
        nextAction: 'Inspect remaining process evidence before retrying replacement.',
      });
    }

    const plan = replacementLaunchPlan({
      codexCommand: codexCommandResolver(),
      appServerUrl,
      workspace,
      threadId: input.threadId,
      prompt,
      bypassSandbox: input.bypassSandbox,
      enableImageGeneration: input.enableImageGeneration,
    });
    evidence.launch = launchPlanPreview(plan);
    const launched: LaunchExecutionResult = await launchExecutor(plan);
    evidence.launched = redactValue(launched, { workspace });

    if (launched.ok) {
      return store.complete(input.operationId, {
        evidence,
        nextAction: 'Replacement launch was scheduled. Use the replacement turn for callable proof.',
      });
    }
    return store.fail(input.operationId, {
      failure: { name: 'SessionReplaceLaunchFailed', message: 'Replacement launcher returned a non-ok result.' },
      evidence,
      nextAction: 'Inspect launch stderr/stdout before retrying.',
    });
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error, prompt),
      evidence,
      nextAction: 'Inspect failure details with codex_operation_read before retrying.',
    });
  }
}

export async function runSessionReplaceOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runSessionReplaceOperation(parseSessionReplaceOperationArgs(argv));
}
