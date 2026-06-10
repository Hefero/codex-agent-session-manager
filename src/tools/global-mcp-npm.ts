import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

import { userError } from '../errors.js';
import { runNpm, type NpmRunResult } from '../npm.js';
import { prepareWindowsHiddenLauncherForDirectory } from '../remote.js';
import { redactValue } from '../security/redaction.js';
import { OperationStore } from './operations.js';

const DEFAULT_TRANSPORT_ARG = 'stdio';
const CONFIG_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:global-mcp-add:';
const CONFIG_MARKER_END = '# END codex-agent-session-manager:global-mcp-add';
const MAX_PACKAGE_SPEC_CHARS = 200;
const MAX_ENTRYPOINT_CHARS = 300;
const MAX_EXTRA_ARGS = 20;
const MAX_ENV_VARS = 20;
const GLOBAL_STATE_DIR_NAME = '.codex-agent-session-manager';

const packageSpecSchema = z
  .string()
  .min(1)
  .max(MAX_PACKAGE_SPEC_CHARS)
  .refine((value) => parseRegistryPackageName(value) !== null, {
    message: 'Only npm registry package specs are supported for third-party MCP install, for example @scope/name or name@version. Do not pass a filesystem path or tarball here; use init --package-spec only for installing this package itself during project init.',
  })
  .describe('npm registry package spec to install into the user-global MCP runtime.');

const serverNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .describe('User-global Codex MCP server name to add or remove under ~/.codex/config.toml.');

const envVarNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .describe('Environment variable name to forward to the global MCP stdio server without storing its value in config.');

const optionalPathSchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('Advanced/testing path override. Defaults to the user-global location.');

export const globalMcpAddNpmInputSchema = {
  packageSpec: packageSpecSchema,
  serverName: serverNameSchema.optional(),
  entrypoint: z
    .string()
    .min(1)
    .max(MAX_ENTRYPOINT_CHARS)
    .optional()
    .describe('Package-relative JavaScript entrypoint. Defaults to the first package.json bin target after install.'),
  extraArgs: z
    .array(z.string().max(200))
    .max(MAX_EXTRA_ARGS)
    .optional()
    .describe('Extra args passed after the package entrypoint. Defaults to ["stdio"].'),
  envVars: z
    .array(envVarNameSchema)
    .max(MAX_ENV_VARS)
    .optional()
    .describe('Environment variable names to forward through global config env_vars without storing secret values.'),
  allowScripts: z
    .boolean()
    .optional()
    .describe('Defaults false. When false, npm install uses --ignore-scripts so package lifecycle scripts do not run during install.'),
  configPath: optionalPathSchema,
  stateDir: optionalPathSchema,
  dryRun: z.boolean().optional().describe('Defaults true. Preview the global npm MCP install and user-global config update without changing files.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

export const globalMcpRemoveInputSchema = {
  serverName: serverNameSchema,
  uninstallPackage: z
    .boolean()
    .optional()
    .describe('When true, remove the isolated user-global MCP package directory for this managed server. Defaults false.'),
  configPath: optionalPathSchema,
  stateDir: optionalPathSchema,
  dryRun: z.boolean().optional().describe('Defaults true. Preview global config/package removal without changing files.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

const globalMcpAddNpmInputObject = z.object(globalMcpAddNpmInputSchema);
const globalMcpRemoveInputObject = z.object(globalMcpRemoveInputSchema);
type GlobalMcpAddNpmInput = z.infer<typeof globalMcpAddNpmInputObject>;
type GlobalMcpRemoveInput = z.infer<typeof globalMcpRemoveInputObject>;

export type GlobalMcpNpmRunner = (args: readonly string[], options: { cwd: string }) => NpmRunResult;

type GlobalMcpActionKind = 'create' | 'update' | 'noop' | 'run' | 'delete' | 'skip';

interface GlobalMcpAction {
  kind: GlobalMcpActionKind;
  target: string;
  reason: string;
  command?: string[];
}

interface PackageInfo {
  packageName: string;
  entrypoint: string;
  lifecycleScripts: string[];
}

interface ManagedBlock {
  serverName: string;
  startIndex: number;
  endIndex: number;
  block: string;
  packageName: string | null;
  serverDir: string | null;
}

function defaultConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function defaultGlobalStateDir(): string {
  return join(homedir(), GLOBAL_STATE_DIR_NAME);
}

function resolveInputPath(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback);
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function finalizeFileContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return ensureTrailingNewline(content.trimEnd());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPackageVersionPart(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9._+~^*-]+$/u.test(value);
}

function parseRegistryPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed !== spec || trimmed.length === 0 || /[\s:\\]/u.test(trimmed)) return null;

  if (trimmed.startsWith('@')) {
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex < 0) return null;
    const versionIndex = trimmed.indexOf('@', slashIndex + 1);
    const name = versionIndex >= 0 ? trimmed.slice(0, versionIndex) : trimmed;
    const versionPart = versionIndex >= 0 ? trimmed.slice(versionIndex + 1) : null;
    if (versionPart !== null && !validPackageVersionPart(versionPart)) return null;
    return /^@[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(name) ? name : null;
  }

  const versionIndex = trimmed.indexOf('@');
  const name = versionIndex >= 0 ? trimmed.slice(0, versionIndex) : trimmed;
  const versionPart = versionIndex >= 0 ? trimmed.slice(versionIndex + 1) : null;
  if (versionPart !== null && !validPackageVersionPart(versionPart)) return null;
  return /^[a-z0-9._-]+$/u.test(name) ? name : null;
}

function defaultServerName(packageName: string): string {
  const scope = packageName.startsWith('@') ? packageName.slice(1, packageName.indexOf('/')) : '';
  const rawLastPart = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName;
  const withoutPrefix = rawLastPart.replace(/^(?:mcp-server-|server-)/u, '');
  const base = withoutPrefix === 'mcp' && scope.length > 0 ? `${scope}-${withoutPrefix}` : withoutPrefix;
  const normalized = base.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : 'mcp_server';
}

function safePackageDirName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]+/gu, '_');
}

