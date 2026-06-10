import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { userError } from './errors.js';
import { resolveWorkspaceRoot, workspacePath } from './security/workspace.js';

export type SecretScope = 'user' | 'workspace';

export interface SecretStoreOptions {
  scope?: SecretScope;
  workspace?: string;
  filePath?: string;
}

export interface SecretStatusEntry {
  name: string;
  available: boolean;
  source: 'environment' | 'store' | 'both' | 'missing';
  scope: SecretScope | 'mixed';
}

interface SecretFile {
  version: 1;
  updatedAt: string;
  secrets: Record<string, string>;
}

const SECRET_FILE_ENV = 'CODEX_AGENT_SESSION_MANAGER_SECRETS_FILE';
const SECRET_DIR_NAME = 'codex-agent-session-manager';
const SECRET_FILE_NAME = 'secrets.json';
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function defaultUserSecretFile(): string {
  const override = process.env[SECRET_FILE_ENV];
  if (override !== undefined && override.trim().length > 0) return resolve(override);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, SECRET_DIR_NAME, 'secrets', SECRET_FILE_NAME);
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, SECRET_DIR_NAME, 'secrets', SECRET_FILE_NAME);
}

export function validateSecretName(name: string): string {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw userError({
      code: 'invalid_secret_name',
      message: `Invalid secret name: ${name}`,
      parameter: 'name',
      received: name,
      expected: 'An environment variable name matching /^[A-Za-z_][A-Za-z0-9_]*$/.',
      examples: ['codex-agent-session-manager secret set TAVILY_API_KEY'],
      nextAction: 'Use the environment variable name required by the MCP package, not the secret value itself.',
    });
  }
  return name;
}

export function secretStorePath(options: SecretStoreOptions = {}): string {
  if (options.filePath !== undefined) return resolve(options.filePath);
  const scope = options.scope ?? 'user';
  if (scope === 'user') return defaultUserSecretFile();
  const workspace = resolveWorkspaceRoot(options.workspace ?? process.cwd());
  return workspacePath(workspace, '.codex-agent-session-manager', 'secrets', SECRET_FILE_NAME);
}

function emptySecretFile(): SecretFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    secrets: {},
  };
}

function parseSecretFile(path: string, content: string): SecretFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw userError({
      code: 'invalid_secret_store',
      message: `Secret store is not valid JSON: ${path}`,
      parameter: 'secret-store',
      received: path,
      expected: 'A JSON file created by codex-agent-session-manager secret set.',
      nextAction: 'Move the invalid file aside, then recreate secrets with codex-agent-session-manager secret set <NAME>.',
      cause: error,
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw userError({
      code: 'invalid_secret_store',
      message: `Secret store must contain a JSON object: ${path}`,
      parameter: 'secret-store',
      received: path,
      expected: 'A JSON object with version and secrets fields.',
      nextAction: 'Move the invalid file aside, then recreate secrets with codex-agent-session-manager secret set <NAME>.',
    });
  }

  const record = parsed as Record<string, unknown>;
  const secrets = record.secrets;
  if (record.version !== 1 || secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw userError({
      code: 'unsupported_secret_store',
      message: `Unsupported secret store format: ${path}`,
      parameter: 'secret-store',
      received: path,
      expected: 'Secret store version 1.',
      nextAction: 'Upgrade codex-agent-session-manager or recreate the secret store with the current CLI.',
    });
  }

  const cleanSecrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    validateSecretName(name);
    if (typeof value !== 'string') {
      throw userError({
        code: 'invalid_secret_store_value',
        message: `Secret store value for ${name} must be a string.`,
        parameter: name,
        expected: 'A string value.',
        nextAction: 'Re-run codex-agent-session-manager secret set for the affected secret.',
      });
    }
    cleanSecrets[name] = value;
  }

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    secrets: cleanSecrets,
  };
}

export function readSecretFile(options: SecretStoreOptions = {}): { path: string; exists: boolean; file: SecretFile } {
  const path = secretStorePath(options);
  if (!existsSync(path)) return { path, exists: false, file: emptySecretFile() };
  return { path, exists: true, file: parseSecretFile(path, readFileSync(path, 'utf8')) };
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows ACLs are platform-managed in this alpha. Unix permissions are enforced where available.
  }
}

