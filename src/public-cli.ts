import { readFileSync, statSync } from 'node:fs';

import { buildAppServerStatusPayload, buildAppServerStopPayload } from './tools/app-server-lifecycle.js';
import { buildAppServerStartPayload } from './tools/app-server-start.js';
import { buildGlobalMcpAddNpmPayload, buildGlobalMcpRemovePayload } from './tools/global-mcp-npm.js';
import { buildLocalMcpAddNpmPayload } from './tools/mcp-add-npm.js';
import { buildMcpCleanupReportPayload } from './tools/mcp-report.js';
import { buildMcpRefreshPayload } from './tools/mcp-refresh.js';
import { buildMcpInstallNpmPayload } from './tools/mcp-install-npm.js';
import { buildLocalMcpRemovePayload } from './tools/mcp-remove.js';
import { buildNpmPackageInspectPayload, inspectNpmPackageForMcp } from './tools/npm-package-inspect.js';
import { buildOperationReadPayload, buildOperationWaitPayload, OperationStore } from './tools/operations.js';
import { buildSessionClosePayload } from './tools/session-close.js';
import { buildSessionLaunchPayload } from './tools/session-launch.js';
import { buildSessionReplacePayload } from './tools/session-replace.js';
import { workspacePath } from './security/workspace.js';
import { userError } from './errors.js';

const MAX_PROMPT_CHARS = 4_000;
const MAX_PROMPT_FILE_BYTES = 16_384;

const booleanFlags = new Set([
  'allow-scripts',
  'allow-no-env-vars',
  'allow-workspace-url-fallback',
  'bypass-sandbox',
  'confirm',
  'dry-run',
  'enable-image-generation',
  'force',
  'help',
  'json',
  'no-default-stdio-arg',
  'no-global',
  'no-operations',
  'no-process-tree',
  'no-probe-ready',
  'pick',
  'probe-ready',
  'resume-last',
  'uninstall-package',
]);

export interface ParsedPublicCommand {
  command: string;
  subcommand: string;
  input: Record<string, unknown>;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  passthrough: string[];
}