function previewPath(path: string, input: { stateDir: string; configPath: string }): string {
  const normalizedState = input.stateDir.toLowerCase();
  const normalizedConfig = input.configPath.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath === normalizedConfig) return '<user-codex-config>';
  if (normalizedPath === normalizedState) return '<global-state>';
  if (normalizedPath.startsWith(`${normalizedState}\\`) || normalizedPath.startsWith(`${normalizedState}/`)) {
    return `<global-state>${path.slice(input.stateDir.length)}`;
  }
  return String(redactValue(path));
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/gu, '/'));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function minimalPackageJson(serverName: string): string {
  const rawName = `codex-agent-session-manager-global-mcp-${serverName}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${JSON.stringify({
    name: rawName.length > 0 ? rawName : 'codex-agent-session-manager-global-mcp',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
  }, null, 2)}\n`;
}

function npmInstallArgs(input: { packageSpec: string; allowScripts: boolean; cacheDir: string }): string[] {
  const args = ['install', '--save'];
  if (!input.allowScripts) args.push('--ignore-scripts');
  args.push('--no-audit', '--no-fund', '--cache', input.cacheDir);
  args.push(input.packageSpec);
  return args;
}

function validatePackageEntrypoint(entrypoint: string): string {
  const normalized = normalize(entrypoint).replace(/\\/gu, '/');
  if (isAbsolute(entrypoint) || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    throw new Error(`Package entrypoint must stay inside the npm package: ${entrypoint}`);
  }
  if (!/\.(?:cjs|mjs|js)$/u.test(normalized)) {
    throw new Error(`Package entrypoint must be a JavaScript file: ${entrypoint}`);
  }
  return normalized;
}

function firstBinTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
  return entries[0]?.[1] ?? null;
}

function installedPackageLifecycleScripts(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const scripts = isRecord(value.scripts) ? value.scripts : {};
  const lifecycleScriptNames = [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'preprepare',
    'prepare',
    'postprepare',
  ];
  return lifecycleScriptNames.filter((name) => typeof scripts[name] === 'string');
}

