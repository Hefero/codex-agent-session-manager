import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MARKER_START = '# BEGIN codex-agent-session-manager:shell-hook';
const MARKER_END = '# END codex-agent-session-manager:shell-hook';
type ShellHookShell = 'powershell' | 'bash' | 'zsh';

export interface ParsedShellHookArgs {
  subcommand?: 'install' | 'uninstall' | 'status';
  profile?: string;
  shell?: ShellHookShell;
  globalRemoteFallback?: boolean;
  wslPreferLinuxPath?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  help?: boolean;
}

export interface ShellHookPlan {
  ok: true;
  subcommand: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  shell: ShellHookShell;
  profilePath: string;
  installed: boolean;
  globalRemoteFallback: boolean;
  wslPreferLinuxPath: boolean;
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
  --shell <name>     Shell hook type: powershell, bash, zsh, or auto. Defaults to auto.
  --profile <path>   Shell profile to edit. Defaults to the detected shell profile.
  --global-remote-fallback
                     When no initialized project supervisor exists, route plain
                     codex launches through codex-agent-session-manager remote.
  --wsl-prefer-linux-path
                     POSIX-only opt-in. In WSL, prefer Linux npm binaries and
                     refuse /mnt/c Windows shims for codex-agent-session-manager.
  --dry-run          Preview only. This is the default unless --confirm is passed.
  --confirm          Apply install/uninstall changes.
  --help             Show this help.
`;
}

export function shellHookUsage(): string {
  return usage();
}

function inferShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ShellHookShell {
  if (platform === 'win32') return 'powershell';
  const shellName = basename(env.SHELL ?? '').toLowerCase();
  if (shellName === 'zsh') return 'zsh';
  if (shellName === 'bash') return 'bash';
  return platform === 'darwin' ? 'zsh' : 'bash';
}

function defaultPowerShellProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const userPowerShellModules = join(homedir(), 'Documents', 'PowerShell', 'Modules').toLowerCase();
  const modulePaths = (env.PSModulePath ?? '').split(';').map((entry) => entry.toLowerCase());
  const appearsToRunPowerShellCore = modulePaths.includes(userPowerShellModules)
    || /\bpowershell_[0-9]/iu.test(env.PSHOME ?? '');
  return appearsToRunPowerShellCore
    ? join(homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    : join(homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
}

function defaultProfilePath(shell: ShellHookShell, platform = process.platform): string {
  if (shell === 'powershell') return defaultPowerShellProfilePath();
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  return platform === 'darwin' ? join(homedir(), '.bash_profile') : join(homedir(), '.bashrc');
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function shellHookActivationCommand(shell: ShellHookShell, profilePath: string): string {
  if (shell === 'powershell') return `. ${quotePowerShell(profilePath)}`;
  return `source ${quotePosix(profilePath)}`;
}

function resolveProfilePath(profile: string | undefined, shell: ShellHookShell): string {
  const selected = profile ?? defaultProfilePath(shell);
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
    const before = index === 0 || content[index - 1] === '\n' || (index === 1 && content.charCodeAt(0) === 0xFEFF);
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

function powershellGlobalRemoteFallbackBlock(): string {
  return `
  function Resolve-CodexAgentSessionManagerCli {
    foreach ($name in @('codex-agent-session-manager.cmd', 'codex-agent-session-manager.exe', 'codex-agent-session-manager')) {
      $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $command) {
        return $command.Source
      }
    }
    throw 'Could not find codex-agent-session-manager on PATH.'
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
    param([object[]] $InputArgs, [string] $Workspace)

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

    $remoteArgs = @('--workspace', $Workspace) + @($managerArgs)
    if ($codexArgs.Count -eq 0) {
      return $remoteArgs
    }
    return @($remoteArgs + @('--') + $codexArgs)
  }

  $workspace = (Get-Item -LiteralPath (Get-Location)).FullName
  if (Should-DelegateToRealCodex $CodexArgs) {
    $realCodex = Resolve-CodexRealCli
    & $realCodex @CodexArgs
    return
  }

  $managerCli = Resolve-CodexAgentSessionManagerCli
  $remoteArgs = Convert-CodexArgsToManagedRemoteArgs $CodexArgs $workspace
  $invokeArgs = @('remote') + @($remoteArgs)
  & $managerCli @invokeArgs
  return`;
}

function powershellHookBlock(globalRemoteFallback: boolean): string {
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

${globalRemoteFallback ? powershellGlobalRemoteFallbackBlock() : ''}

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

function posixWslPathPreferenceBlock(enabled: boolean): string {
  if (!enabled) return '';
  return `
