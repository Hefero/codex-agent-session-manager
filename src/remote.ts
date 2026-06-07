import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectAppServerClient } from './app-server/client.js';
import { appServerStateFileForWorkspace, readAppServerStateFile, writeAppServerState } from './app-server/state.js';
import { redactArgv, redactSensitiveText, redactValue } from './security/redaction.js';
import { isLoopbackHost, validateAppServerUrl } from './security/url.js';
import { buildCodexArgs, resolveCodexCommand } from './tools/session-launch.js';

const DEFAULT_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 250;
const WORKSPACE_STATE_DIR = '.codex-agent-session-manager';
const WINDOWS_HIDDEN_LAUNCHER_SOURCE = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'scripts', 'windows-hidden-stdio-launcher.cs');
const WINDOWS_HIDDEN_LAUNCHER_EXE = 'windows-hidden-stdio-launcher.exe';
const WINDOWS_HIDDEN_LAUNCHER_STAMP = 'windows-hidden-stdio-launcher.exe.sha256';

type RemoteMode = 'fresh' | 'session' | 'last' | 'pick';

export interface RemoteOptions {
  url?: string;
  host?: string;
  port?: string;
  workspace?: string;
  sessionId?: string;
  resumeLast?: boolean;
  pick?: boolean;
  noResume?: boolean;
  dryRun?: boolean;
  enableImageGeneration?: boolean;
  noBypassSandbox?: boolean;
  help?: boolean;
}

export interface RemotePlan {
  workspace: string;
  appServerUrl: string;
  source: string;
  codexCommand: string;
  mode: RemoteMode;
  startsAppServer: boolean;
  noResume: boolean;
  server: {
    command: string;
    args: string[];
    stdoutLog: string;
    stderrLog: string;
  };
  tui: {
    command: string;
    args: string[];
  };
  stateFile: string;
}

export interface RemoteDeps {
  codexCommandResolver?: () => string;
  freePort?: (host: string) => Promise<number>;
  readyProbe?: (url: string) => Promise<boolean>;
  codexProbe?: (url: string) => Promise<boolean>;
  appServerSpawner?: (plan: RemotePlan) => { pid: number | null };
  tuiSpawner?: (plan: RemotePlan) => Promise<number>;
  output?: (text: string) => void;
}

export function remoteUsage(): string {
  return `Usage:
  codex-agent-session-manager remote [options]

Options:
  --url <ws-url>              Existing loopback App Server websocket URL.
  --host <host>               Host used with --port. Default ${DEFAULT_HOST}.
  --port <port|auto>          App Server port when --url is absent. Default: primary state, then auto.
  --workspace <path>          Workspace for Codex. Defaults to current directory.
  --session-id <thread-id>    Resume a specific thread id.
  --resume-last               Resume the most recent thread.
  --pick                      Open Codex's resume picker.
  --no-resume                 Start/reuse App Server and exit before launching Codex TUI.
  --dry-run                   Print resolved commands without starting processes.
  --enable-image-generation   Do not pass --disable image_generation.
  --no-bypass-sandbox         Do not pass --dangerously-bypass-approvals-and-sandbox.
  --help                      Show this help.
`;
}

