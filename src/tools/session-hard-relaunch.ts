import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { PRIMARY_STATE_DIR_NAME } from '../app-server/state.js';
import {
  commandLineTokens,
  collectProcessTree,
  listProcesses,
  stopProcessTree,
  summarizeProcesses,
  type ProcessEntry,
  type ProcessSummary,
} from '../processes.js';
import { redactArgv, redactSensitiveText, redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot, workspacePath } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';
import { resolveCodexDetachedTerminalCommand, type LaunchExecutionResult } from './session-launch.js';

const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const MAX_PROMPT_CHARS = 4_000;
const HARD_RELAUNCH_PROMPT_ENV = 'CODEX_AGENT_SESSION_MANAGER_HARD_RELAUNCH_PROMPT';
const INTERNAL_COMMAND = 'run-session-hard-relaunch-operation';
type HardRelaunchHandoffMode = 'detached' | 'shell-resume-next';
type HardRelaunchResumeMode = 'current' | 'fresh';

export const sessionHardRelaunchInputSchema = {
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().describe('Optional initial prompt for the relaunched Codex TUI. Do not include secrets; Codex receives this prompt through its CLI argument surface.'),
  resumeMode: z.enum(['current', 'fresh']).optional().describe('Defaults "current". Resumes the current thread when threadId is supplied or can be inferred from process ancestry. Use "fresh" only as an explicit fallback to start a new thread.'),
  threadId: z.string().min(1).optional().describe('Optional thread id to resume. Recommended when the current plain Codex command line does not include a resumable thread id.'),
  handoffMode: z.enum(['detached', 'shell-resume-next']).optional().describe('Defaults "detached". Use "shell-resume-next" only with the opt-in shell hook; it writes resume-next state and closes the current TUI instead of opening a new window.'),
  dryRun: z.boolean().optional().describe('Defaults true. When true, only reports current-process target and launch plan.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
  bypassSandbox: z.boolean().optional().describe('When true, passes --dangerously-bypass-approvals-and-sandbox for trusted local workspaces.'),
  enableImageGeneration: z.boolean().optional().describe('When true, does not pass --disable image_generation.'),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Delay before the detached child launches the new TUI and closes the current one.'),
};

const sessionHardRelaunchInputObject = z.object(sessionHardRelaunchInputSchema);
type SessionHardRelaunchInput = z.infer<typeof sessionHardRelaunchInputObject>;

export interface SessionHardRelaunchOperationInput {
  operationId: string;
  workspace: string;
  targetRootPid: number;
  bypassSandbox?: boolean;
  enableImageGeneration?: boolean;
  delayMs?: number;
  handoffMode?: HardRelaunchHandoffMode;
  resumeMode?: HardRelaunchResumeMode;
  threadId?: string;
}

export interface SessionHardRelaunchBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesPrompt: false;
  promptTransport: 'environment';
  handoffMode: HardRelaunchHandoffMode;
  delayMs: number;
}

export interface PlainCodexLaunchPlan {
  codexCommand: string;
  args: string[];
  workspace: string;
  promptIncluded: boolean;
}

export type SessionHardRelaunchScheduler = (input: SessionHardRelaunchOperationInput, prompt: string | null) => SessionHardRelaunchBackgroundEvidence;
export type PlainCodexLaunchExecutor = (plan: PlainCodexLaunchPlan) => LaunchExecutionResult | Promise<LaunchExecutionResult>;
export type ProcessLister = () => ProcessEntry[];
export type ProcessStopper = (rootPid: number, tree: readonly ProcessEntry[]) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

