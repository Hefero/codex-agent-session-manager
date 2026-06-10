import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { prepareWindowsHiddenLauncherForDirectory } from './remote.js';
import { applyShellHookPlan, buildShellHookPlan, shellHookActivationCommand, type ShellHookPlan } from './shell-hook.js';
import { packageName } from './version.js';

const MCP_SERVER_NAME = 'codex_agent_session_manager';
const MARKER_START = '# BEGIN codex-agent-session-manager:global';
const MARKER_END = '# END codex-agent-session-manager:global';
const GLOBAL_STATE_DIR_NAME = '.codex-agent-session-manager';

type GlobalSubcommand = 'install' | 'uninstall' | 'status';

interface ParsedGlobalArgs {
  subcommand?: GlobalSubcommand;
  config?: string;
  stateDir?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
  mcpOnly?: boolean;
  shellHookOnly?: boolean;
  shellHookShell?: 'powershell' | 'bash' | 'zsh';
  shellHookProfile?: string;
  shellHookWslPreferLinuxPath?: boolean;
  help?: boolean;
}

type GlobalActionKind = 'create' | 'update' | 'remove' | 'noop' | 'skip';

interface GlobalAction {
  kind: GlobalActionKind;
  target: string;
  reason: string;
}

interface GlobalFileUpdate {
  path: string;
  content: string | null;
  reason: string;
}

export interface GlobalPlan {
  ok: true;
  subcommand: GlobalSubcommand;
  dryRun: boolean;
  configPath: string;
  stateDir: string;
  mcpEnabled: boolean;
  shellHookEnabled: boolean;
  mcpInstalled: boolean;
  mcpUnmanagedConflict: boolean;
  shellHookInstalled: boolean | null;
  windowsHiddenLauncherPath: string | null;
  actions: GlobalAction[];
  fileUpdates: GlobalFileUpdate[];
  shellHookPlan?: ShellHookPlan;
}

export interface GlobalDeps {
  output?: (text: string) => void;
}

export interface GlobalApplyDeps {
  prepareWindowsHiddenLauncher?: (directory: string, dryRun: boolean) => string | null;
  applyShellHook?: (plan: ShellHookPlan) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager global install [options]
  codex-agent-session-manager global uninstall [options]
  codex-agent-session-manager global status [options]

Options:
  --config <path>          User Codex config path. Defaults to ~/.codex/config.toml.
  --state-dir <path>       User-global runtime dir. Defaults to ~/.codex-agent-session-manager.
  --mcp-only               Install/uninstall/status only the user-global MCP config.
  --shell-hook-only        Install/uninstall/status only the global codex shell hook.
  --shell-hook-shell <name>
                           Shell hook type: powershell, bash, zsh, or auto.
  --shell-hook-profile <path>
                           Shell profile path for the shell hook.
  --shell-hook-wsl-prefer-linux-path
                           For bash/zsh in WSL, prefer Linux npm binaries and
                           refuse /mnt/c Windows shims in the shell hook.
  --dry-run                Preview only. This is the default unless --confirm is passed.
  --confirm                Apply install/uninstall changes.
  --json                   Print machine-readable JSON output.
  --help                   Show this help.
`;
}

export function globalUsage(): string {
  return usage();
}

function defaultConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function defaultGlobalStateDir(): string {
  return join(homedir(), GLOBAL_STATE_DIR_NAME);
}

function resolvePath(path: string | undefined, fallback: string): string {
  return resolve(path ?? fallback);
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

function replaceMarkedBlock(content: string, block: string | null): string | null {
  const startIndex = findMarkerLine(content, MARKER_START);
  if (startIndex < 0) return null;
  const endIndex = findMarkerLine(content, MARKER_END, startIndex + MARKER_START.length);
  if (endIndex < 0) throw new Error(`Found ${MARKER_START} without ${MARKER_END}.`);

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + MARKER_END.length).trimStart();
  const joined = [before, block, after].filter((part): part is string => Boolean(part && part.length > 0)).join('\n\n');
  return joined.length > 0 ? ensureTrailingNewline(joined) : '';
}

function appendBlock(content: string | null, block: string): string {
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);
  return ensureTrailingNewline(`${content.trimEnd()}\n\n${block}`);
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/gu, '/'));
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function hasMcpSection(content: string | null): boolean {
  if (content === null) return false;
  return new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]\\s*$`, 'mu').test(content);
}

