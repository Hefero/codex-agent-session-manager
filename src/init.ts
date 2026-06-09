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
const AGENTS_MARKER_START = '<!-- codex-agent-session-manager:start -->';
const AGENTS_MARKER_END = '<!-- codex-agent-session-manager:end -->';
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
  dryRun?: boolean;
  agents?: boolean;
  json?: boolean;
  installShellHook?: boolean;
  shellHookShell?: 'powershell' | 'bash' | 'zsh';
  shellHookProfile?: string;
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
  --dry-run            Print the init plan without changing files.
  --json               Print machine-readable JSON output.
  --no-agents          Do not create or update AGENTS.md.
  --install-shell-hook Install/update the opt-in codex shell function hook.
  --shell-hook-shell <name>
                       Shell hook type: powershell, bash, zsh, or auto.
  --shell-hook-profile <path>
                       Shell profile path for --install-shell-hook.
  --help               Show this help.
`;
}

export function initUsage(): string {
  return usage();
}

export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const options: ParsedInitArgs = { agents: true };

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
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-agents':
        options.agents = false;
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
${TOML_MARKER_END}`;
  }

  if (useLocalPackage) {
    return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "node"
args = ["${LOCAL_PACKAGE_CLI}", "serve"]
${TOML_MARKER_END}`;
  }

  return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "${packageName}"
args = ["serve"]
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

function packageJsonContent(content: string | null, workspace: string): string {
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
    'codex:app-server:stop': `${packageName} app-server stop --dry-run`,
  };
  for (const [name, command] of Object.entries(wantedScripts)) {
    if (scripts[name] === undefined) scripts[name] = command;
  }
  parsed.scripts = scripts;

  const dependencies = recordFrom(parsed.dependencies);
  const devDependencies = { ...recordFrom(parsed.devDependencies) };
  if (dependencies[packageName] === undefined && devDependencies[packageName] === undefined) {
    devDependencies[packageName] = packageVersion;
  }
  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = devDependencies;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function installedLocalPackageExists(workspace: string): boolean {
  return existsSync(workspacePath(workspace, 'node_modules', packageName, 'dist', 'cli.js'));
}

function npmInstallArgs(): string[] {
  return [
    'install',
    '--save-dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    './.npm-cache',
    `${packageName}@${packageVersion}`,
  ];
}

function npmCommandForDisplay(args: readonly string[]): string[] {
  return ['npm', ...args];
}

function runNpmInstall(input: { workspace: string; args: string[] }): NpmRunResult {
  return runNpm(input.args, { cwd: input.workspace });
}

function agentsBlock(): string {
  return `${AGENTS_MARKER_START}
## Codex Agent Session Manager

This project uses \`${packageName}\` for Codex App Server session control and
MCP callable-catalog validation.

Useful commands:

- \`npm run codex:init\`
- \`npm run codex:init:dry-run\`
- \`npm run codex:remote\`
- \`npm run codex:remote:dry-run\`
- \`${packageName} mcp add npm <package-spec> --dry-run\`
- \`${packageName} mcp add npm <package-spec> --confirm\`
- \`${packageName} mcp add npm <package-spec> --env-var <NAME> --confirm\`
  for env/auth MCPs; this forwards env var names without storing values in
  project config.
- \`${packageName} mcp refresh --thread-id <thread-id>\`

For OAuth, PII, write-capable, or destructive MCPs:

- Prefer \`${packageName} mcp add npm ...\` over raw \`npm\` commands. On
  Windows PowerShell, raw \`npm\` can hit \`npm.ps1\` execution policy or a
  user-global npm cache outside the workspace; if raw npm is unavoidable, use
  \`npm.cmd\` and a workspace-local cache such as \`--cache ./.npm-cache\`.
- Prefer read-only scopes first. Escalate to read/write or delete scopes only
  after explicit operator approval.
- Do not patch files under \`node_modules\`. If an MCP package needs different
  behavior, create a project-local wrapper or a dedicated package.
- Do not validate by launching stdio MCP entrypoints in a visible terminal.
  Stdio MCP servers are long-lived and can leave orphan node/cmd windows.
  Prefer App Server refresh plus a real model-callable tool call.
- Keep OAuth client files, tokens, and API keys outside the workspace or under
  ignored paths such as \`.secrets/\`. Do not print sensitive values.
- If env vars were created or changed after App Server started, restart or
  relaunch the managed App Server before refresh, or use a reviewed local
  wrapper that reads the intended user-scoped config.

Treat App Server MCP status as diagnostic. Validate MCP changes with a real
tool call from the continuation or replacement turn. Once the target MCP tool
call succeeds from the model-callable catalog, stop validation and report the
result; do not keep probing or fall back to direct MCP SDK calls. If a changed
MCP is not callable yet, keep using \`${packageName} mcp refresh --thread-id <thread-id>\`
or session replacement until a fresh turn proves the call. Direct MCP SDK calls
are diagnostic only; they do not prove the model-callable catalog refreshed.
When scheduling a continuation for the current thread, do not call
\`codex_operation_wait\` or \`codex_operation_read\` from that same active turn.
End the current turn so the background child can observe the target thread as
idle and start the continuation.
${AGENTS_MARKER_END}`;
}

