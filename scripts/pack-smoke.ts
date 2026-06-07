import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackFile {
  path?: string;
}

interface PackEntry {
  filename?: string;
  files?: PackFile[];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const packageName = 'codex-agent-session-manager';

function npmInvocation(): { command: string; prefix: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function runNpm(args: readonly string[], cwd: string): { stdout: string; stderr: string } {
  const npm = npmInvocation();
  return run(npm.command, [...npm.prefix, ...args], cwd);
}

function run(command: string, args: readonly string[], cwd: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        `cwd=${cwd}`,
        result.error ? `error=${result.error.message}` : null,
        `stdout=${result.stdout ?? ''}`,
        `stderr=${result.stderr ?? ''}`,
      ].join('\n'),
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parsePackJson(stdout: string): PackEntry {
  const trimmed = stdout.trim();
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error(`Unexpected npm pack --json output: ${trimmed}`);
  }
  return parsed[0] as PackEntry;
}

function normalizePackPath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^package\//u, '');
}

function assertIncludes(files: Set<string>, path: string): void {
  if (!files.has(path)) throw new Error(`Expected package to include ${path}.`);
}

function assertExcludes(files: Set<string>, pattern: RegExp, label: string): void {
  const found = [...files].filter((file) => pattern.test(file));
  if (found.length > 0) throw new Error(`Package unexpectedly included ${label}: ${found.join(', ')}`);
}

function readJson(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function scriptMap(packageJson: Record<string, unknown>): Record<string, string> {
  const scripts = packageJson.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  return scripts as Record<string, string>;
}

function expectedGeneratedScripts(): Record<string, string> {
  return {
    'codex:init': 'codex-agent-session-manager init',
    'codex:init:dry-run': 'codex-agent-session-manager init --dry-run',
    'codex:remote': 'codex-agent-session-manager remote',
    'codex:remote:dry-run': 'codex-agent-session-manager remote --dry-run --no-resume',
    'codex:app-server:status': 'codex-agent-session-manager app-server status',
    'codex:app-server:stop': 'codex-agent-session-manager app-server stop --dry-run',
  };
}

function validateInstalledProject(targetWorkspace: string): void {
  const config = readFileSync(join(targetWorkspace, '.codex', 'config.toml'), 'utf8');
  if (!config.includes('[mcp_servers.codex_agent_session_manager]')) {
    throw new Error('Generated .codex/config.toml did not register codex_agent_session_manager.');
  }
  if (!config.includes('command = "codex-agent-session-manager"') || !config.includes('args = ["serve"]')) {
    throw new Error('Generated .codex/config.toml has an unexpected command or args.');
  }

  const gitignore = readFileSync(join(targetWorkspace, '.gitignore'), 'utf8');
  if (!gitignore.includes('.codex-agent-session-manager/')) {
    throw new Error('Generated .gitignore did not include .codex-agent-session-manager/.');
  }

  const agents = readFileSync(join(targetWorkspace, 'AGENTS.md'), 'utf8');
  if (!agents.includes('codex-agent-session-manager:start') || !agents.includes('MCP callable-catalog validation')) {
    throw new Error('Generated AGENTS.md did not include the managed session-manager block.');
  }

  const scripts = scriptMap(readJson(join(targetWorkspace, 'package.json')));
  const expectedScripts = expectedGeneratedScripts();
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (scripts[name] !== command) throw new Error(`Expected package script ${name}=${command}.`);
  }
}

