import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { resolveAppServerUrl } from '../app-server/config.js';
import { redactArgv, redactSensitiveText, redactValue } from '../security/redaction.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 4_000;
const LAUNCH_PROMPT_ENV = 'CODEX_AGENT_SESSION_MANAGER_LAUNCH_PROMPT';
const INTERNAL_COMMAND = 'run-session-launch-operation';
const LAUNCH_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then inspect launch evidence.';

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. If omitted, CODEX_APP_SERVER_URL or workspace launcher state is used.');

const launchModes = ['fresh', 'session', 'last', 'pick'] as const;
type LaunchMode = (typeof launchModes)[number];

export const sessionLaunchInputSchema = {
  appServerUrl: appServerUrlSchema,
  mode: z.enum(launchModes).optional().describe('Remote session mode. Defaults to session when threadId is supplied, otherwise fresh.'),
  threadId: z.string().min(1).optional().describe('Thread id to resume. Supplying it implies mode=session.'),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional().describe('Optional initial prompt. Do not include secrets. Omitted from previews and operation evidence.'),
  dryRun: z.boolean().optional().describe('Defaults true. When true, only returns the launch plan.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
  bypassSandbox: z.boolean().optional().describe('When true, passes --dangerously-bypass-approvals-and-sandbox for trusted local workspaces.'),
  enableImageGeneration: z.boolean().optional().describe('When true, does not pass --disable image_generation.'),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().describe('Operation request timeout placeholder for future launch verification.'),
};

const sessionLaunchInputObject = z.object(sessionLaunchInputSchema);
type SessionLaunchInput = z.infer<typeof sessionLaunchInputObject>;

export interface SessionLaunchOperationInput {
  operationId: string;
  appServerUrl: string;
  workspace: string;
  mode: LaunchMode;
  threadId?: string;
  bypassSandbox?: boolean;
  enableImageGeneration?: boolean;
  timeoutMs?: number;
}

export interface SessionLaunchBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
  argvIncludesPrompt: false;
  promptTransport: 'environment';
}

export interface LaunchPlan {
  codexCommand: string;
  args: string[];
  workspace: string;
  appServerUrl: string;
  mode: LaunchMode;
  promptIncluded: boolean;
}