export interface PublicCliDeps {
  output?: (text: string) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager app-server start [options]
  codex-agent-session-manager app-server status [options]
  codex-agent-session-manager app-server stop [options]
  codex-agent-session-manager stop [options]
  codex-agent-session-manager mcp local add npm <package-spec> [options]
  codex-agent-session-manager mcp local remove <server-name> [options]
  codex-agent-session-manager mcp global add npm <package-spec> [options]
  codex-agent-session-manager mcp global remove <server-name> [options]
  codex-agent-session-manager mcp install npm <package-spec> [options]
  codex-agent-session-manager mcp inspect npm <package-spec>
  codex-agent-session-manager mcp report [options]
  codex-agent-session-manager mcp refresh --thread-id <thread-id> [options]
  codex-agent-session-manager operation read --operation-id <operation-id>
  codex-agent-session-manager operation wait --operation-id <operation-id> [options]
  codex-agent-session-manager session launch [options]
  codex-agent-session-manager session close --thread-id <thread-id> [options]
  codex-agent-session-manager session replace --thread-id <thread-id> [options]

Common options:
  --url <ws-url>                    Loopback App Server websocket URL.
  --thread-id <id>                  Target Codex thread id.
  --prompt <text>                   Non-secret prompt text.
  --prompt-file <path>              Read prompt text from a workspace file.
  --dry-run                         Preview only.
  --confirm                         Execute a command that defaults to dry-run.
  --timeout-ms <ms>                 Request or operation timeout.

App Server:
  start:  --host <host> --port <port|auto> --enable-image-generation
          -- <native codex app-server args except --listen/--stdio>
  status: --no-probe-ready --no-process-tree --ready-timeout-ms <ms>
  stop:   --url <ws-url> --force --delay-ms <ms>
          top-level "stop" is an alias for "app-server stop"

MCP:
  local add npm:  --server-name <name> --entrypoint <package-relative-js>
                  --arg <value> --no-default-stdio-arg --env-var <name>
                  --dry-run --confirm --allow-scripts --allow-no-env-vars
  local remove:   --uninstall-package --dry-run --confirm
  global add npm: --server-name <name> --entrypoint <package-relative-js>
                  --arg <value> --no-default-stdio-arg --env-var <name>
                  --config <path> --state-dir <path>
                  --dry-run --confirm --allow-scripts --allow-no-env-vars
  global remove:  --uninstall-package --config <path> --state-dir <path>
                  --dry-run --confirm
  install npm:    --scope <local|global> --server-name <name>
                  --entrypoint <package-relative-js> --arg <value>
                  --no-default-stdio-arg --env-var <name>
                  --config <path> --state-dir <path>
                  --dry-run --confirm --allow-scripts --allow-no-env-vars
  report:         --no-global --no-operations
                  --global-config <path> --global-state-dir <path>
  refresh: --highlight-tool <name> --continuation-timeout-ms <ms>
           --continuation-poll-ms <ms> --continuation-stable-ms <ms>

Operation:
  read:    --operation-id <operation-id>
  wait:    --operation-id <operation-id> --timeout-ms <ms> --poll-ms <ms>

Session:
  launch:  --mode <fresh|session|last|pick> --resume-last --pick
           --bypass-sandbox --enable-image-generation
  close:   --delay-ms <ms> --allow-workspace-url-fallback
  replace: --prompt <text> --bypass-sandbox --enable-image-generation
           --delay-ms <ms>
`;
}

function helpExample(commandLabel: string): string {
  return `codex-agent-session-manager ${commandLabel} --help`;
}

function allowedFlagList(allowed: readonly string[]): string {
  return [...allowed, 'help'].map((name) => `--${name}`).join(', ');
}

function failCli(input: {
  code: string;
  message: string;
  command?: string;
  parameter?: string;
  received?: unknown;
  expected?: string;
  examples?: readonly string[];
  suggestions?: ReadonlyArray<{ label?: string; command?: string; details?: string }>;
  nextAction?: string;
}): never {
  throw userError(input);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let passthrough: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    if (raw === '--') {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (name.length === 0) {
      failCli({
        code: 'empty_option_name',
        message: 'Empty option name.',
        parameter: '--',
        expected: 'A complete option name such as --dry-run or --thread-id.',
        examples: ['codex-agent-session-manager --help'],
        nextAction: 'Remove the empty -- argument or replace it with a supported option.',
      });
    }

    let value: string;
    if (equalsIndex >= 0) {
      value = withoutPrefix.slice(equalsIndex + 1);
    } else if (booleanFlags.has(name)) {
      value = 'true';
    } else {
      const next = argv[index + 1];
      if (next === undefined) {
        failCli({
          code: 'missing_option_value',
          message: `Missing value for --${name}.`,
          parameter: `--${name}`,
          expected: `A value immediately after --${name}.`,
          examples: [`codex-agent-session-manager <command> --${name} <value>`],
          nextAction: `Add the missing value after --${name}, or run the command with --help to inspect the expected options.`,
        });
      }
      value = next;
      index += 1;
    }

    flags.set(name, [...(flags.get(name) ?? []), value]);
  }

  return { positionals, flags, passthrough };
}

function hasFlag(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function stringFlag(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values?.at(-1);
}

function stringListFlag(flags: Map<string, string[]>, name: string): string[] | undefined {
  const values = flags.get(name);
  return values && values.length > 0 ? values : undefined;
}

function numberFlag(flags: Map<string, string[]>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    failCli({
      code: 'invalid_number_option',
      message: `--${name} must be a number.`,
      parameter: `--${name}`,
      received: value,
      expected: 'A finite numeric value in milliseconds.',
      examples: [`codex-agent-session-manager <command> --${name} 10000`],
      nextAction: `Replace --${name} with a numeric value.`,
    });
  }
  return parsed;
}

function assertAllowedFlags(flags: Map<string, string[]>, allowed: readonly string[], commandLabel: string): void {
  const allowedSet = new Set([...allowed, 'help']);
  for (const name of flags.keys()) {
    if (!allowedSet.has(name)) {
      failCli({
        code: 'unknown_option',
        message: `Unknown option for ${commandLabel}: --${name}`,
        command: commandLabel,
        parameter: `--${name}`,
        received: `--${name}`,
        expected: `One of: ${allowedFlagList(allowed)}`,
        examples: [helpExample(commandLabel)],
        nextAction: `Remove --${name} or replace it with a supported option for ${commandLabel}.`,
      });
    }
  }
}

function assertNoExtraPositionals(rest: readonly string[], commandLabel: string): void {
  if (rest.length > 0) {
    failCli({
      code: 'unexpected_argument',
      message: `Unexpected argument for ${commandLabel}: ${rest[0] ?? '<missing>'}`,
      command: commandLabel,
      parameter: 'positional',
      received: rest[0] ?? '<missing>',
      expected: 'No additional positional arguments.',
      examples: [helpExample(commandLabel)],
      nextAction: `Remove the extra argument or run ${helpExample(commandLabel)}.`,
    });
  }
}

function assertNoPassthrough(passthrough: readonly string[], commandLabel: string): void {
  if (passthrough.length > 0) {
    failCli({
      code: 'unexpected_passthrough_argument',
      message: `Unexpected native passthrough argument for ${commandLabel}: ${passthrough[0] ?? '<missing>'}`,
      command: commandLabel,
      parameter: '--',
      received: passthrough[0] ?? '<missing>',
      expected: 'This command does not accept native passthrough arguments after --.',
      examples: [helpExample(commandLabel)],
      nextAction: 'Remove the passthrough arguments. Only app-server start accepts native Codex App Server arguments after --.',
    });
  }
}

function optionalPrompt(flags: Map<string, string[]>): string | undefined {
  const prompt = stringFlag(flags, 'prompt');
  const promptFile = stringFlag(flags, 'prompt-file');
  if (prompt !== undefined && promptFile !== undefined) {
    failCli({
      code: 'conflicting_prompt_options',
      message: 'Use only one of --prompt or --prompt-file.',
      parameter: '--prompt',
      expected: 'Exactly one prompt source.',
      examples: [
        'codex-agent-session-manager session replace --thread-id <thread-id> --prompt "continue"',
        'codex-agent-session-manager session replace --thread-id <thread-id> --prompt-file prompt.txt',
      ],
      nextAction: 'Choose either inline prompt text or a workspace-local prompt file, not both.',
    });
  }
  if (prompt !== undefined) return checkedPromptText(prompt, '--prompt');
  if (promptFile !== undefined) {
    const resolvedPromptFile = workspacePath(process.cwd(), promptFile);
    const stat = statSync(resolvedPromptFile);
    if (!stat.isFile()) {
      failCli({
        code: 'invalid_prompt_file',
        message: '--prompt-file must point to a file.',
        parameter: '--prompt-file',
        received: promptFile,
        expected: 'A regular file inside the current workspace.',
        examples: ['codex-agent-session-manager session replace --thread-id <thread-id> --prompt-file prompt.txt'],
        nextAction: 'Pass a workspace-relative file path. Directories, missing files, and paths outside the workspace are rejected.',
      });
    }
    if (stat.size > MAX_PROMPT_FILE_BYTES) {
      failCli({
        code: 'prompt_file_too_large',
        message: `--prompt-file must be at most ${MAX_PROMPT_FILE_BYTES} bytes.`,
        parameter: '--prompt-file',
        received: `${stat.size} bytes`,
        expected: `At most ${MAX_PROMPT_FILE_BYTES} bytes.`,
        nextAction: 'Shorten the prompt file or pass a concise --prompt value.',
      });
    }
    return checkedPromptText(readFileSync(resolvedPromptFile, 'utf8'), '--prompt-file');
  }
  return undefined;
}

function checkedPromptText(prompt: string, source: string): string {
  if (prompt.length > MAX_PROMPT_CHARS) {
    failCli({
      code: 'prompt_too_long',
      message: `${source} must be at most ${MAX_PROMPT_CHARS} characters.`,
      parameter: source,
      received: `${prompt.length} characters`,
      expected: `At most ${MAX_PROMPT_CHARS} characters.`,
      nextAction: 'Shorten the continuation prompt. Keep prompts non-secret and focused on the validation step.',
    });
  }
  return prompt;
}

function addOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function addDryRunConfirm(target: Record<string, unknown>, flags: Map<string, string[]>): void {
  const confirm = hasFlag(flags, 'confirm');
  const explicitDryRun = hasFlag(flags, 'dry-run');
  if (confirm) {
    target.confirm = true;
    target.dryRun = explicitDryRun ? true : false;
    return;
  }
  if (explicitDryRun) {
    target.dryRun = true;
  }
}

function requireString(flags: Map<string, string[]>, name: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined || value.length === 0) {
    failCli({
      code: 'missing_required_option',
      message: `--${name} is required.`,
      parameter: `--${name}`,
      expected: `A non-empty value for --${name}.`,
      examples: [`codex-agent-session-manager <command> --${name} <value>`],
      nextAction: `Pass --${name} explicitly. Use codex_threads_list or codex_thread_context when the missing value is a thread id.`,
    });
  }
  return value;
}

function appServerCommand(
  subcommand: string,
  flags: Map<string, string[]>,
  rest: readonly string[],
  passthrough: readonly string[] = [],
  options: { topLevelStopAlias?: boolean } = {},
): ParsedPublicCommand {
  if (subcommand === 'start') {
    assertNoExtraPositionals(rest, 'app-server start');
    assertAllowedFlags(flags, ['url', 'host', 'port', 'enable-image-generation', 'dry-run', 'confirm'], 'app-server start');
    const input: Record<string, unknown> = {};
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    addOptional(input, 'host', stringFlag(flags, 'host'));
    addOptional(input, 'port', stringFlag(flags, 'port'));
    if (passthrough.length > 0) input.appServerArgs = [...passthrough];
    if (hasFlag(flags, 'enable-image-generation')) input.enableImageGeneration = true;
    addDryRunConfirm(input, flags);
    return { command: 'app-server', subcommand, input };
  }

  if (subcommand === 'status') {
    assertNoExtraPositionals(rest, 'app-server status');
    assertNoPassthrough(passthrough, 'app-server status');
    assertAllowedFlags(flags, ['probe-ready', 'no-probe-ready', 'no-process-tree', 'ready-timeout-ms'], 'app-server status');
    const input: Record<string, unknown> = {};
    if (hasFlag(flags, 'probe-ready')) input.probeReady = true;
    if (hasFlag(flags, 'no-probe-ready')) input.probeReady = false;
    if (hasFlag(flags, 'no-process-tree')) input.includeProcessTree = false;
    addOptional(input, 'readyTimeoutMs', numberFlag(flags, 'ready-timeout-ms'));
    return { command: 'app-server', subcommand, input };
  }

  if (subcommand === 'stop') {
    assertNoExtraPositionals(rest, 'app-server stop');
    assertNoPassthrough(passthrough, 'app-server stop');
    assertAllowedFlags(flags, ['url', 'force', 'dry-run', 'confirm', 'timeout-ms', 'delay-ms'], 'app-server stop');
    const input: Record<string, unknown> = {};
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    if (hasFlag(flags, 'force')) {
      input.force = true;
      if (options.topLevelStopAlias === true && stringFlag(flags, 'url') === undefined) {
        input.useStateUrl = true;
      }
    }
    addDryRunConfirm(input, flags);
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'delayMs', numberFlag(flags, 'delay-ms'));
    return { command: 'app-server', subcommand, input };
  }

  failCli({
    code: 'unknown_subcommand',
    message: `Unknown app-server subcommand: ${subcommand}`,
    command: 'app-server',
    parameter: 'subcommand',
    received: subcommand,
    expected: 'One of: start, status, stop.',
    examples: ['codex-agent-session-manager app-server --help'],
    nextAction: 'Choose a supported app-server subcommand.',
  });
}

function mcpNpmAddInput(flags: Map<string, string[]>, packageSpec: string): Record<string, unknown> {
  const input: Record<string, unknown> = { packageSpec };
  addOptional(input, 'serverName', stringFlag(flags, 'server-name'));
  addOptional(input, 'entrypoint', stringFlag(flags, 'entrypoint'));
  if (hasFlag(flags, 'no-default-stdio-arg') && hasFlag(flags, 'arg')) {
    failCli({
      code: 'conflicting_mcp_args',
      message: 'Use either --arg or --no-default-stdio-arg, not both.',
      parameter: '--arg',
      expected: 'Either custom extra args, or an explicitly empty args list.',
      examples: [
        'codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --arg stdio --dry-run',
        'codex-agent-session-manager mcp local add npm example-mcp --no-default-stdio-arg --dry-run',
      ],
      nextAction: 'Remove one of the conflicting argument options.',
    });
  }
  addOptional(input, 'extraArgs', hasFlag(flags, 'no-default-stdio-arg') ? [] : stringListFlag(flags, 'arg'));
  addOptional(input, 'envVars', stringListFlag(flags, 'env-var'));
  if (hasFlag(flags, 'allow-scripts')) input.allowScripts = true;
  if (hasFlag(flags, 'allow-no-env-vars')) input.allowNoEnvVars = true;
  addDryRunConfirm(input, flags);
  return input;
}

function localMcpCommand(action: string | undefined, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (action === 'add') {
    assertAllowedFlags(flags, ['server-name', 'entrypoint', 'arg', 'no-default-stdio-arg', 'env-var', 'allow-scripts', 'allow-no-env-vars', 'dry-run', 'confirm'], 'mcp local add npm');
    const [provider, packageSpec, extra] = rest;
    if (provider !== 'npm') {
      failCli({
        code: 'unknown_mcp_provider',
        message: `Unknown mcp local add provider: ${provider ?? '<missing>'}`,
        command: 'mcp local add',
        parameter: 'provider',
        received: provider ?? '<missing>',
        expected: 'npm',
        examples: ['codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --dry-run'],
        nextAction: 'Use the npm provider. Filesystem paths and tarballs are not accepted by this MCP add command.',
      });
    }
    if (packageSpec === undefined || packageSpec.length === 0) {
      failCli({
        code: 'missing_package_spec',
        message: 'mcp local add npm requires a package spec.',
        command: 'mcp local add npm',
        parameter: 'package-spec',
        expected: 'An npm registry package spec, such as @scope/name, name, or name@version.',
        examples: ['codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --dry-run'],
        nextAction: 'Add the npm package spec immediately after npm.',
      });
    }
    if (extra !== undefined) {
      failCli({
        code: 'unexpected_argument',
        message: `Unexpected argument for mcp local add npm: ${extra}`,
        command: 'mcp local add npm',
        parameter: 'positional',
        received: extra,
        expected: 'Only one npm package spec positional argument.',
        examples: ['codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --server-name everything --dry-run'],
        nextAction: 'Move additional runtime args behind repeated --arg flags, or remove the extra positional argument.',
      });
    }
    return { command: 'mcp', subcommand: 'local-add-npm', input: mcpNpmAddInput(flags, packageSpec) };
  }

  if (action === 'remove') {
    assertAllowedFlags(flags, ['uninstall-package', 'dry-run', 'confirm'], 'mcp local remove');
    const [serverName, extra] = rest;
    if (serverName === undefined || serverName.length === 0) {
      failCli({
        code: 'missing_server_name',
        message: 'mcp local remove requires a server name.',
        command: 'mcp local remove',
        parameter: 'server-name',
        expected: 'The exact managed project-local MCP server name from codex_mcp_cleanup_report.',
        examples: ['codex-agent-session-manager mcp report --no-global', 'codex-agent-session-manager mcp local remove everything --dry-run'],
        nextAction: 'Run mcp report to find managed local server names, then retry with the exact server name.',
      });
    }
    if (extra !== undefined) {
      failCli({
        code: 'unexpected_argument',
        message: `Unexpected argument for mcp local remove: ${extra}`,
        command: 'mcp local remove',
        parameter: 'positional',
        received: extra,
        expected: 'Only one server-name positional argument.',
        examples: ['codex-agent-session-manager mcp local remove everything --dry-run'],
        nextAction: 'Remove the extra argument.',
      });
    }
    const input: Record<string, unknown> = { serverName };
    if (hasFlag(flags, 'uninstall-package')) input.uninstallPackage = true;
    addDryRunConfirm(input, flags);
    return { command: 'mcp', subcommand: 'local-remove', input };
  }

  failCli({
    code: 'unknown_subcommand',
    message: `Unknown mcp local subcommand: ${action ?? '<missing>'}`,
    command: 'mcp local',
    parameter: 'subcommand',
    received: action ?? '<missing>',
    expected: 'One of: add, remove.',
    examples: ['codex-agent-session-manager mcp local add npm @modelcontextprotocol/server-everything --dry-run'],
    nextAction: 'Choose a supported mcp local subcommand.',
  });
}

function globalMcpCommand(action: string | undefined, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (action === 'add') {
    assertAllowedFlags(flags, ['server-name', 'entrypoint', 'arg', 'no-default-stdio-arg', 'env-var', 'allow-scripts', 'allow-no-env-vars', 'config', 'state-dir', 'dry-run', 'confirm'], 'mcp global add npm');
    const [provider, packageSpec, extra] = rest;
    if (provider !== 'npm') {
      failCli({
        code: 'unknown_mcp_provider',
        message: `Unknown mcp global add provider: ${provider ?? '<missing>'}`,
        command: 'mcp global add',
        parameter: 'provider',
        received: provider ?? '<missing>',
        expected: 'npm',
        examples: ['codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --dry-run'],
        nextAction: 'Use the npm provider for managed global MCP installs.',
      });
    }
    if (packageSpec === undefined || packageSpec.length === 0) {
      failCli({
        code: 'missing_package_spec',
        message: 'mcp global add npm requires a package spec.',
        command: 'mcp global add npm',
        parameter: 'package-spec',
        expected: 'An npm registry package spec, such as @scope/name, name, or name@version.',
        examples: ['codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --dry-run'],
        nextAction: 'Add the npm package spec immediately after npm.',
      });
    }
    if (extra !== undefined) {
      failCli({
        code: 'unexpected_argument',
        message: `Unexpected argument for mcp global add npm: ${extra}`,
        command: 'mcp global add npm',
        parameter: 'positional',
        received: extra,
        expected: 'Only one npm package spec positional argument.',
        examples: ['codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --server-name everything --dry-run'],
        nextAction: 'Move additional runtime args behind repeated --arg flags, or remove the extra positional argument.',
      });
    }
    const input = mcpNpmAddInput(flags, packageSpec);
    addOptional(input, 'configPath', stringFlag(flags, 'config'));
    addOptional(input, 'stateDir', stringFlag(flags, 'state-dir'));
    return { command: 'mcp', subcommand: 'global-add-npm', input };
  }

  if (action === 'remove') {
    assertAllowedFlags(flags, ['uninstall-package', 'config', 'state-dir', 'dry-run', 'confirm'], 'mcp global remove');
    const [serverName, extra] = rest;
    if (serverName === undefined || serverName.length === 0) {
      failCli({
        code: 'missing_server_name',
        message: 'mcp global remove requires a server name.',
        command: 'mcp global remove',
        parameter: 'server-name',
        expected: 'The exact managed user-global MCP server name from codex_mcp_cleanup_report.',
        examples: ['codex-agent-session-manager mcp report', 'codex-agent-session-manager mcp global remove everything --dry-run'],
        nextAction: 'Run mcp report to find managed global server names, then retry with the exact server name.',
      });
    }
    if (extra !== undefined) {
      failCli({
        code: 'unexpected_argument',
        message: `Unexpected argument for mcp global remove: ${extra}`,
        command: 'mcp global remove',
        parameter: 'positional',
        received: extra,
        expected: 'Only one server-name positional argument.',
        examples: ['codex-agent-session-manager mcp global remove everything --dry-run'],
        nextAction: 'Remove the extra argument.',
      });
    }
    const input: Record<string, unknown> = { serverName };
    if (hasFlag(flags, 'uninstall-package')) input.uninstallPackage = true;
    addOptional(input, 'configPath', stringFlag(flags, 'config'));
    addOptional(input, 'stateDir', stringFlag(flags, 'state-dir'));
    addDryRunConfirm(input, flags);
    return { command: 'mcp', subcommand: 'global-remove', input };
  }

  failCli({
    code: 'unknown_subcommand',
    message: `Unknown mcp global subcommand: ${action ?? '<missing>'}`,
    command: 'mcp global',
    parameter: 'subcommand',
    received: action ?? '<missing>',
    expected: 'One of: add, remove.',
    examples: ['codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --dry-run'],
    nextAction: 'Choose a supported mcp global subcommand.',
  });
}

function mcpInstallCommand(flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  assertAllowedFlags(flags, ['scope', 'server-name', 'entrypoint', 'arg', 'no-default-stdio-arg', 'env-var', 'allow-scripts', 'allow-no-env-vars', 'config', 'state-dir', 'dry-run', 'confirm'], 'mcp install npm');
  const [provider, packageSpec, extra] = rest;
  if (provider !== 'npm') {
    failCli({
      code: 'unknown_mcp_provider',
      message: `Unknown mcp install provider: ${provider ?? '<missing>'}`,
      command: 'mcp install',
      parameter: 'provider',
      received: provider ?? '<missing>',
      expected: 'npm',
      examples: ['codex-agent-session-manager mcp install npm @modelcontextprotocol/server-everything --dry-run'],
      nextAction: 'Use the npm provider.',
    });
  }
  if (packageSpec === undefined || packageSpec.length === 0) {
    failCli({
      code: 'missing_package_spec',
      message: 'mcp install npm requires a package spec.',
      command: 'mcp install npm',
      parameter: 'package-spec',
      expected: 'An npm registry package spec, such as @scope/name, name, or name@version.',
      examples: ['codex-agent-session-manager mcp install npm @modelcontextprotocol/server-everything --dry-run'],
      nextAction: 'Add the npm package spec immediately after npm.',
    });
  }
  if (extra !== undefined) {
    failCli({
      code: 'unexpected_argument',
      message: `Unexpected argument for mcp install npm: ${extra}`,
      command: 'mcp install npm',
      parameter: 'positional',
      received: extra,
      expected: 'Only one npm package spec positional argument.',
      examples: ['codex-agent-session-manager mcp install npm @modelcontextprotocol/server-everything --server-name everything --dry-run'],
      nextAction: 'Move additional runtime args behind repeated --arg flags, or remove the extra positional argument.',
    });
  }

  const input = mcpNpmAddInput(flags, packageSpec);
  addOptional(input, 'scope', stringFlag(flags, 'scope'));
  addOptional(input, 'configPath', stringFlag(flags, 'config'));
  addOptional(input, 'stateDir', stringFlag(flags, 'state-dir'));
  return { command: 'mcp', subcommand: 'install-npm', input };
}

function mcpCommand(subcommand: string, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (subcommand === 'local') return localMcpCommand(rest[0], flags, rest.slice(1));
  if (subcommand === 'global') return globalMcpCommand(rest[0], flags, rest.slice(1));
  if (subcommand === 'install') return mcpInstallCommand(flags, rest);
  if (subcommand === 'inspect') {
    assertAllowedFlags(flags, [], 'mcp inspect npm');
    const [provider, packageSpec, extra] = rest;
    if (provider !== 'npm') {
      failCli({
        code: 'unknown_mcp_provider',
        message: `Unknown mcp inspect provider: ${provider ?? '<missing>'}`,
        command: 'mcp inspect',
        parameter: 'provider',
        received: provider ?? '<missing>',
        expected: 'npm',
        examples: ['codex-agent-session-manager mcp inspect npm tavily-mcp'],
        nextAction: 'Use the npm provider.',
      });
    }
    if (packageSpec === undefined || packageSpec.length === 0) {
      failCli({
        code: 'missing_package_spec',
        message: 'mcp inspect npm requires a package spec.',
        command: 'mcp inspect npm',
        parameter: 'package-spec',
        expected: 'An npm registry package spec, such as @scope/name, name, or name@version.',
        examples: ['codex-agent-session-manager mcp inspect npm tavily-mcp'],
        nextAction: 'Add the npm package spec immediately after npm.',
      });
    }
    if (extra !== undefined) {
      failCli({
        code: 'unexpected_argument',
        message: `Unexpected argument for mcp inspect npm: ${extra}`,
        command: 'mcp inspect npm',
        parameter: 'positional',
        received: extra,
        expected: 'Only one npm package spec positional argument.',
        examples: ['codex-agent-session-manager mcp inspect npm tavily-mcp'],
        nextAction: 'Remove the extra argument.',
      });
    }
    return { command: 'mcp', subcommand: 'inspect-npm', input: { packageSpec } };
  }
  if (subcommand === 'report') {
    assertNoExtraPositionals(rest, 'mcp report');
    assertAllowedFlags(flags, ['no-global', 'no-operations', 'global-config', 'global-state-dir'], 'mcp report');
    const input: Record<string, unknown> = {};
    if (hasFlag(flags, 'no-global')) input.includeGlobal = false;
    if (hasFlag(flags, 'no-operations')) input.includeOperations = false;
    addOptional(input, 'globalConfigPath', stringFlag(flags, 'global-config'));
    addOptional(input, 'globalStateDir', stringFlag(flags, 'global-state-dir'));
    return { command: 'mcp', subcommand, input };
  }

  if (subcommand !== 'refresh') {
    failCli({
      code: 'unknown_subcommand',
      message: `Unknown mcp subcommand: ${subcommand}`,
      command: 'mcp',
      parameter: 'subcommand',
      received: subcommand,
      expected: 'One of: local, global, install, inspect, report, refresh.',
      examples: ['codex-agent-session-manager mcp report', 'codex-agent-session-manager mcp refresh --thread-id <thread-id>'],
      nextAction: 'Choose a supported mcp subcommand.',
    });
  }
  assertNoExtraPositionals(rest, 'mcp refresh');
  assertAllowedFlags(flags, ['url', 'thread-id', 'prompt', 'prompt-file', 'highlight-tool', 'timeout-ms', 'continuation-timeout-ms', 'continuation-poll-ms', 'continuation-stable-ms'], 'mcp refresh');
  const input: Record<string, unknown> = {
    threadId: requireString(flags, 'thread-id'),
  };
  addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
  addOptional(input, 'prompt', optionalPrompt(flags));
  addOptional(input, 'highlightTools', stringListFlag(flags, 'highlight-tool'));
  addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
  addOptional(input, 'continuationTimeoutMs', numberFlag(flags, 'continuation-timeout-ms'));
  addOptional(input, 'continuationPollMs', numberFlag(flags, 'continuation-poll-ms'));
  addOptional(input, 'continuationStableMs', numberFlag(flags, 'continuation-stable-ms'));
  return { command: 'mcp', subcommand, input };
}

function sessionLaunchInput(flags: Map<string, string[]>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
  addOptional(input, 'threadId', stringFlag(flags, 'thread-id'));
  addOptional(input, 'prompt', optionalPrompt(flags));
  const mode = hasFlag(flags, 'resume-last') ? 'last' : hasFlag(flags, 'pick') ? 'pick' : stringFlag(flags, 'mode');
  addOptional(input, 'mode', mode);
  if (hasFlag(flags, 'bypass-sandbox')) input.bypassSandbox = true;
  if (hasFlag(flags, 'enable-image-generation')) input.enableImageGeneration = true;
  addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
  addDryRunConfirm(input, flags);
  return input;
}

function sessionCommand(subcommand: string, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (subcommand === 'launch') {
    assertNoExtraPositionals(rest, 'session launch');
    assertAllowedFlags(flags, ['url', 'thread-id', 'prompt', 'prompt-file', 'mode', 'resume-last', 'pick', 'bypass-sandbox', 'enable-image-generation', 'timeout-ms', 'dry-run', 'confirm'], 'session launch');
    return { command: 'session', subcommand, input: sessionLaunchInput(flags) };
  }

  if (subcommand === 'close') {
    assertNoExtraPositionals(rest, 'session close');
    assertAllowedFlags(flags, ['url', 'thread-id', 'allow-workspace-url-fallback', 'timeout-ms', 'delay-ms', 'dry-run', 'confirm'], 'session close');
    const input: Record<string, unknown> = {
      threadId: requireString(flags, 'thread-id'),
    };
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    if (hasFlag(flags, 'allow-workspace-url-fallback')) input.allowWorkspaceUrlFallback = true;
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'delayMs', numberFlag(flags, 'delay-ms'));
    addDryRunConfirm(input, flags);
    return { command: 'session', subcommand, input };
  }

  if (subcommand === 'replace') {
    assertNoExtraPositionals(rest, 'session replace');
    assertAllowedFlags(flags, ['url', 'thread-id', 'prompt', 'prompt-file', 'bypass-sandbox', 'enable-image-generation', 'timeout-ms', 'delay-ms', 'dry-run', 'confirm'], 'session replace');
    const input: Record<string, unknown> = {
      threadId: requireString(flags, 'thread-id'),
    };
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    addOptional(input, 'prompt', optionalPrompt(flags));
    if (hasFlag(flags, 'bypass-sandbox')) input.bypassSandbox = true;
    if (hasFlag(flags, 'enable-image-generation')) input.enableImageGeneration = true;
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'delayMs', numberFlag(flags, 'delay-ms'));
    addDryRunConfirm(input, flags);
    return { command: 'session', subcommand, input };
  }

  failCli({
    code: 'unknown_subcommand',
    message: `Unknown session subcommand: ${subcommand}`,
    command: 'session',
    parameter: 'subcommand',
    received: subcommand,
    expected: 'One of: launch, close, replace.',
    examples: ['codex-agent-session-manager session launch --dry-run', 'codex-agent-session-manager session close --thread-id <thread-id> --dry-run'],
    nextAction: 'Choose a supported session subcommand.',
  });
}

function operationCommand(subcommand: string, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (subcommand === 'read') {
    assertNoExtraPositionals(rest, 'operation read');
    assertAllowedFlags(flags, ['operation-id'], 'operation read');
    return {
      command: 'operation',
      subcommand,
      input: { operationId: requireString(flags, 'operation-id') },
    };
  }

  if (subcommand === 'wait') {
    assertNoExtraPositionals(rest, 'operation wait');
    assertAllowedFlags(flags, ['operation-id', 'timeout-ms', 'poll-ms'], 'operation wait');
    const input: Record<string, unknown> = { operationId: requireString(flags, 'operation-id') };
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'pollMs', numberFlag(flags, 'poll-ms'));
    return { command: 'operation', subcommand, input };
  }

  failCli({
    code: 'unknown_subcommand',
    message: `Unknown operation subcommand: ${subcommand}`,
    command: 'operation',
    parameter: 'subcommand',
    received: subcommand,
    expected: 'One of: read, wait.',
    examples: ['codex-agent-session-manager operation read --operation-id <operation-id>'],
    nextAction: 'Choose a supported operation subcommand.',
  });
}

export function parsePublicCommand(argv: readonly string[]): ParsedPublicCommand | { help: true; text: string } {
  const parsed = parseArgs(argv);
  const [command, subcommand, ...rest] = parsed.positionals;
  if (
    command === undefined
    || command === 'help'
    || command === '--help'
    || hasFlag(parsed.flags, 'help')
  ) {
    return { help: true, text: usage() };
  }
  if (command === 'stop') {
    return appServerCommand(
      'stop',
      parsed.flags,
      [subcommand, ...rest].filter((value): value is string => value !== undefined),
      parsed.passthrough,
      { topLevelStopAlias: true },
    );
  }
  if (subcommand === undefined) {
    failCli({
      code: 'missing_subcommand',
      message: `${command} requires a subcommand.`,
      command,
      parameter: 'subcommand',
      expected: 'A supported subcommand.',
      examples: [`codex-agent-session-manager ${command} --help`],
      nextAction: 'Add a subcommand or run --help.',
    });
  }

  if (command === 'app-server') return appServerCommand(subcommand, parsed.flags, rest, parsed.passthrough);
  assertNoPassthrough(parsed.passthrough, command);
  if (command === 'mcp') return mcpCommand(subcommand, parsed.flags, rest);
  if (command === 'operation') return operationCommand(subcommand, parsed.flags, rest);
  if (command === 'session') return sessionCommand(subcommand, parsed.flags, rest);
  failCli({
    code: 'unknown_command',
    message: `Unknown public command: ${command}`,
    command,
    parameter: 'command',
    received: command,
    expected: 'One of: app-server, stop, mcp, operation, session.',
    examples: ['codex-agent-session-manager --help'],
    nextAction: 'Choose a supported command or run --help.',
  });
}

async function payloadFor(command: ParsedPublicCommand): Promise<Record<string, unknown>> {
  if (command.command === 'app-server' && command.subcommand === 'start') {
    return buildAppServerStartPayload(command.input as Parameters<typeof buildAppServerStartPayload>[0]);
  }
  if (command.command === 'app-server' && command.subcommand === 'status') {
    return buildAppServerStatusPayload(command.input as Parameters<typeof buildAppServerStatusPayload>[0]);
  }
  if (command.command === 'app-server' && command.subcommand === 'stop') {
    return buildAppServerStopPayload(command.input as Parameters<typeof buildAppServerStopPayload>[0]);
  }
  if (command.command === 'mcp' && command.subcommand === 'refresh') {
    return buildMcpRefreshPayload(command.input as Parameters<typeof buildMcpRefreshPayload>[0]);
  }
  if (command.command === 'mcp' && command.subcommand === 'inspect-npm') {
    return buildNpmPackageInspectPayload(command.input as Parameters<typeof buildNpmPackageInspectPayload>[0]);
  }
  if (command.command === 'mcp' && command.subcommand === 'install-npm') {
    return buildMcpInstallNpmPayload(command.input as Parameters<typeof buildMcpInstallNpmPayload>[0], {
      packageInspector: (packageSpec) => inspectNpmPackageForMcp({ packageSpec }),
    });
  }
  if (command.command === 'mcp' && command.subcommand === 'local-add-npm') {
    return buildLocalMcpAddNpmPayload(command.input as Parameters<typeof buildLocalMcpAddNpmPayload>[0], {
      packageInspector: (packageSpec) => inspectNpmPackageForMcp({ packageSpec }),
    });
  }
  if (command.command === 'mcp' && command.subcommand === 'local-remove') {
    return buildLocalMcpRemovePayload(command.input as Parameters<typeof buildLocalMcpRemovePayload>[0]);
  }
  if (command.command === 'mcp' && command.subcommand === 'global-add-npm') {
    return buildGlobalMcpAddNpmPayload(command.input as Parameters<typeof buildGlobalMcpAddNpmPayload>[0], {
      packageInspector: (packageSpec) => inspectNpmPackageForMcp({ packageSpec }),
    });
  }
  if (command.command === 'mcp' && command.subcommand === 'global-remove') {
    return buildGlobalMcpRemovePayload(command.input as Parameters<typeof buildGlobalMcpRemovePayload>[0]);
  }
  if (command.command === 'mcp' && command.subcommand === 'report') {
    return buildMcpCleanupReportPayload(command.input as Parameters<typeof buildMcpCleanupReportPayload>[0]);
  }
  if (command.command === 'operation' && command.subcommand === 'read') {
    return buildOperationReadPayload(
      command.input as Parameters<typeof buildOperationReadPayload>[0],
      new OperationStore({ workspace: process.cwd() }),
    );
  }
  if (command.command === 'operation' && command.subcommand === 'wait') {
    return buildOperationWaitPayload(
      command.input as Parameters<typeof buildOperationWaitPayload>[0],
      new OperationStore({ workspace: process.cwd() }),
    );
  }
  if (command.command === 'session' && command.subcommand === 'launch') {
    return buildSessionLaunchPayload(command.input as Parameters<typeof buildSessionLaunchPayload>[0]);
  }
  if (command.command === 'session' && command.subcommand === 'close') {
    return buildSessionClosePayload(command.input as Parameters<typeof buildSessionClosePayload>[0]);
  }
  if (command.command === 'session' && command.subcommand === 'replace') {
    return buildSessionReplacePayload(command.input as Parameters<typeof buildSessionReplacePayload>[0]);
  }
  failCli({
    code: 'unsupported_command',
    message: `Unsupported public command: ${command.command} ${command.subcommand}`,
    command: `${command.command} ${command.subcommand}`,
    expected: 'A command implemented by the public command dispatcher.',
    examples: ['codex-agent-session-manager --help'],
    nextAction: 'Run --help and choose a supported command.',
  });
}

export async function runPublicCommand(argv: readonly string[], deps: PublicCliDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const parsed = parsePublicCommand(argv);
  if ('help' in parsed) {
    output(parsed.text.trimEnd());
    return 0;
  }

  const payload = await payloadFor(parsed);
  output(JSON.stringify(payload, null, 2));
  return payload.ok === false ? 1 : 0;
}

export function publicCliUsage(): string {
  return usage();
}
