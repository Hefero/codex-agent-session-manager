import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface NpmRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface NpmCommand {
  command: string;
  args: string[];
  displayCommand: string[];
  strategy: 'npm-bin' | 'node-npm-cli' | 'cmd-npm-shim';
}

export interface ResolveNpmCommandDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  npmCliPath?: string;
  pathExists?: (path: string) => boolean;
}

export function resolveNpmCommand(args: readonly string[], deps: ResolveNpmCommandDeps = {}): NpmCommand {
  const platform = deps.platform ?? process.platform;
  const displayCommand = ['npm', ...args];

  if (platform === 'win32') {
    const execPath = deps.execPath ?? process.execPath;
    const npmCliPath = deps.npmCliPath ?? join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pathExists = deps.pathExists ?? existsSync;
    if (pathExists(npmCliPath)) {
      return {
        command: execPath,
        args: [npmCliPath, ...args],
        displayCommand,
        strategy: 'node-npm-cli',
      };
    }
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', 'npm.cmd', ...args],
      displayCommand,
      strategy: 'cmd-npm-shim',
    };
  }

  return {
    command: 'npm',
    args: [...args],
    displayCommand,
    strategy: 'npm-bin',
  };
}

export function runNpm(args: readonly string[], options: { cwd: string }): NpmRunResult {
  const command = resolveNpmCommand(args);
  const result = spawnSync(command.command, command.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}
