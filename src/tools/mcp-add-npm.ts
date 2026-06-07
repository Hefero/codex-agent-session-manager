import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';

import { redactValue } from '../security/redaction.js';
import { assertWorkspacePath, resolveWorkspaceRoot, workspacePath } from '../security/workspace.js';

const DEFAULT_TRANSPORT_ARG = 'stdio';
const CONFIG_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:mcp-add:';
const CONFIG_MARKER_END = '# END codex-agent-session-manager:mcp-add';
const MAX_PACKAGE_SPEC_CHARS = 200;
const MAX_ENTRYPOINT_CHARS = 300;
const MAX_EXTRA_ARGS = 20;

const packageSpecSchema = z
  .string()
  .min(1)
  .max(MAX_PACKAGE_SPEC_CHARS)
  .refine((value) => parseRegistryPackageName(value) !== null, {
    message: 'Only npm registry package specs are supported, for example @scope/name or name@version.',
  })
  .describe('npm registry package spec to install locally, for example @modelcontextprotocol/server-everything.');

const serverNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .describe('Project-scoped Codex MCP server name to add under .codex/config.toml.');

export const mcpAddNpmInputSchema = {
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
  dryRun: z.boolean().optional().describe('Defaults true. Preview the local npm install and project config update without changing files.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

const mcpAddNpmInputObject = z.object(mcpAddNpmInputSchema);
type McpAddNpmInput = z.infer<typeof mcpAddNpmInputObject>;

export interface NpmRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type NpmRunner = (args: readonly string[], options: { cwd: string }) => NpmRunResult;

interface McpAddNpmAction {
  kind: 'create' | 'update' | 'noop' | 'run';
  target: string;
  reason: string;
  command?: string[];
}

interface PackageInfo {
  packageName: string;
  entrypoint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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

function previewPath(path: string, workspace: string): string {
  const normalizedWorkspace = workspace.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath === normalizedWorkspace) return '<workspace>';
  if (normalizedPath.startsWith(`${normalizedWorkspace}\\`) || normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return `<workspace>${path.slice(workspace.length)}`;
  }
  return String(redactValue(path, { workspace }));
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

function npmSpawnCommand(args: readonly string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] };
  }
  return { command: 'npm', args: [...args] };
}

