import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';

import { redactSensitiveText } from './security/redaction.js';

export interface ProcessEntry {
  pid: number;
  parentPid: number | null;
  name: string;
  commandLine: string;
}

export interface ProcessSummary {
  pid: number;
  parentPid: number | null;
  name: string;
  commandLinePreview: string;
}

export interface RemoteTuiMatchOptions {
  appServerUrl: string;
  workspace: string;
  threadId: string;
  allowWorkspaceUrlFallback?: boolean | undefined;
}

export interface RemoteTuiTargets {
  remoteProcesses: ProcessEntry[];
  roots: ProcessEntry[];
}

function normalizeProcess(raw: Record<string, unknown>): ProcessEntry | null {
  const pid = Number(raw.ProcessId ?? raw.pid);
  const parentPid = Number(raw.ParentProcessId ?? raw.ppid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    pid,
    parentPid: Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : null,
    name: String(raw.Name ?? raw.name ?? ''),
    commandLine: String(raw.CommandLine ?? raw.commandLine ?? ''),
  };
}

function runPowerShellJson(script: string): unknown[] {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(`PowerShell process query failed: ${result.stderr || result.stdout}`);
  }

  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function listWindowsProcesses(): ProcessEntry[] {
  const rows = runPowerShellJson(`@(
    Get-CimInstance Win32_Process |
      Select-Object ProcessId,ParentProcessId,Name,CommandLine
  ) | ConvertTo-Json -Compress -Depth 3`);
  return rows
    .map((row) => (row && typeof row === 'object' ? normalizeProcess(row as Record<string, unknown>) : null))
    .filter((entry): entry is ProcessEntry => entry !== null);
}