function hasManagedGlobalBlock(content: string | null): boolean {
  return content !== null && findMarkerLine(content, MARKER_START) >= 0;
}

function globalMcpBlock(windowsHiddenLauncherPath: string | null): string {
  if (windowsHiddenLauncherPath !== null) {
    return `${MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = ${tomlString(windowsHiddenLauncherPath)}
args = ${tomlArray(['cmd.exe', '/d', '/s', '/c', `${packageName} serve`])}
cwd = "."
${MARKER_END}`;
  }

  return `${MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "${packageName}"
args = ["serve"]
cwd = "."
${MARKER_END}`;
}

function upsertGlobalMcpConfig(content: string | null, windowsHiddenLauncherPath: string | null): string {
  const block = globalMcpBlock(windowsHiddenLauncherPath);
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);

  const marked = replaceMarkedBlock(content, block);
  if (marked !== null) return marked;

  if (hasMcpSection(content)) {
    throw new Error(`User Codex config already has an unmanaged [mcp_servers.${MCP_SERVER_NAME}] section. Remove it manually or choose project-scoped init.`);
  }

  return appendBlock(content, block);
}

function removeGlobalMcpConfig(content: string | null): string | null {
  if (content === null) return null;
  const next = replaceMarkedBlock(content, null);
  if (next === null) return content;
  return next.trim().length > 0 ? ensureTrailingNewline(next.trimEnd()) : null;
}

function actionForFile(path: string, current: string | null, next: string | null, reason: string): GlobalAction {
  if (current === null && next === null) return { kind: 'noop', target: path, reason };
  if (current === next) return { kind: 'noop', target: path, reason };
  if (next === null) return { kind: 'remove', target: path, reason };
  return { kind: current === null ? 'create' : 'update', target: path, reason };
}

function maybeAddFileUpdate(plan: GlobalPlan, path: string, current: string | null, next: string | null, reason: string): void {
  const action = actionForFile(path, current, next, reason);
  plan.actions.push(action);
  if (action.kind === 'create' || action.kind === 'update' || action.kind === 'remove') {
    plan.fileUpdates.push({ path, content: next, reason });
  }
}