function runNpm(args: readonly string[], options: { cwd: string }): NpmRunResult {
  const command = npmSpawnCommand(args);
  const result = spawnSync(command.command, command.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function packageJsonPathFor(workspace: string, packageName: string): string {
  return workspacePath(workspace, 'node_modules', ...packageName.split('/'), 'package.json');
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

function resolveInstalledPackage(input: { workspace: string; packageName: string; entrypoint?: string | undefined }): PackageInfo {
  const packageJsonPath = packageJsonPathFor(input.workspace, input.packageName);
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package metadata was not found at ${previewPath(packageJsonPath, input.workspace)}.`);
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
  };
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function mcpServerBlock(input: { serverName: string; packageName: string; entrypoint: string; extraArgs: string[] }): string {
  const nodeModulesPath = `node_modules/${input.packageName}/${input.entrypoint}`.replace(/\\/gu, '/');
  const args = [nodeModulesPath, ...input.extraArgs];
  return `${CONFIG_MARKER_PREFIX}${input.serverName}
[mcp_servers.${input.serverName}]
command = "node"
args = [${args.map((arg) => jsonString(arg)).join(', ')}]
${CONFIG_MARKER_END}`;
}

function replaceMarkedBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Found ${start} without ${end}.`);

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  return ensureTrailingNewline([before, block, after].filter((part) => part.length > 0).join('\n\n'));
}

function hasUnmanagedServerSection(content: string, serverName: string): boolean {
  const sectionPattern = new RegExp(`^\\s*\\[mcp_servers\\.${serverName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\]\\s*$`, 'mu');
  return sectionPattern.test(content);
}

function hasManagedServerBlock(content: string, serverName: string): boolean {
  return content.includes(`${CONFIG_MARKER_PREFIX}${serverName}`);
}

function assertNoUnmanagedServerConflict(content: string | null, serverName: string): void {
  if (content !== null && !hasManagedServerBlock(content, serverName) && hasUnmanagedServerSection(content, serverName)) {
    throw new Error(`.codex/config.toml already has an unmanaged [mcp_servers.${serverName}] section. Choose another serverName or edit it manually.`);
  }
}

function upsertMcpAddConfig(content: string | null, serverName: string, block: string): string {
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);

  const marked = replaceMarkedBlock(content, `${CONFIG_MARKER_PREFIX}${serverName}`, CONFIG_MARKER_END, block);
  if (marked !== null) return marked;

  assertNoUnmanagedServerConflict(content, serverName);

  return ensureTrailingNewline(`${content.trimEnd()}\n\n${block}`);
}

function actionForFile(path: string, current: string | null, next: string, workspace: string, reason: string): McpAddNpmAction {
  if (current === next) return { kind: 'noop', target: previewPath(path, workspace), reason };
  return { kind: current === null ? 'create' : 'update', target: previewPath(path, workspace), reason };
}

export function buildMcpAddNpmPayload(
  input: McpAddNpmInput,
  deps: {
    npmRunner?: NpmRunner;
  } = {},
): Record<string, unknown> {
  const parsed = mcpAddNpmInputObject.parse(input);
  const workspace = resolveWorkspaceRoot(process.cwd());
  const packageName = parseRegistryPackageName(parsed.packageSpec);
  if (packageName === null) throw new Error(`Unsupported npm package spec: ${parsed.packageSpec}`);

  const serverName = parsed.serverName ?? defaultServerName(packageName);
  serverNameSchema.parse(serverName);

  const dryRun = parsed.dryRun ?? true;
  const confirm = parsed.confirm === true;
  const extraArgs = parsed.extraArgs ?? [DEFAULT_TRANSPORT_ARG];
  const actions: McpAddNpmAction[] = [];
  const configPath = workspacePath(workspace, '.codex', 'config.toml');
  const configCurrent = readTextIfExists(configPath);
  assertNoUnmanagedServerConflict(configCurrent, serverName);

  const packageJsonPath = workspacePath(workspace, 'package.json');
  const packageJsonCurrent = readTextIfExists(packageJsonPath);
  const packageJsonNext = packageJsonCurrent ?? minimalPackageJson(workspace);
  actions.push(actionForFile(packageJsonPath, packageJsonCurrent, packageJsonNext, workspace, 'ensure local npm project metadata exists'));
  actions.push({
    kind: 'run',
    target: '<workspace>',
    reason: 'install npm MCP package as a project devDependency',
    command: ['npm', 'install', '--save-dev', parsed.packageSpec],
  });

  if (dryRun) {
    const configTarget = previewPath(configPath, workspace);
    actions.push({
      kind: 'update',
      target: configTarget,
      reason: 'register project-scoped Codex MCP server after package entrypoint resolution',
    });
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      workspace: '<workspace>',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      actions,
      nextAction: 'Run with dryRun:false and confirm:true, then call codex_mcp_refresh with an explicit threadId and let the current turn finish so the continuation can call the new MCP tool.',
    };
  }

  if (!confirm) {
    actions.push({
      kind: 'update',
      target: previewPath(configPath, workspace),
      reason: 'register project-scoped Codex MCP server after package entrypoint resolution',
    });
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      workspace: '<workspace>',
      packageSpec: parsed.packageSpec,
      packageName,
      serverName,
      actions,
      message: 'Pass confirm:true with dryRun:false to install an npm MCP package and update project config.',
    };
  }

  if (packageJsonCurrent === null) {
    assertWorkspacePath(workspace, packageJsonPath);
    writeFileSync(packageJsonPath, packageJsonNext, 'utf8');
  }

  assertWorkspacePath(workspace, workspacePath(workspace, 'node_modules'));
  const runner = deps.npmRunner ?? runNpm;
  const npmResult = runner(['install', '--save-dev', parsed.packageSpec], { cwd: workspace });
  if (npmResult.error !== undefined || npmResult.status !== 0) {
    const reason = (npmResult.error?.message ?? npmResult.stderr.trim()) || 'unknown error';
    throw new Error(`npm install failed for ${parsed.packageSpec}: ${reason}`);
  }

  const packageInfo = resolveInstalledPackage({
    workspace,
    packageName,
    entrypoint: parsed.entrypoint,
  });

  const configNext = upsertMcpAddConfig(
    configCurrent,
    serverName,
    mcpServerBlock({
      serverName,
      packageName: packageInfo.packageName,
      entrypoint: packageInfo.entrypoint,
      extraArgs,
    }),
  );
  actions.push(actionForFile(configPath, configCurrent, configNext, workspace, 'register project-scoped Codex MCP server'));
  if (configCurrent !== configNext) {
    assertWorkspacePath(workspace, configPath);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, configNext, 'utf8');
  }

  return {
    ok: true,
    dryRun: false,
    confirmRequired: false,
    workspace: '<workspace>',
    packageSpec: parsed.packageSpec,
    packageName,
    serverName,
    command: 'node',
    args: [`node_modules/${packageInfo.packageName}/${packageInfo.entrypoint}`, ...extraArgs],
    actions,
    npm: {
      status: npmResult.status,
      stdoutIncluded: npmResult.stdout.length > 0,
      stderrIncluded: npmResult.stderr.length > 0,
    },
    nextAction: `Call codex_mcp_refresh with an explicit threadId, then finish the current turn. Final proof is a real call from the continuation to a tool under mcp__${serverName}.`,
  };
}