function listPosixProcesses(): ProcessEntry[] {
  const args = process.platform === 'darwin'
    ? ['-ww', '-axo', 'pid=,ppid=,comm=,args=']
    : ['-ww', '-eo', 'pid=,ppid=,comm=,args='];
  const result = spawnSync('ps', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`ps process query failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
      if (!match) return null;
      return normalizeProcess({
        pid: match[1],
        ppid: match[2],
        name: match[3],
        commandLine: match[4],
      });
    })
    .filter((entry): entry is ProcessEntry => entry !== null);
}

export function listProcesses(): ProcessEntry[] {
  return process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
}

export function commandLineTokens(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of String(commandLine).matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) tokens.push(token);
  }
  return tokens;
}

function basenameToken(token: unknown): string {
  return String(token ?? '')
    .replace(/^["']+|["']+$/gu, '')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? '';
}

function optionValue(tokens: readonly string[], names: readonly string[]): string | null {
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

function hasToken(tokens: readonly string[], expected: string): boolean {
  return tokens.some((token) => token === expected);
}

function isCodexAppServerProcess(entry: ProcessEntry): boolean {
  const tokens = commandLineTokens(entry.commandLine);
  return isCodexLikeProcess(entry, tokens) && hasToken(tokens, 'app-server');
}

function isCodexLikeProcess(entry: ProcessEntry, tokens: readonly string[]): boolean {
  return /^codex(?:\.(?:cmd|exe|js))?$/iu.test(basenameToken(entry.name))
    || tokens.some((token) => /^codex(?:\.(?:cmd|exe|js))?$/iu.test(basenameToken(token)));
}

function normalizePathForCompare(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathsMatch(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || left.length === 0) return false;
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export function normalizeAppServerUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    if (!parsed.port) return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    const serialized = parsed.toString();
    return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
  } catch {
    return null;
  }
}

function referencesThreadId(tokens: readonly string[], threadId: string): boolean {
  if (optionValue(tokens, ['--session-id']) === threadId) return true;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === 'resume' && tokens[index + 1] === threadId) return true;
  }
  return false;
}

export function isRemoteTuiProcess(entry: ProcessEntry, options: RemoteTuiMatchOptions): boolean {
  if (isShellProcess(entry)) return false;
  const tokens = commandLineTokens(entry.commandLine);
  if (!isCodexLikeProcess(entry, tokens)) return false;
  if (hasToken(tokens, 'app-server')) return false;

  const remote = optionValue(tokens, ['--remote']);
  if (normalizeAppServerUrl(remote) !== normalizeAppServerUrl(options.appServerUrl)) return false;

  const cwd = optionValue(tokens, ['-C', '--cd']);
  if (!pathsMatch(cwd, options.workspace)) return false;

  return options.allowWorkspaceUrlFallback === true || referencesThreadId(tokens, options.threadId);
}

function isRemoteWrapperProcess(entry: ProcessEntry): boolean {
  const commandLine = entry.commandLine.replace(/\\/gu, '/');
  return /codex-remote\.(?:mjs|js)/iu.test(commandLine)
    || (/cli\.(?:mjs|js)/iu.test(commandLine) && /(?:^|\s)remote(?:\s|$)/iu.test(commandLine));
}

function isShellProcess(entry: ProcessEntry): boolean {
  return /^(?:cmd|powershell|pwsh)(?:\.exe)?$/iu.test(basenameToken(entry.name));
}

function normalizedForSearch(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
}

function isDedicatedRemoteTerminalProcess(entry: ProcessEntry, workspace: string): boolean {
  if (!isShellProcess(entry)) return false;
  const commandLine = normalizedForSearch(entry.commandLine);
  return commandLine.includes(normalizedForSearch(workspace)) && commandLine.includes('/.codex-agent-session-manager/state/remote-');
}

function isRemoteShellTerminalProcess(entry: ProcessEntry, options: RemoteTuiMatchOptions): boolean {
  if (!isShellProcess(entry)) return false;
  const tokens = commandLineTokens(entry.commandLine);
  if (!isCodexLikeProcess(entry, tokens)) return false;
  if (hasToken(tokens, 'app-server')) return false;

  const remote = optionValue(tokens, ['--remote']);
  if (normalizeAppServerUrl(remote) !== normalizeAppServerUrl(options.appServerUrl)) return false;

  const cwd = optionValue(tokens, ['-C', '--cd']);
  if (!pathsMatch(cwd, options.workspace)) return false;

  return options.allowWorkspaceUrlFallback === true || referencesThreadId(tokens, options.threadId);
}

function processByPid(processes: readonly ProcessEntry[]): Map<number, ProcessEntry> {
  return new Map(processes.map((entry) => [entry.pid, entry]));
}

function descendantsContainAppServer(processes: readonly ProcessEntry[], rootPid: number): boolean {
  const children = childrenByParent(processes);
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.pid)) continue;
    seen.add(current.pid);
    if (isCodexAppServerProcess(current)) return true;
    queue.push(...(children.get(current.pid) ?? []));
  }
  return false;
}

export function findRemoteTuiTargets(processes: readonly ProcessEntry[], options: RemoteTuiMatchOptions): RemoteTuiTargets {
  const byPid = processByPid(processes);
  const remoteProcesses = processes.filter((entry) => isRemoteTuiProcess(entry, options));
  const roots = new Map<number, ProcessEntry>();

  for (const remote of remoteProcesses) {
    let root = remote;
    let parent = root.parentPid === null ? undefined : byPid.get(root.parentPid);
    while (
      parent
      && (
        (isRemoteWrapperProcess(parent) && !descendantsContainAppServer(processes, parent.pid))
        || isDedicatedRemoteTerminalProcess(parent, options.workspace)
        || isRemoteShellTerminalProcess(parent, options)
        || isRemoteTuiProcess(parent, options)
      )
    ) {
      root = parent;
      parent = root.parentPid === null ? undefined : byPid.get(root.parentPid);
    }
    roots.set(root.pid, root);
  }

  return {
    remoteProcesses,
    roots: [...roots.values()],
  };
}

function childrenByParent(processes: readonly ProcessEntry[]): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    if (entry.parentPid === null) continue;
    children.set(entry.parentPid, [...(children.get(entry.parentPid) ?? []), entry]);
  }
  return children;
}

export function collectProcessTree(processes: readonly ProcessEntry[], rootPids: readonly number[]): ProcessEntry[] {
  const children = childrenByParent(processes);
  const seen = new Set<number>();
  const ordered: ProcessEntry[] = [];
  const queue = [...rootPids];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const current = processes.find((entry) => entry.pid === pid);
    if (current) ordered.push(current);
    for (const child of children.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }

  return ordered;
}

export function summarizeProcesses(processes: readonly ProcessEntry[]): ProcessSummary[] {
  return processes.map((entry) => ({
    pid: entry.pid,
    parentPid: entry.parentPid,
    name: entry.name,
    commandLinePreview: entry.commandLine ? redactSensitiveText(entry.commandLine).slice(0, 240) : '',
  }));
}

export function stopProcessTree(rootPid: number, tree: readonly ProcessEntry[] = [], signal = 'SIGTERM'): SpawnSyncReturns<string> | {
  status: number;
  stdout: string;
  stderr: string;
} {
  if (process.platform === 'win32') {
    return spawnSync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  const targets = [...new Set((tree.length > 0 ? tree : [{ pid: rootPid }]).map((entry) => entry.pid))].reverse();
  const failures: string[] = [];

  try {
    process.kill(-rootPid, signal);
  } catch {
    // Root may not be a POSIX process-group leader; fall back to the process tree.
  }

  for (const pid of targets) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') continue;
      failures.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: failures.length === 0 ? 0 : 1,
    stdout: '',
    stderr: failures.join('\n'),
  };
}
