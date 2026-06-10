import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { PRIMARY_STATE_DIR_NAME } from './app-server/state.js';
import { runNpm, type NpmRunResult } from './npm.js';
import { prepareWindowsHiddenLauncherForWorkspace } from './remote.js';
import { redactValue } from './security/redaction.js';
import { assertWorkspacePath, resolveWorkspaceRoot, workspacePath } from './security/workspace.js';
import { applyShellHookPlan, buildShellHookPlan, type ShellHookPlan } from './shell-hook.js';
import { packageName, packageVersion } from './version.js';

const MCP_SERVER_NAME = 'codex_agent_session_manager';
const TOML_MARKER_START = '# BEGIN codex-agent-session-manager';
const TOML_MARKER_END = '# END codex-agent-session-manager';
const LOCAL_PACKAGE_CLI = `node_modules/${packageName}/dist/cli.js`;
const SHELL_CODEX_POWERSHELL_SCRIPT = `${PRIMARY_STATE_DIR_NAME}/shell/codex.ps1`;
const SHELL_CODEX_POSIX_SCRIPT = `${PRIMARY_STATE_DIR_NAME}/shell/codex.mjs`;
const GITIGNORE_ENTRIES = [
  `${PRIMARY_STATE_DIR_NAME}/`,
  '.npm-cache/',
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '.secrets/',
  '*credentials*.json',
  '*token*.json',
  '*oauth*.json',
];

type InitActionKind = 'create' | 'update' | 'noop' | 'skip' | 'run';

interface ParsedInitArgs {
  workspace?: string;
  packageSpec?: string;
  dryRun?: boolean;
  json?: boolean;
  installShellHook?: boolean;
  shellHookShell?: 'powershell' | 'bash' | 'zsh';
  shellHookProfile?: string;
  shellHookWslPreferLinuxPath?: boolean;
  help?: boolean;
}

interface FileUpdate {
  path: string;
  content: string;
  reason: string;
}

export interface InitAction {
  kind: InitActionKind;
  target: string;
  reason: string;
  command?: string[];
}

export interface InitPlan {
  ok: true;
  dryRun: boolean;
  workspace: string;
  mcpServerName: string;
  actions: InitAction[];
  fileUpdates: FileUpdate[];
  windowsHiddenLauncherPath: string | null;
  shellHookPlan?: ShellHookPlan;
}

export interface InitDeps {
  output?: (text: string) => void;
}

export interface InitApplyDeps {
  npmInstaller?: (input: { workspace: string; args: string[] }) => NpmRunResult;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager init [options]

Options:
  --workspace <path>   Target workspace. Defaults to current directory.
  --package-spec <spec>
                       Package spec to install as the project devDependency.
                       Defaults to ${packageName}@${packageVersion}.
  --dry-run            Print the init plan without changing files.
  --json               Print machine-readable JSON output.
  --install-shell-hook Install/update the opt-in codex shell function hook.
  --shell-hook-shell <name>
                       Shell hook type: powershell, bash, zsh, or auto.
  --shell-hook-profile <path>
                       Shell profile path for --install-shell-hook.
  --shell-hook-wsl-prefer-linux-path
                       For bash/zsh in WSL, prefer Linux npm binaries and
                       refuse /mnt/c Windows shims in the shell hook.
  --help               Show this help.
`;
}

export function initUsage(): string {
  return usage();
}

export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const options: ParsedInitArgs = {};

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
      if (next === undefined) throw new Error(`Missing value for ${name}.`);
      index += 1;
      return next;
    };

    switch (name) {
      case '--workspace':
        options.workspace = readValue();
        break;
      case '--package-spec':
        options.packageSpec = readValue();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--install-shell-hook':
        options.installShellHook = true;
        break;
      case '--shell-hook-shell': {
        const shell = readValue();
        if (shell !== 'auto' && shell !== 'powershell' && shell !== 'bash' && shell !== 'zsh') {
          throw new Error('--shell-hook-shell must be one of: auto, powershell, bash, zsh.');
        }
        if (shell !== 'auto') {
          options.shellHookShell = shell;
        }
        break;
      }
      case '--shell-hook-profile':
        options.shellHookProfile = readValue();
        break;
      case '--shell-hook-wsl-prefer-linux-path':
        options.shellHookWslPreferLinuxPath = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown init argument: ${rawArg}`);
    }
  }

  if (options.shellHookProfile !== undefined && options.installShellHook !== true) {
    throw new Error('--shell-hook-profile requires --install-shell-hook.');
  }
  if (options.shellHookShell !== undefined && options.installShellHook !== true) {
    throw new Error('--shell-hook-shell requires --install-shell-hook.');
  }
  if (options.shellHookWslPreferLinuxPath === true && options.installShellHook !== true) {
    throw new Error('--shell-hook-wsl-prefer-linux-path requires --install-shell-hook.');
  }

  return options;
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function findMarkerLine(content: string, marker: string, fromIndex = 0): number {
  let searchIndex = fromIndex;
  while (true) {
    const index = content.indexOf(marker, searchIndex);
    if (index < 0) return -1;
    const before = index === 0 || content[index - 1] === '\n';
    const afterIndex = index + marker.length;
    const after = afterIndex === content.length || content[afterIndex] === '\n' || content[afterIndex] === '\r';
    if (before && after) return index;
    searchIndex = afterIndex;
  }
}

function replaceMarkedBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = findMarkerLine(content, start);
  if (startIndex < 0) return null;
  const endIndex = findMarkerLine(content, end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Found ${start} without ${end}.`);

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  return ensureTrailingNewline([before, block, after].filter((part) => part.length > 0).join('\n\n'));
}

function appendBlock(content: string, block: string): string {
  const before = content.trimEnd();
  return ensureTrailingNewline(before.length > 0 ? `${before}\n\n${block}` : block);
}

function mcpConfigBlock(windowsHiddenLauncherPath: string | null, useLocalPackage: boolean): string {
  if (windowsHiddenLauncherPath !== null) {
    const args = useLocalPackage
      ? `["node", "${LOCAL_PACKAGE_CLI}", "serve"]`
      : `["cmd.exe", "/d", "/s", "/c", "${packageName} serve"]`;
    return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "${PRIMARY_STATE_DIR_NAME}/windows-hidden-stdio-launcher.exe"
args = ${args}
cwd = "."
${TOML_MARKER_END}`;
  }

  if (useLocalPackage) {
    return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "node"
args = ["${LOCAL_PACKAGE_CLI}", "serve"]
cwd = "."
${TOML_MARKER_END}`;
  }

  return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "${packageName}"
args = ["serve"]
cwd = "."
${TOML_MARKER_END}`;
}

function upsertMcpConfig(content: string | null, windowsHiddenLauncherPath: string | null, useLocalPackage: boolean): string {
  const block = mcpConfigBlock(windowsHiddenLauncherPath, useLocalPackage);
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);

  const marked = replaceMarkedBlock(content, TOML_MARKER_START, TOML_MARKER_END, block);
  if (marked !== null) return marked;

  const lines = content.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line.trim() === `[mcp_servers.${MCP_SERVER_NAME}]`);
  if (sectionIndex >= 0) {
    const nextSectionIndex = lines.findIndex((line, index) => index > sectionIndex && /^\s*\[[^\]]+\]\s*$/u.test(line));
    const endIndex = nextSectionIndex >= 0 ? nextSectionIndex : lines.length;
    lines.splice(sectionIndex, endIndex - sectionIndex, ...block.split('\n'));
    return ensureTrailingNewline(lines.join('\n').trimEnd());
  }

  return appendBlock(content, block);
}

