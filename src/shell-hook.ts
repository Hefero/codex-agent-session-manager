import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MARKER_START = '# BEGIN codex-agent-session-manager:shell-hook';
const MARKER_END = '# END codex-agent-session-manager:shell-hook';

export interface ParsedShellHookArgs {
  subcommand?: 'install' | 'uninstall' | 'status';
  profile?: string;
  dryRun?: boolean;
  confirm?: boolean;
  help?: boolean;
}

export interface ShellHookPlan {
  ok: true;
  subcommand: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  profilePath: string;
  installed: boolean;
  actions: Array<{ kind: 'create' | 'update' | 'remove' | 'noop'; target: string; reason: string }>;
  nextContent?: string | undefined;
}

export interface ShellHookDeps {
  output?: (text: string) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager shell-hook install [options]
  codex-agent-session-manager shell-hook uninstall [options]
  codex-agent-session-manager shell-hook status [options]

Options:
  --profile <path>   PowerShell profile to edit. Defaults to Windows PowerShell current-user profile.
  --dry-run          Preview only. This is the default unless --confirm is passed.
  --confirm          Apply install/uninstall changes.
  --help             Show this help.
`;
}

export function shellHookUsage(): string {
  return usage();
}

function defaultProfilePath(): string {
  return join(homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
}

function resolveProfilePath(profile: string | undefined): string {
  const selected = profile ?? defaultProfilePath();
  return isAbsolute(selected) ? resolve(selected) : resolve(process.cwd(), selected);
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
  return ensureTrailingNewline([before, block, after].filter((part): part is string => Boolean(part && part.length > 0)).join('\n\n'));
}

function appendBlock(content: string | null, block: string): string {
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);
  return ensureTrailingNewline(`${content.trimEnd()}\n\n${block}`);
}

function hookBlock(): string {
  return `${MARKER_START}
function global:codex {
  [CmdletBinding(PositionalBinding = $false)]
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]] $CodexArgs
  )

  $current = (Get-Item -LiteralPath (Get-Location)).FullName
  while ($true) {
    $hook = Join-Path $current '.codex-agent-session-manager\\shell\\codex.ps1'
    if (Test-Path -LiteralPath $hook) {
      & $hook @CodexArgs
      return
    }

    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
      break
    }
    $current = $parent
  }

  foreach ($name in @('codex.cmd', 'codex.exe', 'codex')) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      & $command.Source @CodexArgs
      return
    }
  }

  throw 'Could not find the real Codex CLI application on PATH.'
}
${MARKER_END}`;
}

function parseShellHookArgs(argv: readonly string[]): ParsedShellHookArgs {
  const parsed: ParsedShellHookArgs = {};
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    parsed.help = true;
    return parsed;
  }
  if (subcommand !== 'install' && subcommand !== 'uninstall' && subcommand !== 'status') {
    throw new Error(`Unknown shell-hook subcommand: ${subcommand}`);
  }
  parsed.subcommand = subcommand;

  for (let index = 1; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    const [name, inlineValue] = raw.startsWith('--') && raw.includes('=')
      ? raw.split(/=(.*)/su, 2)
      : [raw, undefined];
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

    if (name === '--profile') {
      parsed.profile = readValue();
    } else if (name === '--dry-run') {
      parsed.dryRun = true;
    } else if (name === '--confirm') {
      parsed.confirm = true;
    } else if (name === '--help' || name === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown shell-hook argument: ${raw}`);
    }
  }

  return parsed;
}

export function buildShellHookPlan(parsed: ParsedShellHookArgs): ShellHookPlan {
  const subcommand = parsed.subcommand ?? 'status';
  const profilePath = resolveProfilePath(parsed.profile);
  const current = readTextIfExists(profilePath);
  const installed = current !== null && findMarkerLine(current, MARKER_START) >= 0;
  const dryRun = subcommand === 'status' ? true : parsed.confirm !== true;

  if (subcommand === 'status') {
    return {
      ok: true,
      subcommand,
      dryRun,
      profilePath,
      installed,
      actions: [{ kind: 'noop', target: profilePath, reason: installed ? 'shell hook is installed' : 'shell hook is not installed' }],
    };
  }

  if (subcommand === 'install') {
    const block = hookBlock();
    const replaced = current === null ? null : replaceMarkedBlock(current, block);
    const nextContent = replaced ?? appendBlock(current, block);
    return {
      ok: true,
      subcommand,
      dryRun,
      profilePath,
      installed,
      actions: [{
        kind: current === null ? 'create' : installed ? 'update' : 'update',
        target: profilePath,
        reason: installed ? 'refresh PowerShell codex function hook' : 'install PowerShell codex function hook',
      }],
      nextContent,
    };
  }

  const nextContent = current === null ? '' : (replaceMarkedBlock(current, null) ?? current);
  return {
    ok: true,
    subcommand,
    dryRun,
    profilePath,
    installed,
    actions: [{
      kind: installed ? 'remove' : 'noop',
      target: profilePath,
      reason: installed ? 'remove PowerShell codex function hook' : 'shell hook is not installed',
    }],
    nextContent,
  };
}

export function applyShellHookPlan(plan: ShellHookPlan): void {
  if (plan.subcommand === 'status' || plan.dryRun) return;
  if (plan.nextContent === undefined) return;
  mkdirSync(dirname(plan.profilePath), { recursive: true });
  writeFileSync(plan.profilePath, plan.nextContent, 'utf8');
}

function formatPlan(plan: ShellHookPlan): string {
  const lines = [
    `codex-agent-session-manager shell-hook ${plan.subcommand} ${plan.dryRun ? 'dry-run' : 'applied'}`,
    `profile: ${plan.profilePath}`,
    `installed: ${plan.installed}`,
    '',
    'actions:',
  ];
  for (const action of plan.actions) {
    lines.push(`  ${action.kind.padEnd(6, ' ')} ${action.target} - ${action.reason}`);
  }
  if (plan.subcommand === 'install') {
    lines.push('', 'Restart PowerShell or dot-source the profile before testing the codex function hook.');
  }
  if (plan.dryRun && plan.subcommand !== 'status') {
    lines.push('', 'Dry run only; pass --confirm to apply.');
  }
  return lines.join('\n');
}

export async function runShellHookCommand(argv: readonly string[], deps: ShellHookDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const parsed = parseShellHookArgs(argv);
  if (parsed.help === true) {
    output(usage().trimEnd());
    return 0;
  }
  const plan = buildShellHookPlan(parsed);
  applyShellHookPlan(plan);
  output(formatPlan(plan));
  return 0;
}