function agentsContent(content: string | null): string {
  const block = agentsBlock();
  if (content === null || content.trim().length === 0) {
    return ensureTrailingNewline(`# Project Agent Notes\n\n${block}`);
  }

  const marked = replaceMarkedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END, block);
  if (marked !== null) return marked;
  return appendBlock(content, block);
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

$managerCli = Resolve-CodexAgentSessionManagerCli
$nextArgs = @($CodexArgs)
$nextRemoteArgs = $null

function Convert-CodexArgsToManagedRemoteArgs {
  param([object[]] $InputArgs)

  $raw = @($InputArgs | ForEach-Object { [string] $_ })
  $remoteArgs = @('--workspace', $workspace)

  if ($raw.Count -eq 0) {
    return $remoteArgs
  }

  if ($raw[0] -eq 'resume') {
    if ($raw.Count -ge 2 -and $raw[1] -eq '--last') {
      $remoteArgs += '--resume-last'
      if ($raw.Count -gt 2) {
        $remoteArgs += @('--prompt', ($raw[2..($raw.Count - 1)] -join ' '))
      }
      return $remoteArgs
    }

    if ($raw.Count -ge 2 -and -not $raw[1].StartsWith('-')) {
      $remoteArgs += @('--resume', $raw[1])
      if ($raw.Count -gt 2) {
        $remoteArgs += @('--prompt', ($raw[2..($raw.Count - 1)] -join ' '))
      }
      return $remoteArgs
    }

    $remoteArgs += '--pick'
    return $remoteArgs
  }

  if ($raw.Count -eq 1 -and -not $raw[0].StartsWith('-')) {
    $remoteArgs += @('--prompt', $raw[0])
    return $remoteArgs
  }

  return @($remoteArgs + $raw)
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
  } else {
    $remoteArgs = Convert-CodexArgsToManagedRemoteArgs $nextArgs
  }
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

function promptFromRest(values, startIndex) {
  return values.slice(startIndex).join(' ');
}

function convertCodexArgsToManagedRemoteArgs(raw) {
  const remoteArgs = ['--workspace', workspace];
  if (raw.length === 0) return remoteArgs;

  if (raw[0] === 'resume') {
    if (raw.length >= 2 && raw[1] === '--last') {
      remoteArgs.push('--resume-last');
      if (raw.length > 2) remoteArgs.push('--prompt', promptFromRest(raw, 2));
      return remoteArgs;
    }

    if (raw.length >= 2 && !raw[1].startsWith('-')) {
      remoteArgs.push('--resume', raw[1]);
      if (raw.length > 2) remoteArgs.push('--prompt', promptFromRest(raw, 2));
      return remoteArgs;
    }

    remoteArgs.push('--pick');
    return remoteArgs;
  }

  if (raw.length === 1 && !raw[0].startsWith('-')) {
    remoteArgs.push('--prompt', raw[0]);
    return remoteArgs;
  }

  return [...remoteArgs, ...raw];
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

const managerCli = resolveManagerCli();
let nextArgs = process.argv.slice(2);
let nextRemoteArgs = null;

while (true) {
  const remoteArgs = nextRemoteArgs ?? convertCodexArgsToManagedRemoteArgs(nextArgs);
  nextRemoteArgs = null;
  const result = spawnSync(managerCli.command, [...managerCli.prefixArgs, 'remote', ...remoteArgs], {
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
  const packageNext = packageJsonContent(packageCurrent, workspace);
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

  if (!installedLocalPackageExists(workspace)) {
    const args = npmInstallArgs();
    plan.actions.push({
      kind: 'run',
      target: workspace,
      reason: 'install codex-agent-session-manager as a project devDependency',
      command: npmCommandForDisplay(args),
    });
  }

  const agentsPath = workspacePath(workspace, 'AGENTS.md');
  if (options.agents === false) {
    plan.actions.push({ kind: 'skip', target: agentsPath, reason: 'disabled by --no-agents' });
  } else {
    const agentsCurrent = readTextIfExists(agentsPath);
    maybeAddFileUpdate(
      plan,
      agentsPath,
      agentsCurrent,
      agentsContent(agentsCurrent),
      'add agent operating notes',
    );
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
    '',
    'actions:',
  ];
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