codex_asm_prefer_wsl_linux_path() {
  if [ -z "\${WSL_DISTRO_NAME:-}" ] && ! grep -qi microsoft /proc/version 2>/dev/null; then
    return 0
  fi

  local dir
  for dir in "$HOME"/.nvm/versions/node/*/bin "$HOME/.local/bin" "/usr/local/bin" "/usr/bin"; do
    if [ -d "$dir" ]; then
      case ":$PATH:" in
        *":$dir:"*) ;;
        *) PATH="$dir:$PATH" ;;
      esac
    fi
  done
  export PATH
  hash -r 2>/dev/null || true
}

codex_asm_prefer_wsl_linux_path

`;
}

function posixManagerResolutionBlock(wslPreferLinuxPath: boolean): string {
  if (!wslPreferLinuxPath) {
    return `
  codex_asm_find_manager() {
    command -v codex-agent-session-manager
  }
`;
  }

  return `
  codex_asm_is_windows_path() {
    case "$1" in
      /mnt/[A-Za-z]/*) return 0 ;;
      *) return 1 ;;
    esac
  }

  codex_asm_find_manager() {
    local candidate resolved
    if [ -n "\${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
      for candidate in "$HOME"/.nvm/versions/node/*/bin/codex-agent-session-manager "$HOME/.local/bin/codex-agent-session-manager" "/usr/local/bin/codex-agent-session-manager" "/usr/bin/codex-agent-session-manager"; do
        if [ -x "$candidate" ]; then
          printf '%s\\n' "$candidate"
          return 0
        fi
      done
    fi

    resolved="$(command -v codex-agent-session-manager 2>/dev/null || true)"
    if [ -n "$resolved" ] && ! codex_asm_is_windows_path "$resolved"; then
      printf '%s\\n' "$resolved"
      return 0
    fi

    if [ -n "$resolved" ]; then
      printf '%s\\n' "codex-agent-session-manager resolves to a Windows shim under /mnt/c. Install it inside WSL or run init with a Linux package spec before using the global shell hook." >&2
    else
      printf '%s\\n' "Could not find a Linux codex-agent-session-manager binary on PATH." >&2
    fi
    return 127
  }
`;
}

function posixGlobalRemoteFallbackBlock(wslPreferLinuxPath: boolean): string {
  return `
  codex_asm_should_delegate() {
    if [ "$#" -eq 0 ]; then
      return 1
    fi
    case "$1" in
      --help|-h|--version|-V|help|version) return 0 ;;
    esac

    case "$1" in
      -*) return 1 ;;
    esac
    if [ "$1" = "resume" ]; then
      return 1
    fi
    case "$1" in
      exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|unarchive|fork|cloud|exec-server|features) return 0 ;;
      *) return 1 ;;
    esac
  }

${posixManagerResolutionBlock(wslPreferLinuxPath)}

  codex_asm_remote() {
    local workspace manager
    workspace="\${PWD:-$(pwd)}"
    manager="$(codex_asm_find_manager)" || return $?
    local manager_flags codex_args arg
    manager_flags=()
    codex_args=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --no-bypass-sandbox|--enable-image-generation|--no-resume|--dry-run|--resume-last|--pick)
          manager_flags+=("$1")
          shift
          ;;
        *)
          codex_args+=("$1")
          shift
          ;;
      esac
    done

    if [ "\${#codex_args[@]}" -eq 0 ]; then
      command "$manager" remote --workspace "$workspace" "\${manager_flags[@]}"
      return $?
    fi
    command "$manager" remote --workspace "$workspace" "\${manager_flags[@]}" -- "\${codex_args[@]}"
  }

  if codex_asm_should_delegate "$@"; then
    command codex "$@"
    return $?
  fi

  codex_asm_remote "$@"
  return $?`;
}

function posixHookBlock(globalRemoteFallback: boolean, wslPreferLinuxPath: boolean): string {
  return `${MARKER_START}