function resolveInstalledPackage(input: { serverDir: string; packageName: string; entrypoint?: string | undefined }): PackageInfo {
  const packageJsonPath = join(input.serverDir, 'node_modules', ...input.packageName.split('/'), 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package metadata was not found at ${previewPath(packageJsonPath, {
      stateDir: dirname(dirname(input.serverDir)),
      configPath: '',
    })}.`);
  }

  const parsed = JSON.parse(stripBom(readFileSync(packageJsonPath, 'utf8'))) as unknown;
  if (!isRecord(parsed)) throw new Error(`Installed package.json for ${input.packageName} must contain a JSON object.`);

  const binTarget = input.entrypoint ?? firstBinTarget(parsed.bin);
  if (binTarget === null) {
    throw new Error(`Could not infer a JavaScript entrypoint for ${input.packageName}; pass entrypoint explicitly.`);
  }

  return {
    packageName: input.packageName,
    entrypoint: validatePackageEntrypoint(binTarget),
    lifecycleScripts: installedPackageLifecycleScripts(parsed),
  };
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

function hasManagedServerBlock(content: string | null, serverName: string): boolean {
  return content !== null && content.includes(`${CONFIG_MARKER_PREFIX}${serverName}`);
}

function hasUnmanagedServerSection(content: string | null, serverName: string): boolean {
  if (content === null || hasManagedServerBlock(content, serverName)) return false;
  const sectionPattern = new RegExp(`^\\s*\\[mcp_servers\\.${serverName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*$`, 'mu');
  return sectionPattern.test(content);
}

function assertNoUnmanagedServerConflict(content: string | null, serverName: string): void {
  if (hasUnmanagedServerSection(content, serverName)) {
    throw new Error(`User Codex config already has an unmanaged [mcp_servers.${serverName}] section. Choose another serverName or edit it manually.`);
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

function upsertManagedConfigBlock(content: string | null, serverName: string, block: string): string {
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);
  const marked = replaceMarkedBlock(content, `${CONFIG_MARKER_PREFIX}${serverName}`, CONFIG_MARKER_END, block);
  if (marked !== null) return marked;
  assertNoUnmanagedServerConflict(content, serverName);
  return ensureTrailingNewline(`${content.trimEnd()}\n\n${block}`);
}

function inferManagedMcpPackageName(block: string): string | null {
  const normalized = block.replace(/\\/gu, '/');
  const match = /node_modules\/((?:@[^/"\s]+\/)?[^/"\s]+)/u.exec(normalized);
  return match?.[1] ?? null;
}

function inferManagedServerDir(block: string): string | null {
  const match = /^\s*cwd\s*=\s*"([^"]+)"\s*$/mu.exec(block);
  return match?.[1] ?? null;
}

function managedBlocks(content: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  let searchIndex = 0;
  while (true) {
    const startIndex = content.indexOf(CONFIG_MARKER_PREFIX, searchIndex);
    if (startIndex < 0) break;
    const startsLine = startIndex === 0
      || content[startIndex - 1] === '\n'
      || (startIndex === 1 && content.charCodeAt(0) === 0xFEFF);
    if (!startsLine) {
      searchIndex = startIndex + CONFIG_MARKER_PREFIX.length;
      continue;
    }
    const markerLineEnd = content.indexOf('\n', startIndex);
    const markerEndIndex = markerLineEnd >= 0 ? markerLineEnd : content.length;
    const markerLine = content.slice(startIndex, markerEndIndex).trim();
    const serverName = markerLine.slice(CONFIG_MARKER_PREFIX.length);
    serverNameSchema.parse(serverName);

    const blockEndMarkerIndex = findMarkerLine(content, CONFIG_MARKER_END, markerEndIndex);
    if (blockEndMarkerIndex < 0) {
      throw new Error(`Found ${CONFIG_MARKER_PREFIX} without ${CONFIG_MARKER_END}.`);
    }
    const endIndex = blockEndMarkerIndex + CONFIG_MARKER_END.length;
    const block = content.slice(startIndex, endIndex);
    blocks.push({
      serverName,
      startIndex,
      endIndex,
      block,
      packageName: inferManagedMcpPackageName(block),
      serverDir: inferManagedServerDir(block),
    });
    searchIndex = endIndex;
  }
  return blocks;
}

function removeManagedBlock(content: string, block: ManagedBlock): string | null {
  const before = content.slice(0, block.startIndex).trimEnd();
  const after = content.slice(block.endIndex).trimStart();
  return finalizeFileContent([before, after].filter((part) => part.length > 0).join('\n\n'));
}

function actionForFile(path: string, current: string | null, next: string | null, paths: { stateDir: string; configPath: string }, reason: string): GlobalMcpAction {
  if (current === null && next === null) return { kind: 'noop', target: previewPath(path, paths), reason };
  if (current === next) return { kind: 'noop', target: previewPath(path, paths), reason };
  if (next === null) return { kind: 'delete', target: previewPath(path, paths), reason };
  return { kind: current === null ? 'create' : 'update', target: previewPath(path, paths), reason };
}

function warningsFor(input: { envVars: string[]; lifecycleScriptsSuppressed?: boolean; global: boolean }): string[] {
  const warnings: string[] = [];
  warnings.push('This edits user-global Codex MCP config. It affects Codex sessions outside the current project until removed.');
  if (input.envVars.length > 0) {
    warnings.push('env_vars stores variable names only. The named values must exist in the App Server launch environment before MCP refresh; if they were created or changed after App Server start, restart or relaunch the managed App Server first.');
    warnings.push('For OAuth, PII, write-capable, or destructive MCPs, confirm the requested scopes with the operator, keep keys and tokens outside project workspaces or under ignored paths, and do not print sensitive values.');
  }
  if (input.lifecycleScriptsSuppressed === true) {
    warnings.push('The installed package declares npm lifecycle scripts, but this install used --ignore-scripts. If the MCP server fails because generated or native assets are missing, rerun with allowScripts:true only after reviewing the package.');
  }
  return warnings;
}

function missingGlobalServerNextAction(serverName: string): string {
  return `No managed user-global MCP block was found for serverName "${serverName}". Call codex_mcp_cleanup_report, inspect global.managedServers[].serverName, then retry with the exact managed serverName. If the block is unmanaged, remove it manually from ~/.codex/config.toml or choose the matching local/global remove tool.`;
}

function nextActionFor(input: { serverName: string; envVars: string[]; dryRun: boolean }): string {
  const installStep = input.dryRun ? 'Run with dryRun:false and confirm:true.' : '';
  const envStep = input.envVars.length > 0
    ? ' Ensure the named env vars are visible to the App Server process; restart or relaunch the managed App Server first if they were just created or changed.'
    : '';
  return `${installStep}${envStep} Reload/restart any active Codex App Server that should see this global MCP, then use codex_mcp_refresh with an explicit threadId and prove with a real callable tool under mcp__${input.serverName}.`.trim();
}

function mcpServerBlock(input: {
  serverName: string;
  packageName: string;
  entrypoint: string;
  extraArgs: string[];
  envVars: string[];
  serverDir: string;
  windowsHiddenLauncherPath: string | null;
}): string {
  const nodeModulesPath = `node_modules/${input.packageName}/${input.entrypoint}`.replace(/\\/gu, '/');
  const envVarsLine = input.envVars.length > 0
    ? `\nenv_vars = [${input.envVars.map((name) => tomlString(name)).join(', ')}]`
    : '';
  if (input.windowsHiddenLauncherPath !== null) {
    return `${CONFIG_MARKER_PREFIX}${input.serverName}
[mcp_servers.${input.serverName}]
command = ${tomlString(input.windowsHiddenLauncherPath)}
args = [${['node', nodeModulesPath, ...input.extraArgs].map((arg) => tomlString(arg)).join(', ')}]
cwd = ${tomlString(input.serverDir)}${envVarsLine}
${CONFIG_MARKER_END}`;
  }
  return `${CONFIG_MARKER_PREFIX}${input.serverName}
[mcp_servers.${input.serverName}]
command = "node"
args = [${[nodeModulesPath, ...input.extraArgs].map((arg) => tomlString(arg)).join(', ')}]
cwd = ${tomlString(input.serverDir)}${envVarsLine}
${CONFIG_MARKER_END}`;
}

function assertManagedDirInsideState(stateDir: string, target: string): void {
  const resolvedState = resolve(stateDir);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedState, resolvedTarget);
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`Managed global MCP path escapes state directory: ${target}`);
  }
}

export function buildGlobalMcpAddNpmPayload(
  input: GlobalMcpAddNpmInput,
  deps: {
    npmRunner?: GlobalMcpNpmRunner;
    prepareWindowsHiddenLauncher?: (directory: string, dryRun: boolean) => string | null;
    operationStore?: OperationStore;
  } = {},
): Record<string, unknown> {
  const parsed = globalMcpAddNpmInputObject.parse(input);
  const configPath = resolveInputPath(parsed.configPath, defaultConfigPath());
  const stateDir = resolveInputPath(parsed.stateDir, defaultGlobalStateDir());
  const packageName = parseRegistryPackageName(parsed.packageSpec);
  if (packageName === null) throw new Error(`Unsupported npm package spec: ${parsed.packageSpec}`);

  const serverName = parsed.serverName ?? defaultServerName(packageName);
  serverNameSchema.parse(serverName);
  const serverDir = join(stateDir, 'mcps', safePackageDirName(serverName));
  assertManagedDirInsideState(stateDir, serverDir);
  const cacheDir = join(stateDir, '.npm-cache');
  const dryRun = parsed.dryRun ?? true;
  const confirm = parsed.confirm === true;
  const allowScripts = parsed.allowScripts === true;
  const extraArgs = parsed.extraArgs ?? [DEFAULT_TRANSPORT_ARG];
  const envVars = uniqueSorted(parsed.envVars ?? []);
  const installArgs = npmInstallArgs({ packageSpec: parsed.packageSpec, allowScripts, cacheDir });
  const configCurrent = readTextIfExists(configPath);
  assertNoUnmanagedServerConflict(configCurrent, serverName);
  const prepareLauncher = deps.prepareWindowsHiddenLauncher ?? prepareWindowsHiddenLauncherForDirectory;
  const windowsHiddenLauncherPath = prepareLauncher(stateDir, true);
  const paths = { stateDir, configPath };
  const actions: GlobalMcpAction[] = [
    {
      kind: existsSync(serverDir) ? 'update' : 'create',
      target: previewPath(serverDir, paths),
      reason: 'prepare isolated user-global npm MCP package directory',
    },
    {
      kind: 'run',
      target: previewPath(serverDir, paths),
      reason: 'install npm MCP package into isolated user-global runtime',
      command: ['npm', ...installArgs],
    },
  ];

  if (windowsHiddenLauncherPath !== null) {
    actions.push({
      kind: existsSync(windowsHiddenLauncherPath) ? 'update' : 'create',
      target: previewPath(windowsHiddenLauncherPath, paths),
      reason: 'prepare Windows hidden MCP stdio launcher for global MCP process',
    });
  }

  if (dryRun) {
    actions.push({
      kind: configCurrent === null ? 'create' : 'update',
      target: previewPath(configPath, paths),
      reason: 'register user-global Codex MCP server after package entrypoint resolution',
    });
    return {
      ok: true,
      scope: 'global',
      dryRun: true,
      confirmRequired: !confirm,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      serverDir: previewPath(serverDir, paths),
      envVars,
      lifecycleScriptsAllowed: allowScripts,
      actions,
      warnings: warningsFor({ envVars, global: true }),
      nextAction: nextActionFor({ serverName, envVars, dryRun: true }),
    };
  }

  if (!confirm) {
    actions.push({
      kind: configCurrent === null ? 'create' : 'update',
      target: previewPath(configPath, paths),
      reason: 'register user-global Codex MCP server after package entrypoint resolution',
    });
    return {
      ok: false,
      refused: true,
      scope: 'global',
      dryRun: false,
      confirmRequired: true,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      serverDir: previewPath(serverDir, paths),
      envVars,
      lifecycleScriptsAllowed: allowScripts,
      actions,
      warnings: warningsFor({ envVars, global: true }),
      message: 'Pass confirm:true with dryRun:false to install an npm MCP package and update user-global Codex config.',
    };
  }

  const store = deps.operationStore ?? new OperationStore({ workspace: process.cwd() });
  const operation = store.create({
    kind: 'global_mcp_add_npm',
    status: 'running',
    evidence: {
      scope: 'global',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      envVars,
      lifecycleScriptsAllowed: allowScripts,
    },
    nextAction: 'Install npm package into isolated global MCP runtime and update user Codex config.',
  });

  try {
    mkdirSync(serverDir, { recursive: true });
    const packageJsonPath = join(serverDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      writeFileSync(packageJsonPath, minimalPackageJson(serverName), 'utf8');
    }

    const runner = deps.npmRunner ?? runNpm;
    const npmResult = runner(installArgs, { cwd: serverDir });
    if (npmResult.error !== undefined || npmResult.status !== 0) {
      const reason = (npmResult.error?.message ?? npmResult.stderr.trim()) || 'unknown error';
      throw userError({
        code: 'npm_install_failed',
        message: `npm install failed for ${parsed.packageSpec}: ${reason}`,
        parameter: 'packageSpec',
        received: parsed.packageSpec,
        expected: 'An installable npm registry package spec and a working npm environment.',
        examples: ['codex-agent-session-manager mcp global add npm @modelcontextprotocol/server-everything --dry-run'],
        suggestions: [
          { label: 'Validate the package name', command: `npm view ${parsed.packageSpec} version` },
          { label: 'Retry as dry-run first', command: `codex-agent-session-manager mcp global add npm ${parsed.packageSpec} --dry-run` },
          { label: 'Review lifecycle scripts before enabling them', details: 'Use allowScripts:true only after reviewing the package if generated/native assets are required.' },
        ],
        nextAction: 'Fix the npm/package failure, then retry with dryRun:false and confirm:true. Remember global MCP installs affect Codex sessions outside this workspace until removed.',
      });
    }

    const packageInfo = resolveInstalledPackage({ serverDir, packageName, entrypoint: parsed.entrypoint });
    const lifecycleScriptsSuppressed = packageInfo.lifecycleScripts.length > 0 && !allowScripts;
    const preparedLauncherPath = prepareLauncher(stateDir, false);
    const configNext = upsertManagedConfigBlock(
      configCurrent,
      serverName,
      mcpServerBlock({
        serverName,
        packageName: packageInfo.packageName,
        entrypoint: packageInfo.entrypoint,
        extraArgs,
        envVars,
        serverDir,
        windowsHiddenLauncherPath: preparedLauncherPath,
      }),
    );
    actions.push(actionForFile(configPath, configCurrent, configNext, paths, 'register user-global Codex MCP server'));
    if (configCurrent !== configNext) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, configNext, 'utf8');
    }

    const payload = {
      ok: true,
      scope: 'global',
      dryRun: false,
      confirmRequired: false,
      operationId: operation.id,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      serverDir: previewPath(serverDir, paths),
      envVars,
      lifecycleScriptsAllowed: allowScripts,
      packageLifecycleScripts: packageInfo.lifecycleScripts,
      lifecycleScriptsSuppressed,
      command: preparedLauncherPath === null ? 'node' : previewPath(preparedLauncherPath, paths),
      args: preparedLauncherPath === null
        ? [`node_modules/${packageInfo.packageName}/${packageInfo.entrypoint}`, ...extraArgs]
        : ['node', `node_modules/${packageInfo.packageName}/${packageInfo.entrypoint}`, ...extraArgs],
      actions,
      npm: {
        status: npmResult.status,
        stdoutIncluded: npmResult.stdout.length > 0,
        stderrIncluded: npmResult.stderr.length > 0,
      },
      warnings: warningsFor({ envVars, lifecycleScriptsSuppressed, global: true }),
      nextAction: nextActionFor({ serverName, envVars, dryRun: false }),
    };
    store.complete(operation.id, {
      evidence: {
        scope: 'global',
        packageName,
        serverName,
        serverDir: previewPath(serverDir, paths),
        configChanged: configCurrent !== configNext,
        actions,
      },
      nextAction: payload.nextAction,
    });
    return payload;
  } catch (error) {
    store.fail(operation.id, {
      failure: error instanceof Error ? { message: error.message } : { message: String(error) },
      evidence: {
        scope: 'global',
        packageSpec: parsed.packageSpec,
        packageName,
        serverName,
        serverDir: previewPath(serverDir, paths),
        actions,
      },
      nextAction: 'Fix the failed global MCP add operation, then retry with dryRun:false and confirm:true.',
    });
    throw error;
  }
}

export function buildGlobalMcpRemovePayload(
  input: GlobalMcpRemoveInput,
  deps: {
    operationStore?: OperationStore;
  } = {},
): Record<string, unknown> {
  const parsed = globalMcpRemoveInputObject.parse(input);
  const configPath = resolveInputPath(parsed.configPath, defaultConfigPath());
  const stateDir = resolveInputPath(parsed.stateDir, defaultGlobalStateDir());
  const dryRun = parsed.dryRun ?? true;
  const confirm = parsed.confirm === true;
  const uninstallPackage = parsed.uninstallPackage === true;
  const configCurrent = readTextIfExists(configPath);
  const blocks = configCurrent === null ? [] : managedBlocks(configCurrent);
  const targetBlock = blocks.find((block) => block.serverName === parsed.serverName) ?? null;
  const configNext = configCurrent !== null && targetBlock !== null ? removeManagedBlock(configCurrent, targetBlock) : configCurrent;
  const serverDir = targetBlock?.serverDir !== null && targetBlock?.serverDir !== undefined
    ? resolve(targetBlock.serverDir)
    : join(stateDir, 'mcps', safePackageDirName(parsed.serverName));
  assertManagedDirInsideState(stateDir, serverDir);
  const paths = { stateDir, configPath };
  const actions: GlobalMcpAction[] = [
    actionForFile(configPath, configCurrent, configNext, paths, 'remove managed user-global Codex MCP server block'),
  ];
  const warnings: string[] = [];

  if (uninstallPackage && targetBlock === null) {
    warnings.push('No managed global MCP server block was found, so no package directory removal was scheduled.');
  }
  if (targetBlock !== null && uninstallPackage) {
    actions.push({
      kind: existsSync(serverDir) ? 'delete' : 'noop',
      target: previewPath(serverDir, paths),
      reason: 'remove isolated user-global MCP package directory',
    });
  } else if (targetBlock !== null) {
    actions.push({
      kind: 'skip',
      target: previewPath(serverDir, paths),
      reason: 'package directory removal requires uninstallPackage:true',
    });
  }

  if (dryRun) {
    return {
      ok: true,
      scope: 'global',
      dryRun: true,
      confirmRequired: !confirm,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName: targetBlock?.packageName ?? null,
      serverDir: previewPath(serverDir, paths),
      uninstallPackage,
      actions,
      warnings,
      nextAction: targetBlock === null
        ? missingGlobalServerNextAction(parsed.serverName)
        : 'Run with dryRun:false and confirm:true to remove the managed global MCP config block. Then reload/restart affected Codex App Servers and validate the callable catalog.',
    };
  }

  if (!confirm) {
    return {
      ok: false,
      refused: true,
      scope: 'global',
      dryRun: false,
      confirmRequired: true,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName: targetBlock?.packageName ?? null,
      serverDir: previewPath(serverDir, paths),
      uninstallPackage,
      actions,
      warnings,
      message: 'Pass confirm:true with dryRun:false to remove a managed global MCP server block.',
    };
  }

  const store = deps.operationStore ?? new OperationStore({ workspace: process.cwd() });
  const operation = store.create({
    kind: 'global_mcp_remove',
    status: 'running',
    evidence: {
      scope: 'global',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName: targetBlock?.packageName ?? null,
      uninstallPackage,
      serverDir: previewPath(serverDir, paths),
    },
    nextAction: 'Remove managed user-global MCP config and optional isolated runtime.',
  });

  try {
    if (configCurrent !== configNext) {
      if (configNext === null) {
        rmSync(configPath, { force: true });
      } else {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, configNext, 'utf8');
      }
    }
    if (targetBlock !== null && uninstallPackage && existsSync(serverDir)) {
      rmSync(serverDir, { recursive: true, force: true });
    }

    const nextAction = targetBlock === null
      ? missingGlobalServerNextAction(parsed.serverName)
      : 'Reload/restart affected Codex App Servers and validate that the removed global MCP namespace is absent from the callable catalog.';
    const payload = {
      ok: true,
      scope: 'global',
      dryRun: false,
      confirmRequired: false,
      operationId: operation.id,
      configPath: '<user-codex-config>',
      stateDir: '<global-state>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName: targetBlock?.packageName ?? null,
      serverDir: previewPath(serverDir, paths),
      uninstallPackage,
      actions,
      warnings,
      nextAction,
    };
    store.complete(operation.id, {
      evidence: {
        scope: 'global',
        serverName: parsed.serverName,
        found: targetBlock !== null,
        packageName: targetBlock?.packageName ?? null,
        uninstallPackage,
        serverDir: previewPath(serverDir, paths),
        configChanged: configCurrent !== configNext,
        actions,
      },
      nextAction,
    });
    return payload;
  } catch (error) {
    store.fail(operation.id, {
      failure: error instanceof Error ? { message: error.message } : { message: String(error) },
      evidence: {
        scope: 'global',
        serverName: parsed.serverName,
        found: targetBlock !== null,
        packageName: targetBlock?.packageName ?? null,
        uninstallPackage,
        serverDir: previewPath(serverDir, paths),
        actions,
      },
      nextAction: 'Fix the failed global MCP remove operation, then retry with dryRun:false and confirm:true.',
    });
    throw error;
  }
}
