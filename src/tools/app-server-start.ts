import { spawn } from 'node:child_process';
import { z } from 'zod';

import {
  buildRemotePlan,
  executeRemotePlan,
  remotePlanPreview,
  type RemoteDeps,
  type RemoteOptions,
  type RemotePlan,
} from '../remote.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';
import { OperationStore, operationStore, type OperationRecord } from './operations.js';

const INTERNAL_COMMAND = 'run-app-server-start-operation';
const START_NEXT_ACTION = 'Use codex_operation_wait with this operationId, then codex_operation_read for App Server lifecycle evidence.';

export const appServerStartInputSchema = {
  appServerUrl: z.string().optional().describe('Optional loopback App Server websocket URL. If omitted, primary workspace state is reused, then an automatic local port is selected.'),
  host: z.string().optional().describe('Loopback host used when selecting a port. Defaults to 127.0.0.1.'),
  port: z.string().optional().describe('Port number or auto. If omitted, primary workspace state is reused, then an automatic port is selected.'),
  appServerArgs: z.array(z.string()).optional().describe('Native codex app-server arguments appended after managed --listen/defaults. Do not include --listen or --stdio; use appServerUrl/host/port instead.'),
  enableImageGeneration: z.boolean().optional().describe('When true, does not pass --disable image_generation to App Server.'),
  dryRun: z.boolean().optional().describe('Defaults true. When true, only returns the start/reuse plan.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

const appServerStartInputObject = z.object(appServerStartInputSchema);
type AppServerStartInput = z.infer<typeof appServerStartInputObject>;

export interface AppServerStartOperationInput {
  operationId: string;
  appServerUrl: string;
  workspace: string;
  enableImageGeneration?: boolean;
  appServerArgs?: string[];
}

export interface AppServerStartBackgroundEvidence {
  scheduled: true;
  pid: number | null;
  detached: true;
  windowsHide: true;
  internalCommand: typeof INTERNAL_COMMAND;
}

export type AppServerStartScheduler = (input: AppServerStartOperationInput) => AppServerStartBackgroundEvidence;
type RemotePlanBuilder = (options: RemoteOptions, deps?: RemoteDeps) => Promise<RemotePlan>;
type RemoteExecutor = (plan: RemotePlan, deps?: RemoteDeps) => Promise<number>;

function publicFailure(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveText(error.message),
    };
  }
  return redactValue(String(error));
}

function requestedEvidence(input: {
  appServerUrl?: string | undefined;
  host?: string | undefined;
  port?: string | undefined;
  workspace: string;
  enableImageGeneration?: boolean | undefined;
  appServerArgs?: readonly string[] | undefined;
}): Record<string, unknown> {
  return {
    appServerUrl: input.appServerUrl ? redactSensitiveText(input.appServerUrl) : null,
    host: input.host ?? null,
    port: input.port ?? null,
    workspacePreview: '<workspace>',
    enableImageGeneration: input.enableImageGeneration === true,
    appServerArgs: input.appServerArgs ?? [],
    startsOrReusesAppServer: true,
  };
}

function operationInputForPlan(input: {
  operationId: string;
  plan: RemotePlan;
  enableImageGeneration?: boolean | undefined;
  appServerArgs?: readonly string[] | undefined;
}): AppServerStartOperationInput {
  const operationInput: AppServerStartOperationInput = {
    operationId: input.operationId,
    appServerUrl: input.plan.appServerUrl,
    workspace: input.plan.workspace,
  };
  if (input.enableImageGeneration !== undefined) operationInput.enableImageGeneration = input.enableImageGeneration;
  if (input.appServerArgs !== undefined) operationInput.appServerArgs = [...input.appServerArgs];
  return operationInput;
}

export function buildAppServerStartOperationArgs(input: AppServerStartOperationInput): string[] {
  const args = [
    INTERNAL_COMMAND,
    '--operation-id',
    input.operationId,
    '--app-server-url',
    input.appServerUrl,
    '--workspace',
    input.workspace,
  ];
  if (input.enableImageGeneration === true) args.push('--enable-image-generation');
  for (const arg of input.appServerArgs ?? []) {
    args.push('--app-server-arg', arg);
  }
  return args;
}