export function parseGlobalArgs(argv: readonly string[]): ParsedGlobalArgs {
  const parsed: ParsedGlobalArgs = {};
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    parsed.help = true;
    return parsed;
  }
  if (subcommand !== 'install' && subcommand !== 'uninstall' && subcommand !== 'status') {
    throw new Error(`Unknown global subcommand: ${subcommand}`);
  }
  parsed.subcommand = subcommand;

  for (let index = 1; index < argv.length; index += 1) {
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
      case '--config':
        parsed.config = readValue();
        break;
      case '--state-dir':
        parsed.stateDir = readValue();
        break;
      case '--mcp-only':
        parsed.mcpOnly = true;
        break;
      case '--shell-hook-only':
        parsed.shellHookOnly = true;
        break;
      case '--shell-hook-shell': {
        const shell = readValue();
        if (shell !== 'auto' && shell !== 'powershell' && shell !== 'bash' && shell !== 'zsh') {
          throw new Error('--shell-hook-shell must be one of: auto, powershell, bash, zsh.');
        }
        if (shell !== 'auto') parsed.shellHookShell = shell;
        break;
      }
      case '--shell-hook-profile':
        parsed.shellHookProfile = readValue();
        break;
      case '--shell-hook-wsl-prefer-linux-path':
        parsed.shellHookWslPreferLinuxPath = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--confirm':
        parsed.confirm = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown global argument: ${rawArg}`);
    }
  }

  if (parsed.mcpOnly === true && parsed.shellHookOnly === true) {
    throw new Error('Choose only one of --mcp-only or --shell-hook-only.');
  }
  if (parsed.mcpOnly === true && parsed.shellHookWslPreferLinuxPath === true) {
    throw new Error('--shell-hook-wsl-prefer-linux-path cannot be used with --mcp-only.');
  }
  return parsed;
}

export function buildGlobalPlan(options: ParsedGlobalArgs = {}): GlobalPlan {
  const subcommand = options.subcommand ?? 'status';
  const dryRun = subcommand === 'status' ? true : options.confirm !== true;
  const configPath = resolvePath(options.config, defaultConfigPath());
  const stateDir = resolvePath(options.stateDir, defaultGlobalStateDir());
  const mcpEnabled = options.shellHookOnly !== true;
  const shellHookEnabled = options.mcpOnly !== true;
  const configCurrent = readTextIfExists(configPath);
  const mcpInstalled = hasManagedGlobalBlock(configCurrent);
  const mcpUnmanagedConflict = !mcpInstalled && hasMcpSection(configCurrent);
  const windowsHiddenLauncherPath = mcpEnabled
    ? prepareWindowsHiddenLauncherForDirectory(stateDir, true)
    : null;

  const plan: GlobalPlan = {
    ok: true,
    subcommand,
    dryRun,
    configPath,
    stateDir,
    mcpEnabled,
    shellHookEnabled,
    mcpInstalled,
    mcpUnmanagedConflict,
    shellHookInstalled: null,
    windowsHiddenLauncherPath,
    actions: [],
    fileUpdates: [],
  };

  if (mcpEnabled) {
    if (subcommand === 'install') {
      maybeAddFileUpdate(
        plan,
        configPath,
        configCurrent,
        upsertGlobalMcpConfig(configCurrent, windowsHiddenLauncherPath),
        'install user-global MCP server',
      );
      if (windowsHiddenLauncherPath !== null) {
        plan.actions.push({
          kind: existsSync(windowsHiddenLauncherPath) ? 'update' : 'create',
          target: windowsHiddenLauncherPath,
          reason: 'prepare Windows hidden MCP stdio launcher',
        });
      }
    } else if (subcommand === 'uninstall') {
      if (mcpUnmanagedConflict) {
        plan.actions.push({
          kind: 'skip',
          target: configPath,
          reason: `unmanaged [mcp_servers.${MCP_SERVER_NAME}] section is not removed`,
        });
      } else {
        maybeAddFileUpdate(
          plan,
          configPath,
          configCurrent,
          removeGlobalMcpConfig(configCurrent),
          'remove user-global MCP server',
        );
      }
    } else {
      plan.actions.push({
        kind: mcpInstalled ? 'noop' : mcpUnmanagedConflict ? 'skip' : 'noop',
        target: configPath,
        reason: mcpInstalled
          ? 'user-global MCP server is installed'
          : mcpUnmanagedConflict
            ? `unmanaged [mcp_servers.${MCP_SERVER_NAME}] section exists`
            : 'user-global MCP server is not installed',
      });
    }
  }

  if (shellHookEnabled) {
    const shellHookInput: Parameters<typeof buildShellHookPlan>[0] = {
      subcommand: subcommand === 'uninstall' ? 'uninstall' : subcommand === 'install' ? 'install' : 'status',
      confirm: !dryRun,
      globalRemoteFallback: true,
    };
    if (options.shellHookShell !== undefined) shellHookInput.shell = options.shellHookShell;
    if (options.shellHookProfile !== undefined) shellHookInput.profile = options.shellHookProfile;
    if (options.shellHookWslPreferLinuxPath === true) shellHookInput.wslPreferLinuxPath = true;
    const shellHookPlan = buildShellHookPlan(shellHookInput);
    plan.shellHookPlan = shellHookPlan;
    plan.shellHookInstalled = shellHookPlan.installed;
    const action = shellHookPlan.actions[0];
    plan.actions.push({
      kind: action?.kind === 'remove' ? 'remove' : action?.kind === 'create' ? 'create' : action?.kind === 'update' ? 'update' : 'noop',
      target: action?.target ?? shellHookPlan.profilePath,
      reason: action?.reason ?? 'manage codex shell function hook',
    });
  }

  return plan;
}

export function applyGlobalPlan(plan: GlobalPlan, deps: GlobalApplyDeps = {}): void {
  if (plan.dryRun || plan.subcommand === 'status') return;

  if (plan.subcommand === 'install' && plan.mcpEnabled && plan.windowsHiddenLauncherPath !== null) {
    const prepare = deps.prepareWindowsHiddenLauncher ?? prepareWindowsHiddenLauncherForDirectory;
    const prepared = prepare(dirname(plan.windowsHiddenLauncherPath), false);
    if (prepared === null || !existsSync(prepared)) {
      throw new Error('Failed to prepare Windows hidden MCP stdio launcher for global install.');
    }
  }

  for (const update of plan.fileUpdates) {
    if (update.content === null) {
      if (existsSync(update.path)) {
        unlinkSync(update.path);
      }
      continue;
    }
    mkdirSync(dirname(update.path), { recursive: true });
    writeFileSync(update.path, update.content, 'utf8');
  }

  if (plan.shellHookPlan !== undefined) {
    const applyShellHook = deps.applyShellHook ?? applyShellHookPlan;
    applyShellHook(plan.shellHookPlan);
  }
}

function formatGlobalPlan(plan: GlobalPlan): string {
  const lines = [
    `codex-agent-session-manager global ${plan.subcommand} ${plan.dryRun ? 'dry-run' : 'applied'}`,
    `config: ${plan.configPath}`,
    `state dir: ${plan.stateDir}`,
    `mcp: ${plan.mcpEnabled ? plan.mcpInstalled ? 'installed' : plan.mcpUnmanagedConflict ? 'unmanaged-conflict' : 'not-installed' : 'skipped'}`,
    `shell-hook: ${plan.shellHookEnabled ? plan.shellHookInstalled === true ? 'installed' : 'not-installed' : 'skipped'}`,
    '',
    'actions:',
  ];
  for (const action of plan.actions) {
    lines.push(`  ${action.kind.padEnd(6, ' ')} ${action.target} - ${action.reason}`);
  }
  if (plan.dryRun && plan.subcommand !== 'status') {
    lines.push('', 'Dry run only; pass --confirm to apply.');
  }
  if (plan.subcommand === 'install' && plan.shellHookEnabled && plan.shellHookPlan !== undefined && !plan.dryRun) {
    lines.push(
      '',
      'Reload this shell before testing the codex function hook:',
      `  ${shellHookActivationCommand(plan.shellHookPlan.shell, plan.shellHookPlan.profilePath)}`,
      'Or open a new shell.',
    );
  }
  return lines.join('\n');
}

export function globalPlanPreview(plan: GlobalPlan, applied: boolean): Record<string, unknown> {
  return {
    ok: plan.ok,
    applied,
    dryRun: plan.dryRun,
    subcommand: plan.subcommand,
    configPath: plan.configPath,
    stateDir: plan.stateDir,
    mcpEnabled: plan.mcpEnabled,
    shellHookEnabled: plan.shellHookEnabled,
    mcpInstalled: plan.mcpInstalled,
    mcpUnmanagedConflict: plan.mcpUnmanagedConflict,
    shellHookInstalled: plan.shellHookInstalled,
    windowsHiddenLauncherPath: plan.windowsHiddenLauncherPath,
    actions: plan.actions,
  };
}

export async function runGlobalCommand(argv: readonly string[], deps: GlobalDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const options = parseGlobalArgs(argv);
  if (options.help === true) {
    output(usage().trimEnd());
    return 0;
  }

  const plan = buildGlobalPlan(options);
  applyGlobalPlan(plan);
  if (!plan.dryRun && plan.subcommand !== 'status') {
    const statusPlan = buildGlobalPlan({ ...options, subcommand: 'status' });
    plan.mcpInstalled = statusPlan.mcpInstalled;
    plan.mcpUnmanagedConflict = statusPlan.mcpUnmanagedConflict;
    plan.shellHookInstalled = statusPlan.shellHookInstalled;
  }
  if (options.json === true) {
    output(JSON.stringify(globalPlanPreview(plan, !plan.dryRun), null, 2));
  } else {
    output(formatGlobalPlan(plan));
  }
  return 0;
}