export interface LaunchExecutionResult {
  ok: boolean;
  mode: 'windows-detached-terminal' | 'detached-process' | 'fake';
  pid?: number | null;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export type SessionLaunchScheduler = (input: SessionLaunchOperationInput, prompt: string | null) => SessionLaunchBackgroundEvidence;
export type LaunchExecutor = (plan: LaunchPlan) => LaunchExecutionResult | Promise<LaunchExecutionResult>;

function publicFailure(error: unknown, promptToRedact?: string | null): unknown {
  const prompt = promptToRedact ?? '';
  const scrub = (text: string): string => {
    const redacted = redactSensitiveText(text);
    return prompt.length > 0 ? redacted.split(prompt).join('<redacted:launch-prompt>') : redacted;
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

function nativeWindowsCodexCandidates(commandDir: string): string[] {
  const vendorRoot = join(commandDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  if (!existsSync(vendorRoot)) return [];
  const preferredPackage = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  let packageNames: string[] = [];
  try {
    packageNames = readdirSync(vendorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^codex-win32-/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => {
        if (left === preferredPackage) return -1;
        if (right === preferredPackage) return 1;
        return left.localeCompare(right);
      });
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const packageName of packageNames) {
    const packageVendor = join(vendorRoot, packageName, 'vendor');
    if (!existsSync(packageVendor)) continue;
    let triples;
    try {
      triples = readdirSync(packageVendor, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const triple of triples) {
      if (!triple.isDirectory()) continue;
      candidates.push(join(packageVendor, triple.name, 'bin', 'codex.exe'));
    }
  }
  return candidates;
}

export function resolveCodexCommand(): string {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
    const commands = result.status === 0
      ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      : [];
    const nativeFromShim = commands
      .flatMap((command) => nativeWindowsCodexCandidates(dirname(command)))
      .find((candidate) => existsSync(candidate));
    return commands.find((command) => /codex\.exe$/iu.test(command))
      ?? nativeFromShim
      ?? commands.find((command) => /\.cmd$/iu.test(command))
      ?? commands.find((command) => /\.exe$/iu.test(command))
      ?? commands[0]
      ?? 'codex';
  }

  const result = spawnSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'codex';
}

function resolveLaunchMode(input: { mode?: LaunchMode | undefined; threadId?: string | undefined }): LaunchMode {
  if (input.threadId !== undefined) return 'session';
  return input.mode ?? 'fresh';
}

function validateLaunchMode(input: { mode: LaunchMode; threadId?: string | undefined }): void {
  if (input.mode === 'session' && input.threadId === undefined) {
    throw new Error('codex_session_launch mode=session requires threadId.');
  }
}

export function buildCodexArgs(input: {
  appServerUrl: string;
  workspace: string;
  mode: LaunchMode;
  threadId?: string | undefined;
  prompt?: string | null | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
}): string[] {
  validateLaunchMode(input);
  const args: string[] = [];
  if (input.mode === 'session') {
    args.push('resume', input.threadId ?? '');
  } else if (input.mode === 'last') {
    args.push('resume', '--last');
  } else if (input.mode === 'pick') {
    args.push('resume');
  }

  args.push('--disable', 'js_repl');
  if (input.enableImageGeneration !== true) {
    args.push('--disable', 'image_generation');
  }
  args.push('--remote', input.appServerUrl);
  if (input.bypassSandbox === true) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push('-C', input.workspace);
  if (input.prompt && input.prompt.length > 0) {
    args.push(input.prompt);
  }
  return args;
}

function requestedEvidence(input: {
  appServerUrl: string;
  workspace: string;
  mode: LaunchMode;
  threadId?: string | undefined;
  prompt: string | null;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  timeoutMs?: number | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: redactSensitiveText(input.appServerUrl),
    workspacePreview: '<workspace>',
    mode: input.mode,
    threadId: input.threadId ?? null,
    promptProvided: Boolean(input.prompt && input.prompt.length > 0),
    promptCharCount: input.prompt?.length ?? 0,
    promptTransport: 'environment',
    bypassSandbox: input.bypassSandbox === true,
    enableImageGeneration: input.enableImageGeneration === true,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startsAppServer: false,
  };
}

export function launchPlanPreview(plan: LaunchPlan): Record<string, unknown> {
  const args = plan.args.map((arg) => (plan.promptIncluded && arg === plan.args.at(-1) ? '<prompt>' : arg));
  return {
    command: redactSensitiveText(plan.codexCommand),
    args: redactArgv(args, { workspace: plan.workspace }),
    cwd: '<workspace>',
    mode: plan.mode,
    promptIncluded: plan.promptIncluded,
    startsAppServer: false,
  };
}

function promptFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const prompt = env[LAUNCH_PROMPT_ENV];
  if (prompt === undefined) return null;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Launch prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  return prompt;
}

function childEnvWithPrompt(prompt: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[LAUNCH_PROMPT_ENV];
  if (prompt !== null) env[LAUNCH_PROMPT_ENV] = prompt;
  return env;
}

function operationInputForOptionalValues(input: {
  operationId: string;
  appServerUrl: string;
  workspace: string;
  mode: LaunchMode;
  threadId?: string | undefined;
  bypassSandbox?: boolean | undefined;
  enableImageGeneration?: boolean | undefined;
  timeoutMs?: number | undefined;
}): SessionLaunchOperationInput {
  const operationInput: SessionLaunchOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.appServerUrl,
    workspace: input.workspace,
    mode: input.mode,
  };
  if (input.threadId !== undefined) operationInput.threadId = input.threadId;
  if (input.bypassSandbox !== undefined) operationInput.bypassSandbox = input.bypassSandbox;
  if (input.enableImageGeneration !== undefined) operationInput.enableImageGeneration = input.enableImageGeneration;
  if (input.timeoutMs !== undefined) operationInput.timeoutMs = input.timeoutMs;
  return operationInput;
}

export function buildSessionLaunchOperationArgs(input: SessionLaunchOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--app-server-url',
    input.appServerUrl,
    '--workspace',
    input.workspace,
    '--mode',
    input.mode,
  ];
  if (input.threadId !== undefined) args.push('--thread-id', input.threadId);
  if (input.bypassSandbox === true) args.push('--bypass-sandbox');
  if (input.enableImageGeneration === true) args.push('--enable-image-generation');
  if (input.timeoutMs !== undefined) args.push('--timeout-ms', String(input.timeoutMs));
  return args;
}

export function parseSessionLaunchOperationArgs(argv: readonly string[]): SessionLaunchOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let workspace: string | undefined;
  let mode: LaunchMode | undefined;
  let threadId: string | undefined;
  let bypassSandbox: boolean | undefined;
  let enableImageGeneration: boolean | undefined;
  let timeoutMs: number | undefined;

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
    } else if (arg === '--mode' && value !== undefined && launchModes.includes(value as LaunchMode)) {
      mode = value as LaunchMode;
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
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!appServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --app-server-url.`);
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);
  if (mode === undefined) throw new Error(`${INTERNAL_COMMAND} requires --mode.`);

  return operationInputForOptionalValues({
    operationId,
    appServerUrl: resolveAppServerUrl(appServerUrl),
    workspace: resolve(workspace),
    mode,
    threadId,
    bypassSandbox,
    enableImageGeneration,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });
}

export function spawnSessionLaunchOperation(input: SessionLaunchOperationInput, prompt: string | null): SessionLaunchBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule session launch because the current CLI entry path is unavailable.');
  }
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildSessionLaunchOperationArgs(input)], {
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
  };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function psArrayLiteral(values: readonly string[]): string {
  return `@(${values.map(psQuote).join(',')})`;
}

export function launchCodexRemote(plan: LaunchPlan): LaunchExecutionResult {
  const env = { ...process.env, CODEX_APP_SERVER_URL: plan.appServerUrl };
  if (process.platform === 'win32') {
    const command = [
      `Start-Process -FilePath ${psQuote(plan.codexCommand)}`,
      `-WorkingDirectory ${psQuote(plan.workspace)}`,
      '-WindowStyle Normal',
      `-ArgumentList ${psArrayLiteral(plan.args)}`,
    ].join(' ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd: plan.workspace,
        encoding: 'utf8',
        windowsHide: true,
        env,
      },
    );
    return {
      ok: result.status === 0,
      mode: 'windows-detached-terminal',
      exitCode: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  const child = spawn(plan.codexCommand, plan.args, {
    cwd: plan.workspace,
    env,
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

export function buildSessionLaunchPayload(
  input: SessionLaunchInput,
  deps: {
    store?: OperationStore;
    scheduler?: SessionLaunchScheduler;
    codexCommandResolver?: () => string;
  } = {},
): Record<string, unknown> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnSessionLaunchOperation;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexCommand;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolve(process.cwd());
  const mode = resolveLaunchMode(input);
  validateLaunchMode({ mode, threadId: input.threadId });
  const prompt = input.prompt ?? null;
  const codexCommand = codexCommandResolver();
  const args = buildCodexArgs({
    appServerUrl,
    workspace,
    mode,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
  });
  const plan: LaunchPlan = {
    codexCommand,
    args,
    workspace,
    appServerUrl,
    mode,
    promptIncluded: prompt !== null && prompt.length > 0,
  };
  const requested = requestedEvidence({
    appServerUrl,
    workspace,
    mode,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
    timeoutMs: input.timeoutMs,
  });
  const dryRun = input.dryRun ?? true;
  const confirm = input.confirm === true;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      ...requested,
      launch: launchPlanPreview(plan),
    };
  }

  if (!confirm) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      launch: launchPlanPreview(plan),
      message: 'Pass confirm:true with dryRun:false to schedule remote TUI launch.',
    };
  }

  const operation = store.create({
    kind: 'session_launch',
    status: 'running',
    evidence: { requested, launch: launchPlanPreview(plan) },
    nextAction: LAUNCH_NEXT_ACTION,
  });

  try {
    const background = scheduler(
      operationInputForOptionalValues({
        operationId: operation.id,
        appServerUrl,
        workspace,
        mode,
        threadId: input.threadId,
        bypassSandbox: input.bypassSandbox,
        enableImageGeneration: input.enableImageGeneration,
        timeoutMs: input.timeoutMs,
      }),
      prompt,
    );
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, launch: launchPlanPreview(plan), background },
        nextAction: LAUNCH_NEXT_ACTION,
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
      evidence: { requested, launch: launchPlanPreview(plan), background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

export async function runSessionLaunchOperation(
  input: SessionLaunchOperationInput,
  deps: {
    store?: OperationStore;
    codexCommandResolver?: () => string;
    launchExecutor?: LaunchExecutor;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OperationRecord | null> {
  const store = deps.store ?? operationStore;
  const codexCommandResolver = deps.codexCommandResolver ?? resolveCodexCommand;
  const launchExecutor = deps.launchExecutor ?? launchCodexRemote;
  const appServerUrl = resolveAppServerUrl(input.appServerUrl);
  const workspace = resolve(input.workspace);
  const prompt = promptFromEnv(deps.env);
  const codexCommand = codexCommandResolver();
  const args = buildCodexArgs({
    appServerUrl,
    workspace,
    mode: input.mode,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
  });
  const plan: LaunchPlan = {
    codexCommand,
    args,
    workspace,
    appServerUrl,
    mode: input.mode,
    promptIncluded: prompt !== null && prompt.length > 0,
  };
  const requested = requestedEvidence({
    appServerUrl,
    workspace,
    mode: input.mode,
    threadId: input.threadId,
    prompt,
    bypassSandbox: input.bypassSandbox,
    enableImageGeneration: input.enableImageGeneration,
    timeoutMs: input.timeoutMs,
  });
  const existingEvidence = recordFrom(store.read(input.operationId)?.evidence);
  const evidence: Record<string, unknown> = { ...existingEvidence, requested, launch: launchPlanPreview(plan) };

  try {
    const launched = await launchExecutor(plan);
    evidence.launched = redactValue(launched, { workspace });
    if (launched.ok) {
      return store.complete(input.operationId, {
        evidence,
        nextAction: 'Remote TUI launch was scheduled. Use codex_thread_context or App Server status to inspect the resulting session.',
      });
    }
    return store.fail(input.operationId, {
      failure: { name: 'SessionLaunchFailed', message: 'Remote TUI launcher returned a non-ok result.' },
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

export async function runSessionLaunchOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runSessionLaunchOperation(parseSessionLaunchOperationArgs(argv));
}