export function parseRemoteArgs(argv: readonly string[]): RemoteOptions {
  const options: RemoteOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index] ?? '';
    const [name, inlineValue] = rawArg.startsWith('--') && rawArg.includes('=')
      ? rawArg.split(/=(.*)/su, 2)
      : [rawArg, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) throw new Error(`Empty value for ${name}.`);
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(`Missing value for ${name}.`);
      index += 1;
      return next;
    };

    switch (name) {
      case '--url':
        options.url = readValue();
        break;
      case '--host':
        options.host = readValue();
        break;
      case '--port':
        options.port = readValue();
        break;
      case '--workspace':
        options.workspace = readValue();
        break;
      case '--session-id':
        options.sessionId = readValue();
        break;
      case '--resume-last':
        options.resumeLast = true;
        break;
      case '--pick':
        options.pick = true;
        break;
      case '--no-resume':
        options.noResume = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--enable-image-generation':
        options.enableImageGeneration = true;
        break;
      case '--no-bypass-sandbox':
        options.noBypassSandbox = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown remote argument: ${rawArg}`);
    }
  }

  const selectedModes = [options.sessionId !== undefined, options.resumeLast === true, options.pick === true].filter(Boolean).length;
  if (selectedModes > 1) {
    throw new Error('Choose only one of --session-id, --resume-last, or --pick.');
  }
  return options;
}

function remoteMode(options: RemoteOptions): RemoteMode {
  if (options.sessionId !== undefined) return 'session';
  if (options.resumeLast === true) return 'last';
  if (options.pick === true) return 'pick';
  return 'fresh';
}

function parsePort(value: string, source: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`Invalid App Server port from ${source}: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid App Server port from ${source}: ${value}`);
  }
  return port;
}

function formatHostForUrl(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!isLoopbackHost(normalized)) {
    throw new Error('App Server host must be loopback-only. Use localhost, 127.0.0.1, or ::1.');
  }
  return normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
}

function httpReadyUrl(wsUrl: string): string {
  const parsed = new URL(validateAppServerUrl(wsUrl).href);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/readyz';
  return parsed.toString();
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else reject(new Error('Unable to allocate a free local port.'));
      });
    });
  });
}

async function defaultReadyProbe(wsUrl: string): Promise<boolean> {
  try {
    const response = await fetch(httpReadyUrl(wsUrl), { signal: AbortSignal.timeout(1_000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function defaultCodexProbe(wsUrl: string): Promise<boolean> {
  try {
    const client = await connectAppServerClient({ url: wsUrl, requestTimeoutMs: 3_000 });
    try {
      await client.initialize();
      await client.listLoadedThreads();
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

async function resolveTargetUrl(
  options: RemoteOptions,
  workspace: string,
  deps: Required<Pick<RemoteDeps, 'freePort'>>,
): Promise<{ url: string; source: string; startsAppServer: boolean }> {
  if (options.url !== undefined) {
    return { url: validateAppServerUrl(options.url, 'App Server URL from --url').href, source: 'argument-url', startsAppServer: false };
  }

  const host = formatHostForUrl(options.host ?? DEFAULT_HOST);
  if (options.port !== undefined) {
    const port = options.port === 'auto' ? await deps.freePort(host.replace(/^\[|\]$/gu, '')) : parsePort(options.port, '--port');
    return { url: `ws://${host}:${port}`, source: options.port === 'auto' ? 'port-auto-argument' : 'port-argument', startsAppServer: true };
  }

  const stateRead = readAppServerStateFile(appServerStateFileForWorkspace(workspace, 'primary'), 'primary');
  const stateUrl = stateRead.state?.url;
  if (typeof stateUrl === 'string' && stateUrl.length > 0) {
    return { url: validateAppServerUrl(stateUrl, 'App Server URL from primary launcher state').href, source: 'primary-state', startsAppServer: false };
  }

  const port = await deps.freePort(host.replace(/^\[|\]$/gu, ''));
  return { url: `ws://${host}:${port}`, source: 'port-auto', startsAppServer: true };
}