${posixWslPathPreferenceBlock(wslPreferLinuxPath)}codex() {
  local current hook parent
  current="\${PWD:-$(pwd)}"
  while [ -n "$current" ]; do
    hook="$current/.codex-agent-session-manager/shell/codex.mjs"
    if [ -f "$hook" ]; then
      node "$hook" "$@"
      return $?
    fi

    parent="$(dirname "$current")"
    if [ -z "$parent" ] || [ "$parent" = "$current" ]; then
      break
    fi
    current="$parent"
  done

${globalRemoteFallback ? posixGlobalRemoteFallbackBlock(wslPreferLinuxPath) : '  command codex "$@"'}
${globalRemoteFallback ? '' : ''}
}
${MARKER_END}`;
}

function hookBlock(shell: ShellHookShell, globalRemoteFallback: boolean, wslPreferLinuxPath: boolean): string {
  return shell === 'powershell' ? powershellHookBlock(globalRemoteFallback) : posixHookBlock(globalRemoteFallback, wslPreferLinuxPath);
}

function shellLabel(shell: ShellHookShell): string {
  return shell === 'powershell' ? 'PowerShell' : shell;
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
    } else if (name === '--shell') {
      const shell = readValue();
      if (shell === 'auto') {
        delete parsed.shell;
      } else if (shell === 'powershell' || shell === 'bash' || shell === 'zsh') {
        parsed.shell = shell;
      } else {
        throw new Error('--shell must be one of: auto, powershell, bash, zsh.');
      }
    } else if (name === '--dry-run') {
      parsed.dryRun = true;
    } else if (name === '--confirm') {
      parsed.confirm = true;
    } else if (name === '--global-remote-fallback') {
      parsed.globalRemoteFallback = true;
    } else if (name === '--wsl-prefer-linux-path') {
      parsed.wslPreferLinuxPath = true;
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
  const shell = parsed.shell ?? inferShell();
  const profilePath = resolveProfilePath(parsed.profile, shell);
  const current = readTextIfExists(profilePath);
  const installed = current !== null && findMarkerLine(current, MARKER_START) >= 0;
  const dryRun = subcommand === 'status' ? true : parsed.confirm !== true;
  const globalRemoteFallback = parsed.globalRemoteFallback === true;
  const wslPreferLinuxPath = parsed.wslPreferLinuxPath === true && shell !== 'powershell';

  if (subcommand === 'status') {
    return {
      ok: true,
      subcommand,
      dryRun,
      shell,
      profilePath,
      installed,
      globalRemoteFallback,
      wslPreferLinuxPath,
      actions: [{ kind: 'noop', target: profilePath, reason: installed ? 'shell hook is installed' : 'shell hook is not installed' }],
    };
  }

  if (subcommand === 'install') {
    const block = hookBlock(shell, globalRemoteFallback, wslPreferLinuxPath);
    const replaced = current === null ? null : replaceMarkedBlock(current, block);
    const nextContent = replaced ?? appendBlock(current, block);
    return {
      ok: true,
      subcommand,
      dryRun,
      shell,
      profilePath,
      installed,
      globalRemoteFallback,
      wslPreferLinuxPath,
      actions: [{
        kind: current === null ? 'create' : installed ? 'update' : 'update',
        target: profilePath,
        reason: installed ? `refresh ${shellLabel(shell)} codex function hook` : `install ${shellLabel(shell)} codex function hook`,
      }],
      nextContent,
    };
  }

  const nextContent = current === null ? '' : (replaceMarkedBlock(current, null) ?? current);
  return {
    ok: true,
    subcommand,
    dryRun,
    shell,
    profilePath,
    installed,
    globalRemoteFallback,
    wslPreferLinuxPath,
    actions: [{
      kind: installed ? 'remove' : 'noop',
      target: profilePath,
      reason: installed ? `remove ${shellLabel(shell)} codex function hook` : 'shell hook is not installed',
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
    `shell: ${plan.shell}`,
    `profile: ${plan.profilePath}`,
    `installed: ${plan.installed}`,
    `wsl prefer linux path: ${plan.wslPreferLinuxPath}`,
    '',
    'actions:',
  ];
  for (const action of plan.actions) {
    lines.push(`  ${action.kind.padEnd(6, ' ')} ${action.target} - ${action.reason}`);
  }
  if (plan.subcommand === 'install' && !plan.dryRun) {
    lines.push(
      '',
      'Reload this shell before testing the codex function hook:',
      `  ${shellHookActivationCommand(plan.shell, plan.profilePath)}`,
      'Or open a new shell.',
    );
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