function writeSecretFile(path: string, file: SecretFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodBestEffort(dirname(path), 0o700);
  const tempPath = join(dirname(path), `.secrets-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodBestEffort(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodBestEffort(path, 0o600);
}

export function setStoredSecret(name: string, value: string, options: SecretStoreOptions = {}): { path: string; scope: SecretScope } {
  validateSecretName(name);
  if (value.length === 0) {
    throw userError({
      code: 'empty_secret_value',
      message: `${name} cannot be empty.`,
      parameter: 'value',
      expected: 'A non-empty secret value.',
      nextAction: 'Retry secret set and paste the actual API key/token when prompted.',
    });
  }

  const scope = options.scope ?? 'user';
  const { path, file } = readSecretFile({ ...options, scope });
  file.updatedAt = new Date().toISOString();
  file.secrets[name] = value;
  writeSecretFile(path, file);
  return { path, scope };
}

export function unsetStoredSecret(name: string, options: SecretStoreOptions = {}): { path: string; scope: SecretScope; removed: boolean } {
  validateSecretName(name);
  const scope = options.scope ?? 'user';
  const { path, exists, file } = readSecretFile({ ...options, scope });
  if (!exists || file.secrets[name] === undefined) return { path, scope, removed: false };
  delete file.secrets[name];
  file.updatedAt = new Date().toISOString();
  if (Object.keys(file.secrets).length === 0) {
    rmSync(path, { force: true });
  } else {
    writeSecretFile(path, file);
  }
  return { path, scope, removed: true };
}

export function listStoredSecretNames(options: SecretStoreOptions = {}): { path: string; scope: SecretScope; names: string[] } {
  const scope = options.scope ?? 'user';
  const { path, file } = readSecretFile({ ...options, scope });
  return {
    path,
    scope,
    names: Object.keys(file.secrets).sort((left, right) => left.localeCompare(right)),
  };
}

function sourceFor(input: { envValue?: string | undefined; storeValue?: string | undefined }): SecretStatusEntry['source'] {
  const hasEnv = input.envValue !== undefined && input.envValue.length > 0;
  const hasStore = input.storeValue !== undefined && input.storeValue.length > 0;
  if (hasEnv && hasStore) return 'both';
  if (hasEnv) return 'environment';
  if (hasStore) return 'store';
  return 'missing';
}

export function secretStatus(
  names: readonly string[] | undefined,
  options: SecretStoreOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { path: string; scope: SecretScope; entries: SecretStatusEntry[] } {
  const scope = options.scope ?? 'user';
  const { path, file } = readSecretFile({ ...options, scope });
  const targetNames = names === undefined || names.length === 0
    ? Object.keys(file.secrets)
    : names.map(validateSecretName);

  const entries = [...new Set(targetNames)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const source = sourceFor({ envValue: env[name], storeValue: file.secrets[name] });
      return {
        name,
        available: source !== 'missing',
        source,
        scope,
      };
    });

  return { path, scope, entries };
}

function storedEnv(options: SecretStoreOptions): Record<string, string> {
  const { file } = readSecretFile(options);
  return Object.fromEntries(
    Object.entries(file.secrets).filter((entry): entry is [string, string] => entry[1].length > 0),
  );
}

export function buildManagedProcessEnv(input: {
  workspace?: string | undefined;
  appServerUrl?: string | undefined;
  baseEnv?: NodeJS.ProcessEnv | undefined;
} = {}): NodeJS.ProcessEnv {
  const baseEnv = input.baseEnv ?? process.env;
  const workspace = input.workspace === undefined ? undefined : resolveWorkspaceRoot(input.workspace);
  const userSecrets = storedEnv({ scope: 'user' });
  const workspaceSecrets = workspace === undefined ? {} : storedEnv({ scope: 'workspace', workspace });
  const env: NodeJS.ProcessEnv = {
    ...userSecrets,
    ...workspaceSecrets,
    ...baseEnv,
  };
  if (input.appServerUrl !== undefined) env.CODEX_APP_SERVER_URL = input.appServerUrl;
  return env;
}

