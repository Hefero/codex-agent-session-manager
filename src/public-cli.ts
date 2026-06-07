import { readFileSync } from 'node:fs';

import { buildAppServerStatusPayload, buildAppServerStopPayload } from './tools/app-server-lifecycle.js';
import { buildAppServerStartPayload } from './tools/app-server-start.js';
import { buildMcpAddNpmPayload } from './tools/mcp-add-npm.js';
import { buildMcpRefreshPayload } from './tools/mcp-refresh.js';
import { buildSessionClosePayload } from './tools/session-close.js';
import { buildSessionLaunchPayload } from './tools/session-launch.js';
import { buildSessionReplacePayload } from './tools/session-replace.js';

const booleanFlags = new Set([
  'bypass-sandbox',
  'confirm',
  'dry-run',
  'enable-image-generation',
  'help',
  'json',
  'no-process-tree',
  'no-probe-ready',
  'pick',
  'probe-ready',
  'resume-last',
]);

export interface ParsedPublicCommand {
  command: string;
  subcommand: string;
  input: Record<string, unknown>;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

export interface PublicCliDeps {
  output?: (text: string) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager app-server start [options]
  codex-agent-session-manager app-server status [options]
  codex-agent-session-manager app-server stop [options]
  codex-agent-session-manager mcp add npm <package-spec> [options]
  codex-agent-session-manager mcp refresh --thread-id <thread-id> [options]
  codex-agent-session-manager session launch [options]
  codex-agent-session-manager session close --thread-id <thread-id> [options]
  codex-agent-session-manager session replace --thread-id <thread-id> [options]

Common options:
  --url <ws-url>                    Loopback App Server websocket URL.
  --thread-id <id>                  Target Codex thread id.
  --prompt <text>                   Non-secret prompt text.
  --prompt-file <path>              Read prompt text from a local file.
  --dry-run                         Preview only.
  --confirm                         Execute a command that defaults to dry-run.
  --timeout-ms <ms>                 Request or operation timeout.

App Server:
  start:  --host <host> --port <port|auto> --enable-image-generation
  status: --no-probe-ready --no-process-tree --ready-timeout-ms <ms>
  stop:   --delay-ms <ms>

MCP:
  add npm: --server-name <name> --entrypoint <package-relative-js>
           --arg <value> --dry-run
  refresh: --highlight-tool <name> --continuation-timeout-ms <ms>
           --continuation-poll-ms <ms> --continuation-stable-ms <ms>

Session:
  launch:  --mode <fresh|session|last|pick> --resume-last --pick
           --bypass-sandbox --enable-image-generation
  close:   --delay-ms <ms>
  replace: --prompt <text> --bypass-sandbox --enable-image-generation
           --delay-ms <ms>
`;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (name.length === 0) throw new Error('Empty option name.');

    let value: string;
    if (equalsIndex >= 0) {
      value = withoutPrefix.slice(equalsIndex + 1);
    } else if (booleanFlags.has(name)) {
      value = 'true';
    } else {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Missing value for --${name}.`);
      value = next;
      index += 1;
    }

    flags.set(name, [...(flags.get(name) ?? []), value]);
  }

  return { positionals, flags };
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
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

function optionalPrompt(flags: Map<string, string[]>): string | undefined {
  const prompt = stringFlag(flags, 'prompt');
  const promptFile = stringFlag(flags, 'prompt-file');
  if (prompt !== undefined && promptFile !== undefined) {
    throw new Error('Use only one of --prompt or --prompt-file.');
  }
  if (prompt !== undefined) return prompt;
  if (promptFile !== undefined) return readFileSync(promptFile, 'utf8');
  return undefined;
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
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
}

function appServerCommand(subcommand: string, flags: Map<string, string[]>): ParsedPublicCommand {
  if (subcommand === 'start') {
    const input: Record<string, unknown> = {};
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    addOptional(input, 'host', stringFlag(flags, 'host'));
    addOptional(input, 'port', stringFlag(flags, 'port'));
    if (hasFlag(flags, 'enable-image-generation')) input.enableImageGeneration = true;
    addDryRunConfirm(input, flags);
    return { command: 'app-server', subcommand, input };
  }

  if (subcommand === 'status') {
    const input: Record<string, unknown> = {};
    if (hasFlag(flags, 'probe-ready')) input.probeReady = true;
    if (hasFlag(flags, 'no-probe-ready')) input.probeReady = false;
    if (hasFlag(flags, 'no-process-tree')) input.includeProcessTree = false;
    addOptional(input, 'readyTimeoutMs', numberFlag(flags, 'ready-timeout-ms'));
    return { command: 'app-server', subcommand, input };
  }

  if (subcommand === 'stop') {
    const input: Record<string, unknown> = {};
    addDryRunConfirm(input, flags);
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'delayMs', numberFlag(flags, 'delay-ms'));
    return { command: 'app-server', subcommand, input };
  }

  throw new Error(`Unknown app-server subcommand: ${subcommand}`);
}

function mcpCommand(subcommand: string, flags: Map<string, string[]>, rest: readonly string[]): ParsedPublicCommand {
  if (subcommand === 'add') {
    const [provider, packageSpec] = rest;
    if (provider !== 'npm') throw new Error(`Unknown mcp add provider: ${provider ?? '<missing>'}`);
    if (packageSpec === undefined || packageSpec.length === 0) throw new Error('mcp add npm requires a package spec.');
    const input: Record<string, unknown> = { packageSpec };
    addOptional(input, 'serverName', stringFlag(flags, 'server-name'));
    addOptional(input, 'entrypoint', stringFlag(flags, 'entrypoint'));
    addOptional(input, 'extraArgs', stringListFlag(flags, 'arg'));
    if (hasFlag(flags, 'dry-run')) input.dryRun = true;
    return { command: 'mcp', subcommand: 'add-npm', input };
  }

  if (subcommand !== 'refresh') throw new Error(`Unknown mcp subcommand: ${subcommand}`);
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

function sessionCommand(subcommand: string, flags: Map<string, string[]>): ParsedPublicCommand {
  if (subcommand === 'launch') {
    return { command: 'session', subcommand, input: sessionLaunchInput(flags) };
  }

  if (subcommand === 'close') {
    const input: Record<string, unknown> = {
      threadId: requireString(flags, 'thread-id'),
    };
    addOptional(input, 'appServerUrl', stringFlag(flags, 'url'));
    addOptional(input, 'timeoutMs', numberFlag(flags, 'timeout-ms'));
    addOptional(input, 'delayMs', numberFlag(flags, 'delay-ms'));
    addDryRunConfirm(input, flags);
    return { command: 'session', subcommand, input };
  }

  if (subcommand === 'replace') {
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

  throw new Error(`Unknown session subcommand: ${subcommand}`);
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
  if (subcommand === undefined) throw new Error(`${command} requires a subcommand.`);

  if (command === 'app-server') return appServerCommand(subcommand, parsed.flags);
  if (command === 'mcp') return mcpCommand(subcommand, parsed.flags, rest);
  if (command === 'session') return sessionCommand(subcommand, parsed.flags);
  throw new Error(`Unknown public command: ${command}`);
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
  if (command.command === 'mcp' && command.subcommand === 'add-npm') {
    return buildMcpAddNpmPayload(command.input as Parameters<typeof buildMcpAddNpmPayload>[0]);
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
  throw new Error(`Unsupported public command: ${command.command} ${command.subcommand}`);
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