function logPaths(workspace: string, appServerUrl: string): { stdoutLog: string; stderrLog: string } {
  const url = new URL(appServerUrl);
  const suffix = `${url.hostname.replace(/[^a-zA-Z0-9_.-]+/gu, '-')}-${url.port}`;
  const logDir = join(workspace, WORKSPACE_STATE_DIR, 'logs');
  return {
    stdoutLog: join(logDir, `codex-app-server-${suffix}.out.log`),
    stderrLog: join(logDir, `codex-app-server-${suffix}.err.log`),
  };
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function findWindowsCsc(): string | null {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const result = spawnSync('where.exe', ['csc'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && existsSync(line))
    ?? null;
}

function compileWindowsHiddenLauncher(outputPath: string, sourceHash: string, stampPath: string): boolean {
  const compiler = findWindowsCsc();
  if (compiler === null) return existsSync(outputPath);

  mkdirSync(dirname(outputPath), { recursive: true });
  const tempOutputPath = join(dirname(outputPath), `.windows-hidden-stdio-launcher-${process.pid}-${Date.now()}.tmp.exe`);
  const result = spawnSync(
    compiler,
    ['/nologo', '/target:winexe', `/out:${tempOutputPath}`, WINDOWS_HIDDEN_LAUNCHER_SOURCE],
    { encoding: 'utf8', windowsHide: true },
  );

  if (result.status !== 0) {
    rmSync(tempOutputPath, { force: true });
    throw new Error(
      `Failed to build Windows hidden App Server launcher with ${compiler}.\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }

  try {
    copyFileSync(tempOutputPath, outputPath);
    writeFileSync(stampPath, `${sourceHash}\n`, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (!existsSync(outputPath) || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error;
  } finally {
    rmSync(tempOutputPath, { force: true });
  }
  return existsSync(outputPath);
}

export function prepareWindowsHiddenLauncherForWorkspace(workspace: string, dryRun: boolean): string | null {
  if (process.platform !== 'win32') return null;
  if (!existsSync(WINDOWS_HIDDEN_LAUNCHER_SOURCE)) return null;

  const target = join(workspace, WORKSPACE_STATE_DIR, WINDOWS_HIDDEN_LAUNCHER_EXE);
  const stampPath = join(workspace, WORKSPACE_STATE_DIR, WINDOWS_HIDDEN_LAUNCHER_STAMP);
  if (dryRun) return target;

  const sourceContent = readText(WINDOWS_HIDDEN_LAUNCHER_SOURCE);
  if (sourceContent.length === 0) return null;
  const sourceHash = sha256(sourceContent);
  const shouldCompile = !existsSync(target) || readText(stampPath).trim() !== sourceHash;
  if (!shouldCompile) return target;

  return compileWindowsHiddenLauncher(target, sourceHash, stampPath) ? target : null;
}

function canLaunchThroughWindowsHiddenLauncher(command: string): boolean {
  return process.platform === 'win32' && /\.exe$/iu.test(command) && existsSync(command);
}

export async function buildRemotePlan(options: RemoteOptions, deps: RemoteDeps = {}): Promise<RemotePlan> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const codexCommand = (deps.codexCommandResolver ?? resolveCodexCommand)();
  const freePort = deps.freePort ?? findFreePort;
  const target = await resolveTargetUrl(options, workspace, { freePort });
  const mode = remoteMode(options);
  const logs = logPaths(workspace, target.url);
  const serverArgs = ['app-server', '--listen', target.url, '--disable', 'js_repl'];
  if (options.enableImageGeneration !== true) {
    serverArgs.push('--disable', 'image_generation');
  }
  const hiddenLauncher = canLaunchThroughWindowsHiddenLauncher(codexCommand)
    ? prepareWindowsHiddenLauncherForWorkspace(workspace, options.dryRun === true)
    : null;
  const serverCommand = hiddenLauncher ?? codexCommand;
  const serverArgsWithLauncher = hiddenLauncher ? [codexCommand, ...serverArgs] : serverArgs;
  const tuiArgs = buildCodexArgs({
    appServerUrl: target.url,
    workspace,
    mode,
    threadId: options.sessionId,
    bypassSandbox: options.noBypassSandbox !== true,
    enableImageGeneration: options.enableImageGeneration,
  });

  return {
    workspace,
    appServerUrl: target.url,
    source: target.source,
    codexCommand,
    mode,
    startsAppServer: target.startsAppServer,
    noResume: options.noResume === true,
    server: {
      command: serverCommand,
      args: serverArgsWithLauncher,
      ...logs,
    },
    tui: {
      command: codexCommand,
      args: tuiArgs,
    },
    stateFile: appServerStateFileForWorkspace(workspace, 'primary'),
  };
}

export function remotePlanPreview(plan: RemotePlan): Record<string, unknown> {
  return redactValue(
    {
      workspace: '<workspace>',
      appServerUrl: plan.appServerUrl,
      source: plan.source,
      startsAppServer: plan.startsAppServer,
      noResume: plan.noResume,
      mode: plan.mode,
      stateFile: '<workspace>/.codex-agent-session-manager/state/app-server.json',
      server: {
        command: redactSensitiveText(plan.server.command),
        args: redactArgv(plan.server.args, { workspace: plan.workspace }),
        stdoutLog: '<workspace>/.codex-agent-session-manager/logs/app-server.out.log',
        stderrLog: '<workspace>/.codex-agent-session-manager/logs/app-server.err.log',
      },
      tui: {
        command: redactSensitiveText(plan.tui.command),
        args: redactArgv(plan.tui.args, { workspace: plan.workspace }),
      },
    },
    { workspace: plan.workspace },
  ) as Record<string, unknown>;
}

function defaultAppServerSpawner(plan: RemotePlan): { pid: number | null } {
  mkdirSync(dirname(plan.server.stdoutLog), { recursive: true });
  const outFd = openSync(plan.server.stdoutLog, 'a');
  const errFd = openSync(plan.server.stderrLog, 'a');
  try {
    const child = spawn(plan.server.command, plan.server.args, {
      cwd: plan.workspace,
      detached: true,
      env: { ...process.env, CODEX_APP_SERVER_URL: plan.appServerUrl },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      shell: false,
    });
    child.unref();
    return { pid: typeof child.pid === 'number' ? child.pid : null };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

function defaultTuiSpawner(plan: RemotePlan): Promise<number> {
  const child = spawn(plan.tui.command, plan.tui.args, {
    cwd: plan.workspace,
    env: { ...process.env, CODEX_APP_SERVER_URL: plan.appServerUrl },
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  });
  return new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      resolveExit(typeof code === 'number' ? code : signal ? 1 : 0);
    });
  });
}

async function waitForReady(url: string, readyProbe: (url: string) => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await readyProbe(url)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, READY_POLL_MS));
  }
  return false;
}

export async function executeRemotePlan(plan: RemotePlan, deps: RemoteDeps = {}): Promise<number> {
  const readyProbe = deps.readyProbe ?? defaultReadyProbe;
  const codexProbe = deps.codexProbe ?? defaultCodexProbe;
  const appServerSpawner = deps.appServerSpawner ?? defaultAppServerSpawner;
  const tuiSpawner = deps.tuiSpawner ?? defaultTuiSpawner;
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));

  let reusedServer = false;
  let pid: number | null = null;
  if (await readyProbe(plan.appServerUrl)) {
    if (!await codexProbe(plan.appServerUrl)) {
      throw new Error(`Refusing to reuse ${redactSensitiveText(plan.appServerUrl)} because it did not identify as Codex App Server.`);
    }
    reusedServer = true;
    output(`Reusing Codex App Server at ${plan.appServerUrl}`);
  } else {
    output(`Starting Codex App Server at ${plan.appServerUrl}`);
    pid = appServerSpawner(plan).pid;
    writeAppServerState(
      {
        url: plan.appServerUrl,
        pid,
        owned: true,
        source: plan.source,
        reusedServer: false,
        status: 'starting',
        workspace: plan.workspace,
        updatedAt: new Date().toISOString(),
        log: { stdout: plan.server.stdoutLog, stderr: plan.server.stderrLog },
      },
      plan.workspace,
    );
    if (!await waitForReady(plan.appServerUrl, readyProbe)) {
      writeAppServerState(
        {
          url: plan.appServerUrl,
          pid,
          owned: true,
          source: plan.source,
          reusedServer: false,
          status: 'failed',
          workspace: plan.workspace,
          updatedAt: new Date().toISOString(),
          log: { stdout: plan.server.stdoutLog, stderr: plan.server.stderrLog },
        },
        plan.workspace,
      );
      throw new Error(`Codex App Server did not become ready at ${redactSensitiveText(plan.appServerUrl)}.`);
    }
  }

  writeAppServerState(
    {
      url: plan.appServerUrl,
      pid,
      owned: !reusedServer,
      source: plan.source,
      reusedServer,
      status: 'ready',
      workspace: plan.workspace,
      updatedAt: new Date().toISOString(),
      log: { stdout: plan.server.stdoutLog, stderr: plan.server.stderrLog },
    },
    plan.workspace,
  );

  if (plan.noResume) {
    output(`NoResume set; leaving App Server available at ${plan.appServerUrl}`);
    return 0;
  }

  output('Starting Codex TUI with managed App Server.');
  if (plan.tui.args.includes('--dangerously-bypass-approvals-and-sandbox')) {
    output('Security: launching Codex with --dangerously-bypass-approvals-and-sandbox for trusted local development.');
  }
  return tuiSpawner(plan);
}

export async function runRemoteCommand(argv: readonly string[], deps: RemoteDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const options = parseRemoteArgs(argv);
  if (options.help === true) {
    output(remoteUsage());
    return 0;
  }
  const plan = await buildRemotePlan(options, deps);
  if (options.dryRun === true) {
    output(JSON.stringify({ ok: true, dryRun: true, plan: remotePlanPreview(plan) }, null, 2));
    return 0;
  }
  return executeRemotePlan(plan, deps);
}