function gitignoreContent(content: string | null): string {
  if (content === null || content.trim().length === 0) return `${GITIGNORE_ENTRIES.join('\n')}\n`;
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  const missing = GITIGNORE_ENTRIES.filter((entry) => {
    if (entry === `${PRIMARY_STATE_DIR_NAME}/` && lines.includes(PRIMARY_STATE_DIR_NAME)) return false;
    return !lines.includes(entry);
  });
  if (missing.length === 0) return ensureTrailingNewline(content);
  return ensureTrailingNewline(`${content.trimEnd()}\n${missing.join('\n')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function minimalPackageJson(workspace: string): string {
  const rawName = basename(workspace).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${JSON.stringify({
    name: rawName.length > 0 ? rawName : 'codex-project',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
  }, null, 2)}\n`;
}

function defaultInitPackageSpec(): string {
  return `${packageName}@${packageVersion}`;
}

function dependencySpecForPackageJson(packageSpec: string): string {
  return packageSpec === defaultInitPackageSpec() ? packageVersion : packageSpec;
}

function packageJsonContent(content: string | null, workspace: string, packageSpec = defaultInitPackageSpec()): string {
  const source = content ?? minimalPackageJson(workspace);

  const parsed = JSON.parse(stripBom(source)) as unknown;
  if (!isRecord(parsed)) throw new Error('package.json must contain a JSON object.');

  const scripts = { ...recordFrom(parsed.scripts) };
  const wantedScripts: Record<string, string> = {
    'codex:init': `${packageName} init`,
    'codex:init:dry-run': `${packageName} init --dry-run`,
    'codex:remote': `${packageName} remote`,
    'codex:remote:dry-run': `${packageName} remote --dry-run --no-resume`,
    'codex:app-server:status': `${packageName} app-server status`,
    'codex:app-server:stop': `${packageName} app-server stop --confirm`,
    'codex:app-server:stop:dry-run': `${packageName} app-server stop --dry-run`,
  };
  for (const [name, command] of Object.entries(wantedScripts)) {
    if (scripts[name] === undefined) scripts[name] = command;
  }
  parsed.scripts = scripts;

  const dependencies = { ...recordFrom(parsed.dependencies) };
  const devDependencies = { ...recordFrom(parsed.devDependencies) };
  const dependencySpec = dependencySpecForPackageJson(packageSpec);
  if (dependencies[packageName] !== undefined) {
    dependencies[packageName] = dependencySpec;
    parsed.dependencies = dependencies;
  } else {
    devDependencies[packageName] = dependencySpec;
  }
  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = devDependencies;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function installedLocalPackageSatisfies(workspace: string, packageSpec: string, explicitPackageSpec: boolean): boolean {
  if (!existsSync(workspacePath(workspace, 'node_modules', packageName, 'dist', 'cli.js'))) return false;
  if (explicitPackageSpec) return false;

  try {
    const packageJson = JSON.parse(readFileSync(workspacePath(workspace, 'node_modules', packageName, 'package.json'), 'utf8')) as unknown;
    return isRecord(packageJson) && packageJson.version === packageVersion && packageSpec === defaultInitPackageSpec();
  } catch {
    return false;
  }
}

function npmInstallArgs(packageSpec = defaultInitPackageSpec()): string[] {
  return [
    'install',
    '--save-dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    './.npm-cache',
    packageSpec,
  ];
}

function npmCommandForDisplay(args: readonly string[]): string[] {
  return ['npm', ...args];
}

function runNpmInstall(input: { workspace: string; args: string[] }): NpmRunResult {
  return runNpm(input.args, { cwd: input.workspace });
}

function shellCodexScriptContent(): string {
  return `# Generated by codex-agent-session-manager init.
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [object[]] $CodexArgs
)

$ErrorActionPreference = 'Stop'

$shellDir = Split-Path -Parent $PSCommandPath
$managerDir = Split-Path -Parent $shellDir
$workspace = Split-Path -Parent $managerDir
$stateFile = Join-Path $managerDir 'state\\shell-resume-next.json'

function Resolve-CodexAgentSessionManagerCli {
  $candidates = @()
  $localCli = Join-Path $workspace 'node_modules\\${packageName}\\dist\\cli.js'
  if (Test-Path -LiteralPath $localCli) {
    $candidates += [pscustomobject]@{
      Command = 'node'
      PrefixArgs = @($localCli)
      Source = 'project-local'
    }
  }

  foreach ($name in @('${packageName}.cmd', '${packageName}.exe', '${packageName}')) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      $candidates += [pscustomobject]@{
        Command = $command.Source
        PrefixArgs = @()
        Source = 'path'
      }
    }
  }

  foreach ($candidate in $candidates) {
    try {
      $helpArgs = @($candidate.PrefixArgs) + @('remote', '--help')
      $helpText = (& $candidate.Command @helpArgs 2>$null | Out-String)
      if ($helpText -match '--prompt') {
        return $candidate
      }
    } catch {
      # Try the next candidate.
    }
  }

  throw 'Could not find a codex-agent-session-manager CLI that supports managed shell prompts. Re-run init with the upgraded package or update the project-local devDependency.'
}

$script:managerCli = $null
$nextArgs = @($CodexArgs)
$nextRemoteArgs = $null

function Get-CodexAgentSessionManagerCli {
  if ($null -eq $script:managerCli) {
    $script:managerCli = Resolve-CodexAgentSessionManagerCli
  }
  return $script:managerCli
}

function Resolve-CodexRealCli {
  foreach ($name in @('codex.cmd', 'codex.exe', 'codex')) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      return $command.Source
    }
  }

  throw 'Could not find the real Codex CLI application on PATH.'
}

function Should-DelegateToRealCodex {
  param([object[]] $InputArgs)

  $raw = @(Convert-CodexInputArgsToRaw $InputArgs)
  if ($raw.Count -eq 0) {
    return $false
  }
  if ($raw.Count -eq 1 -and @('--help', '-h', '--version', '-V', 'help', 'version') -contains $raw[0]) {
    return $true
  }
  if ($raw[0].StartsWith('-')) {
    return $false
  }
  if ($raw[0] -eq 'resume') {
    return $false
  }
  return Test-CodexNativeSubcommand $raw[0]
}

function Convert-CodexInputArgsToRaw {
  param([object[]] $InputArgs)

  $raw = @()
  foreach ($arg in @($InputArgs)) {
    if ($null -eq $arg) {
      continue
    }
    $text = [string] $arg
    if ($text.Length -eq 0) {
      continue
    }
    $raw += $text
  }
  return $raw
}

function Test-CodexManagerOnlyArg {
  param([string] $Arg)

  return @('--no-bypass-sandbox', '--enable-image-generation', '--no-resume', '--dry-run', '--resume-last', '--pick') -contains $Arg
}

function Test-CodexNativeSubcommand {
  param([string] $Arg)

  return @('exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'unarchive', 'fork', 'cloud', 'exec-server', 'features') -contains $Arg
}

function Convert-CodexArgsToManagedRemoteArgs {
  param([object[]] $InputArgs)

  $raw = @(Convert-CodexInputArgsToRaw $InputArgs)
  $managerArgs = @()
  $codexArgs = @()
  foreach ($arg in @($raw)) {
    if (Test-CodexManagerOnlyArg $arg) {
      $managerArgs += $arg
    } else {
      $codexArgs += $arg
    }
  }

  $remoteArgs = @('--workspace', $workspace) + @($managerArgs)
  if ($codexArgs.Count -eq 0) {
    return $remoteArgs
  }
  return @($remoteArgs + @('--') + $codexArgs)
}

function Convert-ShellResumeStateToManagedRemoteArgs {
  param($State)

  $mode = [string] $State.mode
  if ([string]::IsNullOrEmpty($mode)) {
    $mode = 'managed-remote'
  }
  if ($mode -ne 'managed-remote' -and $mode -ne 'plain') {
    throw "Unsupported codex-agent-session-manager shell resume mode: $mode"
  }

  $resumeMode = [string] $State.resumeMode
  if ([string]::IsNullOrEmpty($resumeMode)) {
    $resumeMode = 'fresh'
  }

  $remoteArgs = @('--workspace', $workspace)
  if ($resumeMode -eq 'current') {
    $threadId = [string] $State.threadId
    if ([string]::IsNullOrEmpty($threadId)) {
      throw 'codex-agent-session-manager shell resume requested current thread without threadId.'
    }
    $remoteArgs += @('--resume', $threadId)
  } elseif ($resumeMode -ne 'fresh') {
    throw "Unsupported codex-agent-session-manager shell resumeMode: $resumeMode"
  }

  if ($State.enableImageGeneration -eq $true) {
    $remoteArgs += '--enable-image-generation'
  }
  if ($State.bypassSandbox -ne $true) {
    $remoteArgs += '--no-bypass-sandbox'
  }
  if (-not [string]::IsNullOrEmpty([string] $State.prompt)) {
    $remoteArgs += @('--prompt', [string] $State.prompt)
  }

  return $remoteArgs
}

while ($true) {
  if ($null -ne $nextRemoteArgs) {
    $remoteArgs = @($nextRemoteArgs)
    $nextRemoteArgs = $null
  } elseif (Should-DelegateToRealCodex $nextArgs) {
    $realCodex = Resolve-CodexRealCli
    & $realCodex @nextArgs
    $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }
    exit $exitCode
  } else {
    $remoteArgs = Convert-CodexArgsToManagedRemoteArgs $nextArgs
  }
  $managerCli = Get-CodexAgentSessionManagerCli
  $invokeArgs = @($managerCli.PrefixArgs) + @('remote') + @($remoteArgs)
  & $managerCli.Command @invokeArgs
  $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }

  if (-not (Test-Path -LiteralPath $stateFile)) {
    exit $exitCode
  }

  $rawState = Get-Content -Raw -LiteralPath $stateFile
  Remove-Item -LiteralPath $stateFile -Force
  $state = $rawState | ConvertFrom-Json

  try {
    $nextRemoteArgs = Convert-ShellResumeStateToManagedRemoteArgs $state
  } catch {
    Write-Warning $_.Exception.Message
    exit $exitCode
  }
}
`;
}

function posixCodexScriptContent(): string {
  return `#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const shellDir = dirname(fileURLToPath(import.meta.url));
const managerDir = resolve(shellDir, '..');
const workspace = resolve(managerDir, '..');
const stateFile = join(managerDir, 'state', 'shell-resume-next.json');

function spawnText(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? String(result.stdout ?? '') : '';
}

function resolveManagerCli() {
  const localCli = join(workspace, 'node_modules', '${packageName}', 'dist', 'cli.js');
  const candidates = [];
  if (existsSync(localCli)) {
    candidates.push({ command: 'node', prefixArgs: [localCli] });
  }
  candidates.push({ command: '${packageName}', prefixArgs: [] });

  for (const candidate of candidates) {
    const helpText = spawnText(candidate.command, [...candidate.prefixArgs, 'remote', '--help']);
    if (helpText.includes('--prompt')) {
      return candidate;
    }
  }

  throw new Error('Could not find a codex-agent-session-manager CLI that supports managed shell prompts. Re-run init with the upgraded package or update the project-local devDependency.');
}

function shouldDelegateToRealCodex(raw) {
  if (raw.length === 0) return false;
  if (raw.length === 1 && ['--help', '-h', '--version', '-V', 'help', 'version'].includes(raw[0])) return true;
  if (raw[0].startsWith('-')) return false;
  if (raw[0] === 'resume') return false;
  return isCodexNativeSubcommand(raw[0]);
}

function isCodexManagerOnlyArg(arg) {
  return ['--no-bypass-sandbox', '--enable-image-generation', '--no-resume', '--dry-run', '--resume-last', '--pick'].includes(arg);
}

function isCodexNativeSubcommand(arg) {
  return ['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'unarchive', 'fork', 'cloud', 'exec-server', 'features'].includes(arg);
}

function convertCodexArgsToManagedRemoteArgs(raw) {
  const managerArgs = [];
  const codexArgs = [];
  for (const arg of raw) {
    if (isCodexManagerOnlyArg(arg)) {
      managerArgs.push(arg);
    } else {
      codexArgs.push(arg);
    }
  }
  const remoteArgs = ['--workspace', workspace, ...managerArgs];
  return codexArgs.length === 0 ? remoteArgs : [...remoteArgs, '--', ...codexArgs];
}

function resolveRealCodexCli() {
  return 'codex';
}

function convertShellResumeStateToManagedRemoteArgs(state) {
  const mode = typeof state.mode === 'string' && state.mode.length > 0 ? state.mode : 'managed-remote';
  if (mode !== 'managed-remote' && mode !== 'plain') {
    throw new Error(\`Unsupported codex-agent-session-manager shell resume mode: \${mode}\`);
  }

  const resumeMode = typeof state.resumeMode === 'string' && state.resumeMode.length > 0 ? state.resumeMode : 'fresh';
  const remoteArgs = ['--workspace', workspace];
  if (resumeMode === 'current') {
    const threadId = typeof state.threadId === 'string' ? state.threadId : '';
    if (threadId.length === 0) {
      throw new Error('codex-agent-session-manager shell resume requested current thread without threadId.');
    }
    remoteArgs.push('--resume', threadId);
  } else if (resumeMode !== 'fresh') {
    throw new Error(\`Unsupported codex-agent-session-manager shell resumeMode: \${resumeMode}\`);
  }

  if (state.enableImageGeneration === true) remoteArgs.push('--enable-image-generation');
  if (state.bypassSandbox !== true) remoteArgs.push('--no-bypass-sandbox');
  if (typeof state.prompt === 'string' && state.prompt.length > 0) remoteArgs.push('--prompt', state.prompt);
  return remoteArgs;
}

let managerCli = null;
function getManagerCli() {
  if (managerCli === null) managerCli = resolveManagerCli();
  return managerCli;
}
let nextArgs = process.argv.slice(2);
let nextRemoteArgs = null;

while (true) {
  let remoteArgs;
  if (nextRemoteArgs !== null) {
    remoteArgs = nextRemoteArgs;
    nextRemoteArgs = null;
  } else if (shouldDelegateToRealCodex(nextArgs)) {
    const result = spawnSync(resolveRealCodexCli(), nextArgs, {
      cwd: workspace,
      stdio: 'inherit',
      shell: false,
    });
    process.exit(typeof result.status === 'number' ? result.status : 1);
  } else {
    remoteArgs = convertCodexArgsToManagedRemoteArgs(nextArgs);
  }
  const activeManagerCli = getManagerCli();
  const result = spawnSync(activeManagerCli.command, [...activeManagerCli.prefixArgs, 'remote', ...remoteArgs], {
    cwd: workspace,
    stdio: 'inherit',
    shell: false,
  });
  const exitCode = typeof result.status === 'number' ? result.status : 1;

  if (!existsSync(stateFile)) {
    process.exit(exitCode);
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  rmSync(stateFile, { force: true });
  try {
    nextRemoteArgs = convertShellResumeStateToManagedRemoteArgs(state);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    process.exit(exitCode);
  }
}
`;
}

function actionForFile(path: string, current: string | null, next: string, reason: string): InitAction {
  if (current === next) return { kind: 'noop', target: path, reason };
  return { kind: current === null ? 'create' : 'update', target: path, reason };
}

function maybeAddFileUpdate(plan: InitPlan, path: string, current: string | null, next: string, reason: string): void {
  const action = actionForFile(path, current, next, reason);
  plan.actions.push(action);
  if (action.kind !== 'noop') {
    plan.fileUpdates.push({ path, content: next, reason });
  }
}

export function buildInitPlan(options: ParsedInitArgs = {}): InitPlan {
  const workspace = resolveWorkspaceRoot(options.workspace ?? process.cwd());
  const dryRun = options.dryRun === true;
  const packageSpec = options.packageSpec ?? defaultInitPackageSpec();
  const explicitPackageSpec = options.packageSpec !== undefined;
  const windowsHiddenLauncherPath = prepareWindowsHiddenLauncherForWorkspace(workspace, true);
  const plan: InitPlan = {
    ok: true,
    dryRun,
    workspace,
    mcpServerName: MCP_SERVER_NAME,
    actions: [],
    fileUpdates: [],
    windowsHiddenLauncherPath,
  };

  const codexConfigPath = workspacePath(workspace, '.codex', 'config.toml');
  const codexConfigCurrent = readTextIfExists(codexConfigPath);
  const packageJsonPath = workspacePath(workspace, 'package.json');
  const packageCurrent = readTextIfExists(packageJsonPath);
  const packageNext = packageJsonContent(packageCurrent, workspace, packageSpec);
  maybeAddFileUpdate(
    plan,
    codexConfigPath,
    codexConfigCurrent,
    upsertMcpConfig(codexConfigCurrent, windowsHiddenLauncherPath, true),
    'register project-scoped MCP server',
  );

  const gitignorePath = workspacePath(workspace, '.gitignore');
  const gitignoreCurrent = readTextIfExists(gitignorePath);
  maybeAddFileUpdate(
    plan,
    gitignorePath,
    gitignoreCurrent,
    gitignoreContent(gitignoreCurrent),
    'ignore local runtime state and common secret files',
  );

  maybeAddFileUpdate(plan, packageJsonPath, packageCurrent, packageNext, 'add npm scripts and devDependency');

  const shellCodexScriptPath = workspacePath(workspace, ...SHELL_CODEX_POWERSHELL_SCRIPT.split('/'));
  const shellCodexScriptCurrent = readTextIfExists(shellCodexScriptPath);
  maybeAddFileUpdate(
    plan,
    shellCodexScriptPath,
    shellCodexScriptCurrent,
    shellCodexScriptContent(),
    'add local PowerShell codex supervisor script',
  );

  const posixCodexScriptPath = workspacePath(workspace, ...SHELL_CODEX_POSIX_SCRIPT.split('/'));
  const posixCodexScriptCurrent = readTextIfExists(posixCodexScriptPath);
  maybeAddFileUpdate(
    plan,
    posixCodexScriptPath,
    posixCodexScriptCurrent,
    posixCodexScriptContent(),
    'add local POSIX codex supervisor script',
  );

  if (!installedLocalPackageSatisfies(workspace, packageSpec, explicitPackageSpec)) {
    const args = npmInstallArgs(packageSpec);
    plan.actions.push({
      kind: 'run',
      target: workspace,
      reason: 'install/update codex-agent-session-manager as a project devDependency',
      command: npmCommandForDisplay(args),
    });
  }

  if (plan.windowsHiddenLauncherPath !== null) {
    plan.actions.push({
      kind: existsSync(plan.windowsHiddenLauncherPath) ? 'update' : 'create',
      target: plan.windowsHiddenLauncherPath,
      reason: 'prepare Windows hidden App Server launcher',
    });
  }

  if (options.installShellHook === true) {
    const shellHookInput: Parameters<typeof buildShellHookPlan>[0] = {
      subcommand: 'install',
      confirm: !dryRun,
    };
    if (options.shellHookShell !== undefined) {
      shellHookInput.shell = options.shellHookShell;
    }
    if (options.shellHookProfile !== undefined) {
      shellHookInput.profile = options.shellHookProfile;
    }
    if (options.shellHookWslPreferLinuxPath === true) {
      shellHookInput.wslPreferLinuxPath = true;
    }
    const shellHookPlan = buildShellHookPlan(shellHookInput);
    plan.shellHookPlan = shellHookPlan;
    const action = shellHookPlan.actions[0];
    plan.actions.push({
      kind: action?.kind === 'noop' ? 'noop' : action?.kind === 'create' ? 'create' : 'update',
      target: '<shell-profile>',
      reason: action?.reason ?? 'install codex shell function hook',
    });
  }

  return plan;
}

export function applyInitPlan(plan: InitPlan, deps: InitApplyDeps = {}): void {
  for (const update of plan.fileUpdates) {
    assertWorkspacePath(plan.workspace, update.path);
    mkdirSync(dirname(update.path), { recursive: true });
    writeFileSync(update.path, update.content, 'utf8');
  }

  const runAction = plan.actions.find((action) => action.kind === 'run' && action.command?.[0] === 'npm');
  if (runAction?.command !== undefined) {
    const args = runAction.command.slice(1);
    const installer = deps.npmInstaller ?? runNpmInstall;
    const result = installer({ workspace: plan.workspace, args });
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? String(result.stderr ?? result.stdout ?? 'unknown npm failure').trim();
      throw new Error(`npm install failed while initializing ${packageName}: ${reason}`);
    }
  }

  if (plan.windowsHiddenLauncherPath !== null) {
    prepareWindowsHiddenLauncherForWorkspace(plan.workspace, false);
  }

  if (plan.shellHookPlan !== undefined) {
    applyShellHookPlan(plan.shellHookPlan);
  }
}

export function initPlanPreview(plan: InitPlan, applied: boolean): Record<string, unknown> {
  return redactValue(
    {
      ok: plan.ok,
      applied,
      dryRun: plan.dryRun,
      workspace: '<workspace>',
      mcpServerName: plan.mcpServerName,
      actions: plan.actions,
    },
    { workspace: plan.workspace },
  ) as Record<string, unknown>;
}

function previewPath(path: string, workspace: string): string {
  const normalizedWorkspace = workspace.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath === normalizedWorkspace) return '<workspace>';
  if (normalizedPath.startsWith(`${normalizedWorkspace}\\`) || normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return `<workspace>${path.slice(workspace.length)}`;
  }
  return String(redactValue(path, { workspace }));
}

function formatHumanInitPlan(plan: InitPlan, applied: boolean): string {
  const lines = [
    `codex-agent-session-manager init ${plan.dryRun ? 'dry-run' : applied ? 'applied' : 'plan'}`,
    `workspace: <workspace>`,
    `mcp server: ${plan.mcpServerName}`,
  ];
  lines.push('', 'actions:');
  for (const action of plan.actions) {
    const kind = action.kind.padEnd(6, ' ');
    lines.push(`  ${kind} ${previewPath(action.target, plan.workspace)} - ${action.reason}`);
  }
  if (plan.dryRun) {
    lines.push('', 'Dry run only; no files were changed.');
  }
  return lines.join('\n');
}

export async function runInitCommand(argv: readonly string[], deps: InitDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const options = parseInitArgs(argv);
  if (options.help === true) {
    output(usage().trimEnd());
    return 0;
  }

  const plan = buildInitPlan(options);
  if (!plan.dryRun) {
    applyInitPlan(plan);
  }
  output(
    options.json === true
      ? JSON.stringify(initPlanPreview(plan, !plan.dryRun), null, 2)
      : formatHumanInitPlan(plan, !plan.dryRun),
  );
  return 0;
}
