import type { ReadStream } from 'node:tty';

import {
  listStoredSecretNames,
  secretStatus,
  setStoredSecret,
  unsetStoredSecret,
  validateSecretName,
  type SecretScope,
} from './secrets.js';
import { userError } from './errors.js';

interface ParsedSecretArgs {
  subcommand?: 'set' | 'list' | 'status' | 'unset';
  names: string[];
  scope: SecretScope;
  stdin: boolean;
  json: boolean;
  help: boolean;
}

export interface SecretCliDeps {
  output?: (text: string) => void;
  writePrompt?: (text: string) => void;
  readSecret?: (prompt: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  storeFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function secretUsage(): string {
  return `Usage:
  codex-agent-session-manager secret set <NAME> [options]
  codex-agent-session-manager secret list [options]
  codex-agent-session-manager secret status [NAME...] [options]
  codex-agent-session-manager secret unset <NAME> [options]

Options:
  --scope <user|workspace>   Secret store scope. Default: user.
  --stdin                    Read secret value from stdin. Only valid with set.
  --json                     Print machine-readable JSON output.
  --help                     Show this help.

Security:
  secret set prompts with hidden input by default and asks for confirmation.
  Secret values are never accepted as command arguments and are never printed.
  MCP config should store only env var names, for example env_vars = ["TAVILY_API_KEY"].
`;
}

function parseSecretArgs(argv: readonly string[]): ParsedSecretArgs {
  const parsed: ParsedSecretArgs = {
    names: [],
    scope: 'user',
    stdin: false,
    json: false,
    help: false,
  };

  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    parsed.help = true;
    return parsed;
  }
  if (first !== 'set' && first !== 'list' && first !== 'status' && first !== 'unset') {
    throw userError({
      code: 'unknown_secret_subcommand',
      message: `Unknown secret subcommand: ${first}`,
      command: 'secret',
      parameter: 'subcommand',
      received: first,
      expected: 'One of: set, list, status, unset.',
      examples: ['codex-agent-session-manager secret set TAVILY_API_KEY'],
      nextAction: 'Choose a supported secret subcommand.',
    });
  }
  parsed.subcommand = first;

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
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${name}.`);
      index += 1;
      return next;
    };

    switch (name) {
      case '--scope': {
        const scope = readValue();
        if (scope !== 'user' && scope !== 'workspace') {
          throw userError({
            code: 'invalid_secret_scope',
            message: `Invalid secret scope: ${scope}`,
            command: 'secret',
            parameter: '--scope',
            received: scope,
            expected: 'user or workspace.',
            examples: ['codex-agent-session-manager secret set TAVILY_API_KEY --scope user'],
            nextAction: 'Use user for reusable personal API keys, or workspace for a project-local ignored runtime secret.',
          });
        }
        parsed.scope = scope;
        break;
      }
      case '--stdin':
        parsed.stdin = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        if (raw.startsWith('--')) {
          throw userError({
            code: 'unknown_secret_option',
            message: `Unknown option for secret ${parsed.subcommand}: ${raw}`,
            command: `secret ${parsed.subcommand}`,
            parameter: raw,
            received: raw,
            expected: 'One of: --scope, --stdin, --json, --help.',
            examples: ['codex-agent-session-manager secret set TAVILY_API_KEY'],
            nextAction: 'Remove the unsupported option or run codex-agent-session-manager secret --help.',
          });
        }
        parsed.names.push(raw);
    }
  }

  if (parsed.stdin && parsed.subcommand !== 'set') {
    throw userError({
      code: 'invalid_secret_stdin_usage',
      message: '--stdin is only valid with secret set.',
      command: `secret ${parsed.subcommand}`,
      parameter: '--stdin',
      expected: 'Use --stdin only when setting a secret value.',
      examples: ['printf "%s" "$TAVILY_API_KEY" | codex-agent-session-manager secret set TAVILY_API_KEY --stdin'],
      nextAction: 'Remove --stdin or use secret set.',
    });
  }

  return parsed;
}

function requireOneName(parsed: ParsedSecretArgs): string {
  if (parsed.names.length !== 1) {
    throw userError({
      code: 'secret_name_required',
      message: `secret ${parsed.subcommand} requires exactly one secret name.`,
      command: `secret ${parsed.subcommand}`,
      parameter: 'name',
      received: parsed.names.length,
      expected: 'Exactly one environment variable name.',
      examples: [`codex-agent-session-manager secret ${parsed.subcommand} TAVILY_API_KEY`],
      nextAction: 'Pass the env var name only. Do not pass the secret value as an argument.',
    });
  }
  return validateSecretName(parsed.names[0] ?? '');
}

async function readAllStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.replace(/\r?\n$/u, '');
}

function defaultWritePrompt(text: string): void {
  process.stdout.write(text);
}

function asReadStream(input: NodeJS.ReadStream): ReadStream | null {
  return typeof input.setRawMode === 'function' ? input as ReadStream : null;
}

async function readHiddenLine(prompt: string, writePrompt: (text: string) => void): Promise<string> {
  const stdin = asReadStream(process.stdin);
  if (!stdin?.isTTY) {
    throw userError({
      code: 'secret_prompt_requires_tty',
      message: 'secret set requires an interactive TTY when --stdin is not used.',
      command: 'secret set',
      parameter: '--stdin',
      expected: 'An interactive terminal or secret value piped through stdin.',
      examples: ['codex-agent-session-manager secret set TAVILY_API_KEY', 'pass show tavily/api-key | codex-agent-session-manager secret set TAVILY_API_KEY --stdin'],
      nextAction: 'Run from an interactive terminal or pipe the value with --stdin. Never pass the secret as a command argument.',
    });
  }

  writePrompt(prompt);
  stdin.resume();
  stdin.setRawMode(true);

  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      writePrompt('\n');
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(userError({
            code: 'secret_prompt_cancelled',
            message: 'Secret input was cancelled.',
            command: 'secret set',
            nextAction: 'Retry secret set when ready.',
          }));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function promptSecretValue(name: string, deps: SecretCliDeps): Promise<string> {
  const reader = deps.readSecret ?? ((prompt: string) => readHiddenLine(prompt, deps.writePrompt ?? defaultWritePrompt));
  const first = await reader(`Enter ${name}: `);
  const second = await reader(`Confirm ${name}: `);
  if (first !== second) {
    throw userError({
      code: 'secret_confirmation_mismatch',
      message: `${name} confirmation did not match.`,
      command: 'secret set',
      parameter: 'confirmation',
      expected: 'The same value entered twice.',
      nextAction: 'Retry secret set. The previous value was not saved.',
    });
  }
  return first;
}

function resultText(payload: Record<string, unknown>): string {
  const command = String(payload.command ?? 'secret');
  if (command === 'set') {
    return [
      'codex-agent-session-manager secret set applied',
      `name: ${payload.name}`,
      `scope: ${payload.scope}`,
      `store: ${payload.path}`,
      'value: <hidden>',
      '',
      'Next: install/configure the MCP with only the env var name. The agent should use session-manager refresh/relaunch tools if an active session must inherit the new value.',
    ].join('\n');
  }
  if (command === 'unset') {
    return [
      `codex-agent-session-manager secret unset ${payload.removed ? 'applied' : 'noop'}`,
      `name: ${payload.name}`,
      `scope: ${payload.scope}`,
      `store: ${payload.path}`,
    ].join('\n');
  }
  if (command === 'list') {
    const names = payload.names as string[];
    return [
      'codex-agent-session-manager secret list',
      `scope: ${payload.scope}`,
      `store: ${payload.path}`,
      `names: ${names.length > 0 ? names.join(', ') : '(none)'}`,
    ].join('\n');
  }
  const entries = payload.entries as Array<{ name: string; available: boolean; source: string }>;
  return [
    'codex-agent-session-manager secret status',
    `scope: ${payload.scope}`,
    `store: ${payload.path}`,
    ...entries.map((entry) => `  ${entry.name}: ${entry.available ? entry.source : 'missing'}`),
    ...(entries.length === 0 ? ['  (no stored secrets; pass a NAME to check a specific env var)'] : []),
  ].join('\n');
}

export async function runSecretCommand(argv: readonly string[], deps: SecretCliDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const parsed = parseSecretArgs(argv);
  if (parsed.help) {
    output(secretUsage().trimEnd());
    return 0;
  }

  let payload: Record<string, unknown>;
  const storeOptions = deps.storeFile === undefined
    ? { scope: parsed.scope }
    : { scope: parsed.scope, filePath: deps.storeFile };
  if (parsed.subcommand === 'set') {
    const name = requireOneName(parsed);
    const rawValue = parsed.stdin
      ? await (deps.readStdin ?? readAllStdin)()
      : await promptSecretValue(name, deps);
    const value = rawValue.replace(/\r?\n$/u, '');
    const result = setStoredSecret(name, value, storeOptions);
    payload = { ok: true, command: 'set', name, scope: result.scope, path: result.path };
  } else if (parsed.subcommand === 'unset') {
    const name = requireOneName(parsed);
    const result = unsetStoredSecret(name, storeOptions);
    payload = { ok: true, command: 'unset', name, scope: result.scope, path: result.path, removed: result.removed };
  } else if (parsed.subcommand === 'list') {
    if (parsed.names.length > 0) {
      throw userError({
        code: 'unexpected_secret_argument',
        message: 'secret list does not accept positional names.',
        command: 'secret list',
        parameter: 'name',
        received: parsed.names[0],
        expected: 'No positional arguments.',
        nextAction: 'Use secret status NAME to check a specific secret.',
      });
    }
    const result = listStoredSecretNames(storeOptions);
    payload = { ok: true, command: 'list', scope: result.scope, path: result.path, names: result.names };
  } else {
    const result = secretStatus(parsed.names, storeOptions, deps.env ?? process.env);
    payload = { ok: true, command: 'status', scope: result.scope, path: result.path, entries: result.entries };
  }

  output(parsed.json ? JSON.stringify(payload, null, 2) : resultText(payload));
  return 0;
}