function validateDeinitializedProject(targetWorkspace: string): void {
  const configPath = join(targetWorkspace, '.codex', 'config.toml');
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf8');
    if (config.includes('codex_agent_session_manager') || config.includes('# BEGIN codex-agent-session-manager')) {
      throw new Error('deinit did not remove the session-manager MCP config block.');
    }
  }

  const gitignorePath = join(targetWorkspace, '.gitignore');
  if (existsSync(gitignorePath) && readFileSync(gitignorePath, 'utf8').includes('.codex-agent-session-manager/')) {
    throw new Error('deinit did not remove the runtime gitignore entry.');
  }

  const agentsPath = join(targetWorkspace, 'AGENTS.md');
  if (existsSync(agentsPath) && readFileSync(agentsPath, 'utf8').includes('codex-agent-session-manager:start')) {
    throw new Error('deinit did not remove the managed AGENTS.md block.');
  }

  const scripts = scriptMap(readJson(join(targetWorkspace, 'package.json')));
  for (const scriptName of Object.keys(expectedGeneratedScripts())) {
    if (scripts[scriptName] !== undefined) throw new Error(`deinit did not remove generated script ${scriptName}.`);
  }

  if (existsSync(join(targetWorkspace, '.codex-agent-session-manager'))) {
    throw new Error('deinit --remove-runtime did not delete runtime state.');
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-pack-smoke-'));
try {
  const packDir = join(tempRoot, 'pack');
  const targetWorkspace = join(tempRoot, 'target');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(targetWorkspace, { recursive: true });
  writeFileSync(join(targetWorkspace, 'package.json'), `${JSON.stringify({ name: 'pack-smoke-target' }, null, 2)}\n`);

  const pack = parsePackJson(runNpm(['pack', '--pack-destination', packDir, '--json'], repoRoot).stdout);
  const sourcePackageJson = readJson(join(repoRoot, 'package.json'));
  const expectedVersion = sourcePackageJson.version;
  if (typeof expectedVersion !== 'string') throw new Error('package.json version must be a string.');

  const files = new Set((pack.files ?? []).map((file) => normalizePackPath(file.path ?? '')).filter(Boolean));
  assertIncludes(files, 'package.json');
  assertIncludes(files, 'README.md');
  assertIncludes(files, 'LICENSE');
  assertIncludes(files, 'dist/cli.js');
  assertIncludes(files, 'scripts/windows-hidden-stdio-launcher.cs');
  assertExcludes(files, /^(?:test|docs|src)\//u, 'source/test/docs files');
  assertExcludes(files, /^\.codex(?:-|\/)|^\.codex\//u, 'Codex runtime config');
  assertExcludes(files, /\.exe$/iu, 'runtime executables');

  if (!pack.filename) throw new Error('npm pack output did not include a filename.');
  const tarballPath = resolve(packDir, basename(pack.filename));
  if (!existsSync(tarballPath)) throw new Error(`Packed tarball was not created: ${tarballPath}`);

  runNpm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], targetWorkspace);

  const installedCli = join(targetWorkspace, 'node_modules', packageName, 'dist', 'cli.js');
  const installedVersion = run(process.execPath, [installedCli, '--version'], targetWorkspace).stdout.trim();
  if (installedVersion !== expectedVersion) {
    throw new Error(`Expected installed CLI version ${expectedVersion}, got ${installedVersion}.`);
  }
  run(process.execPath, [installedCli, 'init', '--dry-run', '--workspace', targetWorkspace], targetWorkspace);
  run(process.execPath, [installedCli, 'init', '--workspace', targetWorkspace], targetWorkspace);
  run(process.execPath, [installedCli, 'init', '--dry-run', '--workspace', targetWorkspace], targetWorkspace);
  validateInstalledProject(targetWorkspace);

  const remoteDryRun = runNpm(['run', 'codex:remote:dry-run'], targetWorkspace).stdout;
  if (!remoteDryRun.includes('"dryRun": true') || !remoteDryRun.includes('"stateFile"')) {
    throw new Error(`Unexpected codex:remote:dry-run output: ${remoteDryRun}`);
  }

  run(process.execPath, [installedCli, 'deinit', '--workspace', targetWorkspace], targetWorkspace);
  run(process.execPath, [installedCli, 'deinit', '--workspace', targetWorkspace, '--confirm', '--remove-runtime'], targetWorkspace);
  validateDeinitializedProject(targetWorkspace);

  process.stdout.write(`${JSON.stringify({ ok: true, packedFiles: files.size }, null, 2)}\n`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