interface CurrentSessionTarget {
  currentPid: number;
  root: ProcessEntry;
  ancestry: ProcessEntry[];
  tree: ProcessEntry[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function basenameToken(token: unknown): string {
  return String(token ?? '')
    .replace(/^["']+|["']+$/gu, '')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? '';
}

function isShellProcess(entry: ProcessEntry): boolean {
  return /^(?:cmd|powershell|pwsh)(?:\.exe)?$/iu.test(basenameToken(entry.name));
}

function isCodexLikeProcess(entry: ProcessEntry): boolean {
  const commandLine = entry.commandLine.replace(/\\/gu, '/');
  return /^codex(?:\.(?:cmd|exe|js))?$/iu.test(basenameToken(entry.name))
    || /(?:^|[/"'\s])codex(?:\.(?:cmd|exe|js))?(?:["'\s]|$)/iu.test(commandLine);
}

function commandReferencesCodex(entry: ProcessEntry): boolean {
  return /codex(?:\.(?:cmd|exe|js))?/iu.test(entry.commandLine);
}

function commandReferencesWorkspace(entry: ProcessEntry, workspace: string): boolean {
  return entry.commandLine.replace(/\\/gu, '/').toLowerCase().includes(workspace.replace(/\\/gu, '/').toLowerCase());
}

function isAppServerLike(entry: ProcessEntry): boolean {
  return /(?:^|\s)app-server(?:\s|$)/iu.test(entry.commandLine);
}

function targetScore(entry: ProcessEntry, workspace: string): number {
  if (isAppServerLike(entry)) return 0;
  const workspaceMatch = commandReferencesWorkspace(entry, workspace);
  if (isShellProcess(entry) && commandReferencesCodex(entry) && workspaceMatch) return 40;
  if (isCodexLikeProcess(entry) && workspaceMatch) return 30;
  if (isShellProcess(entry) && commandReferencesCodex(entry)) return 20;
  if (isCodexLikeProcess(entry)) return 10;
  return 0;
}

function processByPid(processes: readonly ProcessEntry[]): Map<number, ProcessEntry> {
  return new Map(processes.map((entry) => [entry.pid, entry]));
}

function processAncestry(processes: readonly ProcessEntry[], currentPid: number): ProcessEntry[] {
  const byPid = processByPid(processes);
  const ancestry: ProcessEntry[] = [];
  const seen = new Set<number>();
  let current = byPid.get(currentPid);
  while (current && !seen.has(current.pid) && ancestry.length < 100) {
    seen.add(current.pid);
    ancestry.push(current);
    current = current.parentPid === null ? undefined : byPid.get(current.parentPid);
  }
  return ancestry;
}

export function findCurrentCodexSessionTarget(input: {
  processes: readonly ProcessEntry[];
  workspace: string;
  currentPid?: number;
}): CurrentSessionTarget | null {
  const currentPid = input.currentPid ?? process.pid;
  const ancestry = processAncestry(input.processes, currentPid);
  if (ancestry.length === 0) return null;

  let best: ProcessEntry | null = null;
  let bestScore = 0;
  for (const entry of ancestry) {
    const score = targetScore(entry, input.workspace);
    if (score >= bestScore && score > 0) {
      best = entry;
      bestScore = score;
    }
  }
  if (best === null) return null;
  return {
    currentPid,
    root: best,
    ancestry,
    tree: collectProcessTree(input.processes, [best.pid]),
  };
}

function buildPlainCodexArgs(input: {
  workspace: string;
  prompt: string | null;
  resumeMode: HardRelaunchResumeMode;
  threadId?: string | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): string[] {
  const args: string[] = [];
  if (input.resumeMode === 'current') {
    if (input.threadId === undefined || input.threadId.length === 0) {
      throw new Error('Hard relaunch resumeMode=current requires threadId.');
    }
    args.push('resume', input.threadId);
  }
  args.push('--disable', 'js_repl');
  if (input.enableImageGeneration !== true) args.push('--disable', 'image_generation');
  if (input.bypassSandbox === true) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('-C', input.workspace);
  if (input.prompt && input.prompt.length > 0) args.push(input.prompt);
  return args;
}

function plainLaunchPlan(input: {
  codexCommand: string;
  workspace: string;
  prompt: string | null;
  resumeMode: HardRelaunchResumeMode;
  threadId?: string | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): PlainCodexLaunchPlan {
  return {
    codexCommand: input.codexCommand,
    args: buildPlainCodexArgs(input),
    workspace: input.workspace,
    promptIncluded: Boolean(input.prompt && input.prompt.length > 0),
  };
}

function launchPlanPreview(plan: PlainCodexLaunchPlan): Record<string, unknown> {
  const args = plan.args.map((arg) => (plan.promptIncluded && arg === plan.args.at(-1) ? '<prompt>' : arg));
  return {
    command: redactSensitiveText(plan.codexCommand),
    args: redactArgv(args, { workspace: plan.workspace }),
    cwd: '<workspace>',
    mode: plan.args[0] === 'resume' ? 'plain-codex-resume' : 'plain-codex-fresh',
    promptIncluded: plan.promptIncluded,
    startsAppServer: false,
    usesAppServerTurnStart: false,
  };
}

function shellResumeNextPreview(input: {
  workspace: string;
  prompt: string | null;
  resumeMode: HardRelaunchResumeMode;
  threadId?: string | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): Record<string, unknown> {
  return {
    mode: 'shell-resume-next',
    statePath: `<workspace>/${PRIMARY_STATE_DIR_NAME}/state/shell-resume-next.json`,
    stateMode: 'managed-remote',
    resumeMode: input.resumeMode,
    threadId: input.threadId ?? null,
    promptIncluded: Boolean(input.prompt && input.prompt.length > 0),
    bypassSandbox: input.bypassSandbox === true,
    enableImageGeneration: input.enableImageGeneration === true,
    startsAppServer: true,
    startsManagedRemote: true,
    startsAppServerTiming: 'after-old-tui-exits-via-shell-hook',
    usesAppServerTurnStart: false,
    requiresShellHook: true,
  };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function psArrayLiteral(values: readonly string[]): string {
  return `@(${values.map(psQuote).join(',')})`;
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function cmdWrappedCommandLine(command: string, args: readonly string[]): string {
  return `"${[command, ...args].map(cmdQuote).join(' ')}"`;
}

function threadIdFromCommandLine(commandLine: string): string | null {
  const tokens = commandLineTokens(commandLine);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === 'resume') {
      const candidate = tokens[index + 1];
      if (candidate && !candidate.startsWith('-')) return candidate;
    }
    if (tokens[index] === '--session-id') {
      const candidate = tokens[index + 1];
      if (candidate && !candidate.startsWith('-')) return candidate;
    }
  }
  return null;
}

function inferCurrentThreadId(target: CurrentSessionTarget): string | null {
  for (const entry of target.ancestry) {
    const threadId = threadIdFromCommandLine(entry.commandLine);
    if (threadId !== null) return threadId;
  }
  return null;
}

function resolveResume(input: {
  requestedMode: HardRelaunchResumeMode;
  explicitThreadId: string | null;
  target: CurrentSessionTarget;
}):
  | { ok: true; resumeMode: HardRelaunchResumeMode; threadId?: string | undefined; source: 'explicit' | 'inferred' | 'fresh' }
  | { ok: false; evidence: Record<string, unknown>; message: string } {
  if (input.requestedMode === 'fresh') {
    if (input.explicitThreadId !== null) {
      return {
        ok: false,
        evidence: {
          resumeMode: 'fresh',
          threadId: input.explicitThreadId,
          resolved: false,
          reason: 'threadId-with-fresh-mode',
        },
        message: 'codex_session_hard_relaunch received threadId with resumeMode=fresh. Omit threadId or use resumeMode=current.',
      };
    }
    return { ok: true, resumeMode: 'fresh', source: 'fresh' };
  }

  if (input.explicitThreadId !== null) {
    return { ok: true, resumeMode: 'current', threadId: input.explicitThreadId, source: 'explicit' };
  }

  const inferredThreadId = inferCurrentThreadId(input.target);
  if (inferredThreadId !== null) {
    return { ok: true, resumeMode: 'current', threadId: inferredThreadId, source: 'inferred' };
  }

  return {
    ok: false,
    evidence: {
      resumeMode: 'current',
      threadId: null,
      resolved: false,
      reason: 'thread-id-not-inferable',
    },
    message: 'Could not infer the current thread id from this Codex process ancestry. Pass threadId to resume, or pass resumeMode="fresh" to explicitly start a new thread.',
  };
}

export function launchPlainCodex(plan: PlainCodexLaunchPlan): LaunchExecutionResult {
  if (process.platform === 'win32') {
    const commandLine = cmdWrappedCommandLine(plan.codexCommand, plan.args);
    const command = [
      `Start-Process -FilePath ${psQuote('cmd.exe')}`,
      `-WorkingDirectory ${psQuote(plan.workspace)}`,
      '-WindowStyle Normal',
      `-ArgumentList ${psArrayLiteral(['/c', commandLine])}`,
    ].join(' ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd: plan.workspace,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    return {
      ok: result.status === 0,
      mode: 'windows-cmd-shim-terminal',
      exitCode: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  const child = spawn(plan.codexCommand, plan.args, {
    cwd: plan.workspace,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
  return {
    ok: typeof child.pid === 'number' && child.pid > 0,
    mode: 'detached-process',
    pid: child.pid ?? null,
  };
}

function requestedEvidence(input: {
  workspace: string;
  currentPid: number;
  prompt: string | null;
  handoffMode: HardRelaunchHandoffMode;
  resumeMode: HardRelaunchResumeMode;
  threadId: string | null;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  delayMs: number;
}): Record<string, unknown> {
  return {
    workspacePreview: '<workspace>',
    currentPid: input.currentPid,
    promptProvided: Boolean(input.prompt && input.prompt.length > 0),
    promptCharCount: input.prompt?.length ?? 0,
    promptTransport: 'environment',
    handoffMode: input.handoffMode,
    resumeMode: input.resumeMode,
    threadId: input.threadId,
    backgroundPromptTransport: 'environment',
    backgroundChildArgvIncludesPrompt: false,
    relaunchedCodexPromptTransport: input.handoffMode === 'shell-resume-next' ? 'state-file-then-managed-remote' : 'argv',
    relaunchedCodexPromptInProcessCommandLine: Boolean(input.prompt && input.prompt.length > 0),
    shellResumeNextStateWritesPrompt: input.handoffMode === 'shell-resume-next' && Boolean(input.prompt && input.prompt.length > 0),
    shellResumeNextTarget: input.handoffMode === 'shell-resume-next' ? 'managed-remote' : null,
    bypassSandbox: input.bypassSandbox === true,
    enableImageGeneration: input.enableImageGeneration === true,
    delayMs: input.delayMs,
    startsAppServer: input.handoffMode === 'shell-resume-next',
    startsAppServerTiming: input.handoffMode === 'shell-resume-next' ? 'after-old-tui-exits-via-shell-hook' : null,
    usesAppServerTurnStart: false,
    closeScope: 'current-process-ancestry',
  };
}

function nextActionForHandoffMode(handoffMode: HardRelaunchHandoffMode): string {
  if (handoffMode === 'shell-resume-next') {
    return 'Let this tool call return. A detached child will write managed-remote shell resume-next state, then attempt to stop the current TUI. The opt-in shell hook must relaunch through codex-agent-session-manager remote in the same terminal.';
  }
  return 'Let this tool call return. A detached child will relaunch plain Codex, resuming the selected thread unless resumeMode=fresh was explicitly requested, then attempt to stop the current TUI process tree.';
}

function targetPreview(target: CurrentSessionTarget, workspace: string): Record<string, unknown> {
  return {
    currentPid: target.currentPid,
    rootPid: target.root.pid,
    root: redactValue(summarizeProcesses([target.root])[0], { workspace }),
    ancestry: redactValue(summarizeProcesses(target.ancestry), { workspace }) as ProcessSummary[],
    treeProcessCount: target.tree.length,
    tree: redactValue(summarizeProcesses(target.tree), { workspace }) as ProcessSummary[],
  };
}

function publicFailure(error: unknown, promptToRedact?: string | null): unknown {
  const prompt = promptToRedact ?? '';
  const scrub = (text: string): string => {
    const redacted = redactSensitiveText(text);
    return prompt.length > 0 ? redacted.split(prompt).join('<redacted:hard-relaunch-prompt>') : redacted;
  };
  if (error instanceof Error) {
    return {
      name: error.name,
      message: scrub(error.message),
    };
  }
  return scrub(String(redactValue(String(error))));
}

function promptFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const prompt = env[HARD_RELAUNCH_PROMPT_ENV];
  if (prompt === undefined) return null;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Hard relaunch prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return prompt;
}

function childEnvWithPrompt(prompt: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[HARD_RELAUNCH_PROMPT_ENV];
  if (prompt !== null) env[HARD_RELAUNCH_PROMPT_ENV] = prompt;
  return env;
}

function writeShellResumeNextState(input: {
  workspace: string;
  operationId: string;
  prompt: string | null;
  resumeMode: HardRelaunchResumeMode;
  threadId?: string | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): Record<string, unknown> {
  const statePath = workspacePath(input.workspace, PRIMARY_STATE_DIR_NAME, 'state', 'shell-resume-next.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      mode: 'managed-remote',
      operationId: input.operationId,
      createdAt: new Date().toISOString(),
      resumeMode: input.resumeMode,
      threadId: input.threadId ?? null,
      prompt: input.prompt ?? '',
      promptProvided: Boolean(input.prompt && input.prompt.length > 0),
      bypassSandbox: input.bypassSandbox === true,
      enableImageGeneration: input.enableImageGeneration === true,
    }, null, 2)}\n`,
    'utf8',
  );
  return {
    statePath: `<workspace>/${PRIMARY_STATE_DIR_NAME}/state/shell-resume-next.json`,
    promptStored: Boolean(input.prompt && input.prompt.length > 0),
    promptCharCount: input.prompt?.length ?? 0,
    mode: 'managed-remote',
    resumeMode: input.resumeMode,
    threadId: input.threadId ?? null,
  };
}

function operationInputForOptionalValues(input: {
  operationId: string;
  workspace: string;
  targetRootPid: number;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  delayMs?: number | undefined;
  handoffMode?: HardRelaunchHandoffMode | undefined;
  resumeMode?: HardRelaunchResumeMode | undefined;
  threadId?: string | undefined;
}): SessionHardRelaunchOperationInput {
  const operationInput: SessionHardRelaunchOperationInput = {
    operationId: input.operationId,
    workspace: input.workspace,
    targetRootPid: input.targetRootPid,
  };
  if (input.bypassSandbox !== undefined) operationInput.bypassSandbox = input.bypassSandbox;
  if (input.enableImageGeneration !== undefined) operationInput.enableImageGeneration = input.enableImageGeneration;
  if (input.delayMs !== undefined) operationInput.delayMs = input.delayMs;
  if (input.handoffMode !== undefined) operationInput.handoffMode = input.handoffMode;
  if (input.resumeMode !== undefined) operationInput.resumeMode = input.resumeMode;
  if (input.threadId !== undefined) operationInput.threadId = input.threadId;
  return operationInput;
}

export function buildSessionHardRelaunchOperationArgs(input: SessionHardRelaunchOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--workspace',
    input.workspace,
    '--target-root-pid',
    String(input.targetRootPid),
  ];
  if (input.bypassSandbox === true) args.push('--bypass-sandbox');
  if (input.enableImageGeneration === true) args.push('--enable-image-generation');
  if (input.delayMs !== undefined) args.push('--delay-ms', String(input.delayMs));
  if (input.handoffMode !== undefined) args.push('--handoff-mode', input.handoffMode);
  if (input.resumeMode !== undefined) args.push('--resume-mode', input.resumeMode);
  if (input.threadId !== undefined) args.push('--thread-id', input.threadId);
  return args;
}

export function parseSessionHardRelaunchOperationArgs(argv: readonly string[]): SessionHardRelaunchOperationInput {
  let operationId: string | undefined;
  let workspace: string | undefined;
  let targetRootPid: number | undefined;
  let bypassSandbox: boolean | undefined;
  let enableImageGeneration: boolean | undefined;
  let delayMs: number | undefined;
  let handoffMode: HardRelaunchHandoffMode | undefined;
  let resumeMode: HardRelaunchResumeMode | undefined;
  let threadId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--operation-id' && value !== undefined) {
      operationId = value;
      index += 1;
    } else if (arg === '--workspace' && value !== undefined) {
      workspace = value;
      index += 1;
    } else if (arg === '--target-root-pid' && value !== undefined) {
      targetRootPid = Number(value);
      index += 1;
    } else if (arg === '--bypass-sandbox') {
      bypassSandbox = true;
    } else if (arg === '--enable-image-generation') {
      enableImageGeneration = true;
    } else if (arg === '--delay-ms' && value !== undefined) {
      delayMs = Number(value);
      index += 1;
    } else if (arg === '--handoff-mode' && value !== undefined) {
      if (value !== 'detached' && value !== 'shell-resume-next') {
        throw new Error(`${INTERNAL_COMMAND} received invalid --handoff-mode.`);
      }
      handoffMode = value;
      index += 1;
    } else if (arg === '--resume-mode' && value !== undefined) {
      if (value !== 'current' && value !== 'fresh') {
        throw new Error(`${INTERNAL_COMMAND} received invalid --resume-mode.`);
      }
      resumeMode = value;
      index += 1;
    } else if (arg === '--thread-id' && value !== undefined) {
      threadId = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);
  if (!Number.isSafeInteger(targetRootPid) || Number(targetRootPid) <= 0) {
    throw new Error(`${INTERNAL_COMMAND} requires --target-root-pid.`);
  }

  return operationInputForOptionalValues({
    operationId,
    workspace: resolveWorkspaceRoot(workspace),
    targetRootPid: Number(targetRootPid),
    bypassSandbox,
    enableImageGeneration,
    delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
    handoffMode,
    resumeMode,
    threadId,
  });
}

export function spawnSessionHardRelaunchOperation(input: SessionHardRelaunchOperationInput, prompt: string | null): SessionHardRelaunchBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule hard relaunch because the current CLI entry path is unavailable.');
  }
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildSessionHardRelaunchOperationArgs(input)], {
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
    handoffMode: input.handoffMode ?? 'detached',
    delayMs,
  };
}

export function buildSessionHardRelaunchPayload(
  input: SessionHardRelaunchInput,
  deps: {
    store?: OperationStore;
    scheduler?: SessionHardRelaunchScheduler;
    processLister?: ProcessLister;
    currentPid?: number;
    codexCommandResolver?: () => string;
  } = {},
): Record<string, unknown> {
  const workspace = resolveWorkspaceRoot();
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnSessionHardRelaunchOperation;
  const processLister = deps.processLister ?? listProcesses;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexDetachedTerminalCommand;
  const prompt = input.prompt ?? null;
  const handoffMode = input.handoffMode ?? 'detached';
  const requestedResumeMode = input.resumeMode ?? 'current';
  const requestedThreadId = input.threadId ?? null;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const currentPid = deps.currentPid ?? process.pid;
  const requested = requestedEvidence({
    workspace,
    currentPid,
    prompt,
    handoffMode,
    resumeMode: requestedResumeMode,
    threadId: requestedThreadId,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
    delayMs,
  });
  const processes = processLister();
  const target = findCurrentCodexSessionTarget({ processes, workspace, currentPid });
  const dryRun = input.dryRun ?? true;
  const confirm = input.confirm === true;

  if (target === null) {
    return {
      ok: false,
      refused: true,
      dryRun,
      confirmRequired: !confirm,
      ...requested,
      message: 'Could not identify the current Codex TUI root from this MCP server process ancestry.',
    };
  }

  const targetEvidence = targetPreview(target, workspace);
  const resume = resolveResume({
    requestedMode: requestedResumeMode,
    explicitThreadId: requestedThreadId,
    target,
  });
  if (!resume.ok) {
    return {
      ok: false,
      refused: true,
      dryRun,
      confirmRequired: !confirm,
      ...requested,
      target: targetEvidence,
      resume: resume.evidence,
      message: resume.message,
    };
  }
  const resolvedResumeEvidence = {
    resumeMode: resume.resumeMode,
    threadId: resume.threadId ?? null,
    source: resume.source,
    resolved: true,
  };
  const handoff = handoffMode === 'shell-resume-next'
    ? shellResumeNextPreview({
        workspace,
        prompt,
        resumeMode: resume.resumeMode,
        threadId: resume.threadId,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
      })
    : launchPlanPreview(plainLaunchPlan({
        codexCommand: codexCommandResolver(),
        workspace,
        prompt,
        resumeMode: resume.resumeMode,
        threadId: resume.threadId,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
      }));
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      target: targetEvidence,
      resume: resolvedResumeEvidence,
      handoff,
      notes: [
        'Experimental hard relaunch targets the current process ancestry, not App Server thread state.',
        handoffMode === 'shell-resume-next'
          ? 'The real operation writes shell resume-next state, then attempts to stop this target root. It only relaunches in the same terminal when the opt-in shell hook is active.'
          : 'The real operation relaunches plain Codex first, resuming the selected thread unless resumeMode=fresh was explicitly requested, then attempts to stop this target root.',
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
      target: targetEvidence,
      resume: resolvedResumeEvidence,
      handoff,
      message: 'Pass confirm:true with dryRun:false to schedule hard relaunch.',
    };
  }

  const nextAction = nextActionForHandoffMode(handoffMode);
  const operation = store.create({
    kind: 'session_hard_relaunch',
    status: 'running',
    evidence: { requested, target: targetEvidence, resume: resolvedResumeEvidence, handoff },
    nextAction,
  });

  try {
    const background = scheduler(
      operationInputForOptionalValues({
        operationId: operation.id,
        workspace,
        targetRootPid: target.root.pid,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
        delayMs,
        handoffMode,
        resumeMode: resume.resumeMode,
        threadId: resume.threadId,
      }),
      prompt,
    );
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, target: targetEvidence, resume: resolvedResumeEvidence, handoff, background },
        nextAction,
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
      evidence: { requested, target: targetEvidence, resume: resolvedResumeEvidence, handoff, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read before retrying.',
    });
    throw error;
  }
}

export async function runSessionHardRelaunchOperation(
  input: SessionHardRelaunchOperationInput,
  deps: {
    store?: OperationStore;
    processLister?: ProcessLister;
    processStopper?: ProcessStopper;
    launchExecutor?: PlainCodexLaunchExecutor;
    codexCommandResolver?: () => string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OperationRecord | null> {
  const workspace = resolveWorkspaceRoot(input.workspace);
  const store = deps.store ?? new OperationStore({ workspace });
  const processLister = deps.processLister ?? listProcesses;
  const processStopper = deps.processStopper ?? stopProcessTree;
  const launchExecutor = deps.launchExecutor ?? launchPlainCodex;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexDetachedTerminalCommand;
  const prompt = promptFromEnv(deps.env);
  const delayMs = boundedInteger(input.delayMs, DEFAULT_DELAY_MS, 0, MAX_DELAY_MS);
  const existingEvidence = store.read(input.operationId)?.evidence;
  const evidence = existingEvidence && typeof existingEvidence === 'object' && !Array.isArray(existingEvidence)
    ? { ...(existingEvidence as Record<string, unknown>) }
    : {};

  try {
    if (delayMs > 0) await sleep(delayMs);
    const resumeMode = input.resumeMode ?? (input.threadId === undefined ? 'fresh' : 'current');
    const threadId = input.threadId;
    if ((input.handoffMode ?? 'detached') === 'shell-resume-next') {
      evidence.shellResumeNext = writeShellResumeNextState({
        workspace,
        operationId: input.operationId,
        prompt,
        resumeMode,
        threadId,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
      });

      const processes = processLister();
      const tree = collectProcessTree(processes, [input.targetRootPid]);
      evidence.stopTarget = {
        rootPid: input.targetRootPid,
        treeProcessCount: tree.length,
        tree: redactValue(summarizeProcesses(tree), { workspace }),
        stopAttemptedAfterOperationCompletion: true,
      };

      const completed = store.complete(input.operationId, {
        evidence,
        nextAction: 'managed-remote shell resume-next state was written. The child will now attempt to stop the old TUI root; the opt-in shell hook must relaunch through codex-agent-session-manager remote.',
      });
      processStopper(input.targetRootPid, tree);
      return completed;
    }

    const plan = plainLaunchPlan({
      codexCommand: codexCommandResolver(),
      workspace,
      prompt,
      resumeMode,
      threadId,
      bypassSandbox: input.bypassSandbox,
      enableImageGeneration: input.enableImageGeneration,
    });
    evidence.launch = launchPlanPreview(plan);
    const launched = await launchExecutor(plan);
    evidence.launched = redactValue(launched, { workspace });

    const processes = processLister();
    const tree = collectProcessTree(processes, [input.targetRootPid]);
    evidence.stopTarget = {
      rootPid: input.targetRootPid,
      treeProcessCount: tree.length,
      tree: redactValue(summarizeProcesses(tree), { workspace }),
      stopAttemptedAfterOperationCompletion: true,
    };
    const completed = launched.ok
      ? store.complete(input.operationId, {
          evidence,
          nextAction: 'Plain Codex relaunch was started. The child will now attempt to stop the old TUI root; the relaunched prompt is the proof surface.',
        })
      : store.fail(input.operationId, {
          failure: { name: 'HardRelaunchLaunchFailed', message: 'Plain Codex launcher returned a non-ok result.' },
          evidence,
          nextAction: 'Inspect launch stderr/stdout before retrying hard relaunch.',
        });

    if (launched.ok) {
      processStopper(input.targetRootPid, tree);
    }
    return completed;
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error, prompt),
      evidence,
      nextAction: 'Inspect failure details with codex_operation_read before retrying hard relaunch.',
    });
  }
}

export async function runSessionHardRelaunchOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runSessionHardRelaunchOperation(parseSessionHardRelaunchOperationArgs(argv));
}