export function parseAppServerStartOperationArgs(argv: readonly string[]): AppServerStartOperationInput {
  let operationId: string | undefined;
  let appServerUrl: string | undefined;
  let workspace: string | undefined;
  let enableImageGeneration: boolean | undefined;
  const appServerArgs: string[] = [];

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
    } else if (arg === '--enable-image-generation') {
      enableImageGeneration = true;
    } else if (arg === '--app-server-arg' && value !== undefined) {
      appServerArgs.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete ${INTERNAL_COMMAND} argument: ${arg ?? '<missing>'}`);
    }
  }

  if (!operationId) throw new Error(`${INTERNAL_COMMAND} requires --operation-id.`);
  if (!appServerUrl) throw new Error(`${INTERNAL_COMMAND} requires --app-server-url.`);
  if (!workspace) throw new Error(`${INTERNAL_COMMAND} requires --workspace.`);

  const operationInput: AppServerStartOperationInput = {
    operationId,
    appServerUrl,
    workspace: resolveWorkspaceRoot(workspace),
  };
  if (enableImageGeneration !== undefined) operationInput.enableImageGeneration = enableImageGeneration;
  if (appServerArgs.length > 0) operationInput.appServerArgs = appServerArgs;
  return operationInput;
}

export function spawnAppServerStartOperation(input: AppServerStartOperationInput): AppServerStartBackgroundEvidence {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Cannot schedule App Server start because the current CLI entry path is unavailable.');
  }
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...buildAppServerStartOperationArgs(input)], {
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
  };
}

export async function buildAppServerStartPayload(
  input: AppServerStartInput,
  deps: {
    store?: OperationStore;
    scheduler?: AppServerStartScheduler;
    planBuilder?: RemotePlanBuilder;
    remoteDeps?: RemoteDeps;
  } = {},
): Promise<Record<string, unknown>> {
  const store = deps.store ?? operationStore;
  const scheduler = deps.scheduler ?? spawnAppServerStartOperation;
  const planBuilder = deps.planBuilder ?? buildRemotePlan;
  const workspace = resolveWorkspaceRoot();
  const dryRun = input.dryRun ?? true;
  const requested = requestedEvidence({
    appServerUrl: input.appServerUrl,
    host: input.host,
    port: input.port,
    workspace,
    enableImageGeneration: input.enableImageGeneration,
    appServerArgs: input.appServerArgs,
  });
  const remoteOptions: RemoteOptions = {
    workspace,
    noResume: true,
    dryRun,
  };
  if (input.appServerUrl !== undefined) remoteOptions.url = input.appServerUrl;
  if (input.host !== undefined) remoteOptions.host = input.host;
  if (input.port !== undefined) remoteOptions.port = input.port;
  if (input.enableImageGeneration !== undefined) remoteOptions.enableImageGeneration = input.enableImageGeneration;
  if (input.appServerArgs !== undefined) remoteOptions.appServerArgs = input.appServerArgs;
  const plan = await planBuilder(remoteOptions, deps.remoteDeps);
  const planPreview = remotePlanPreview(plan);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: input.confirm !== true,
      ...requested,
      plan: planPreview,
    };
  }

  if (input.confirm !== true) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      ...requested,
      plan: planPreview,
      message: 'Pass confirm:true with dryRun:false to schedule App Server start/reuse.',
    };
  }

  const operation = store.create({
    kind: 'app_server_start',
    status: 'running',
    evidence: { requested, plan: planPreview },
    nextAction: START_NEXT_ACTION,
  });

  try {
    const background = scheduler(operationInputForPlan({
      operationId: operation.id,
      plan,
      enableImageGeneration: input.enableImageGeneration,
      appServerArgs: input.appServerArgs,
    }));
    const updatedOperation =
      store.update(operation.id, {
        evidence: { requested, plan: planPreview, background },
        nextAction: START_NEXT_ACTION,
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
      evidence: { requested, plan: planPreview, background: { scheduled: false } },
      nextAction: 'Inspect failure with codex_operation_read.',
    });
    throw error;
  }
}

export async function runAppServerStartOperation(
  input: AppServerStartOperationInput,
  deps: {
    store?: OperationStore;
    planBuilder?: RemotePlanBuilder;
    executor?: RemoteExecutor;
    remoteDeps?: RemoteDeps;
  } = {},
): Promise<OperationRecord | null> {
  const workspace = resolveWorkspaceRoot(input.workspace);
  const store = deps.store ?? new OperationStore({ workspace });
  const planBuilder = deps.planBuilder ?? buildRemotePlan;
  const executor = deps.executor ?? executeRemotePlan;
  const outputs: string[] = [];

  try {
    const plan = await planBuilder(
      (() => {
        const remoteOptions: RemoteOptions = {
          workspace,
          url: input.appServerUrl,
          noResume: true,
        };
        if (input.enableImageGeneration !== undefined) remoteOptions.enableImageGeneration = input.enableImageGeneration;
        if (input.appServerArgs !== undefined) remoteOptions.appServerArgs = input.appServerArgs;
        return remoteOptions;
      })(),
      deps.remoteDeps,
    );
    const existingEvidence = store.read(input.operationId)?.evidence;
    const evidence = {
      ...(existingEvidence && typeof existingEvidence === 'object' && !Array.isArray(existingEvidence)
        ? existingEvidence as Record<string, unknown>
        : {}),
      plan: remotePlanPreview(plan),
    };
    const exitCode = await executor(plan, {
      ...deps.remoteDeps,
      output: (text) => outputs.push(text),
    });
    const completedEvidence = {
      ...evidence,
      exitCode,
      output: outputs.map((line) => redactSensitiveText(line)),
    };
    if (exitCode === 0) {
      return store.complete(input.operationId, {
        evidence: completedEvidence,
        nextAction: 'App Server is ready or reused. Use codex_app_server_state_read, codex_mcp_status_list, or codex_session_launch next.',
      });
    }
    return store.fail(input.operationId, {
      failure: { name: 'AppServerStartFailed', message: `Remote launcher returned exit code ${exitCode}.` },
      evidence: completedEvidence,
      nextAction: 'Inspect launch output before retrying.',
    });
  } catch (error) {
    return store.fail(input.operationId, {
      failure: publicFailure(error),
      evidence: { output: outputs.map((line) => redactSensitiveText(line)) },
      nextAction: 'Inspect failure details with codex_operation_read before retrying.',
    });
  }
}

export async function runAppServerStartOperationFromArgv(argv: readonly string[]): Promise<void> {
  await runAppServerStartOperation(parseAppServerStartOperationArgs(argv));
}
