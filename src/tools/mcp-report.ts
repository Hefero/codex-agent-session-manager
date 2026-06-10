import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { redactValue } from '../security/redaction.js';
import { resolveWorkspaceRoot, workspacePath } from '../security/workspace.js';
import { OperationStore, type OperationRecord } from './operations.js';

const LOCAL_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:mcp-add:';
const LOCAL_MARKER_END = '# END codex-agent-session-manager:mcp-add';
const GLOBAL_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:global-mcp-add:';
const GLOBAL_MARKER_END = '# END codex-agent-session-manager:global-mcp-add';
const GLOBAL_STATE_DIR_NAME = '.codex-agent-session-manager';

const optionalPathSchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('Advanced/testing path override.');

export const mcpCleanupReportInputSchema = {
  includeGlobal: z.boolean().optional().describe('Defaults true. Include managed user-global MCP config/runtime state.'),
  includeOperations: z.boolean().optional().describe('Defaults true. Include recent durable operation summary for this workspace.'),
  globalConfigPath: optionalPathSchema.describe('Advanced/testing path override for user-global Codex config.'),
  globalStateDir: optionalPathSchema.describe('Advanced/testing path override for user-global runtime state.'),
};

const mcpCleanupReportInputObject = z.object(mcpCleanupReportInputSchema);
type McpCleanupReportInput = z.infer<typeof mcpCleanupReportInputObject>;

interface ManagedBlock {
  serverName: string;
  packageName: string | null;
  serverDir: string | null;
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultGlobalConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function defaultGlobalStateDir(): string {
  return join(homedir(), GLOBAL_STATE_DIR_NAME);
}

function previewWorkspacePath(path: string, workspace: string): string {
  const normalizedWorkspace = workspace.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath === normalizedWorkspace) return '<workspace>';
  if (normalizedPath.startsWith(`${normalizedWorkspace}\\`) || normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return `<workspace>${path.slice(workspace.length)}`;
  }
  return String(redactValue(path, { workspace }));
}

function previewGlobalPath(path: string, input: { configPath: string; stateDir: string }): string {
  const normalizedConfig = input.configPath.toLowerCase();
  const normalizedState = input.stateDir.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath === normalizedConfig) return '<user-codex-config>';
  if (normalizedPath === normalizedState) return '<global-state>';
  if (normalizedPath.startsWith(`${normalizedState}\\`) || normalizedPath.startsWith(`${normalizedState}/`)) {
    return `<global-state>${path.slice(input.stateDir.length)}`;
  }
  return String(redactValue(path));
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

function inferManagedMcpPackageName(block: string): string | null {
  const normalized = block.replace(/\\/gu, '/');
  const match = /node_modules\/((?:@[^/"\s]+\/)?[^/"\s]+)/u.exec(normalized);
  return match?.[1] ?? null;
}

function inferManagedServerDir(block: string): string | null {
  const match = /^\s*cwd\s*=\s*"([^"]+)"\s*$/mu.exec(block);
  return match?.[1] ?? null;
}

function managedBlocks(content: string | null, prefix: string, end: string): ManagedBlock[] {
  if (content === null) return [];
  const blocks: ManagedBlock[] = [];
  let searchIndex = 0;
  while (true) {
    const startIndex = content.indexOf(prefix, searchIndex);
    if (startIndex < 0) break;
    const startsLine = startIndex === 0
      || content[startIndex - 1] === '\n'
      || (startIndex === 1 && content.charCodeAt(0) === 0xFEFF);
    if (!startsLine) {
      searchIndex = startIndex + prefix.length;
      continue;
    }
    const markerLineEnd = content.indexOf('\n', startIndex);
    const markerEndIndex = markerLineEnd >= 0 ? markerLineEnd : content.length;
    const markerLine = content.slice(startIndex, markerEndIndex).trim();
    const blockEndMarkerIndex = findMarkerLine(content, end, markerEndIndex);
    if (blockEndMarkerIndex < 0) break;
    const block = content.slice(startIndex, blockEndMarkerIndex + end.length);
    blocks.push({
      serverName: markerLine.slice(prefix.length),
      packageName: inferManagedMcpPackageName(block),
      serverDir: inferManagedServerDir(block),
    });
    searchIndex = blockEndMarkerIndex + end.length;
  }
  return blocks;
}

function readPackageJson(workspace: string): Record<string, unknown> {
  const path = workspacePath(workspace, 'package.json');
  const text = readTextIfExists(path);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dependencyNames(packageJson: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) {
    const value = packageJson[key];
    if (!isRecord(value)) continue;
    for (const name of Object.keys(value)) {
      names.add(name);
    }
  }
  return names;
}

function packageJsonPathFor(workspace: string, packageName: string): string {
  return workspacePath(workspace, 'node_modules', ...packageName.split('/'), 'package.json');
}

function safeRuntimeDirName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]+/gu, '_');
}

function listDirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path)
      .filter((entry) => {
        try {
          return statSync(join(path, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function summarizeOperations(operations: OperationRecord[]): Record<string, unknown> {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const operation of operations) {
    byKind[operation.kind] = (byKind[operation.kind] ?? 0) + 1;
    byStatus[operation.status] = (byStatus[operation.status] ?? 0) + 1;
  }
  return {
    count: operations.length,
    byKind,
    byStatus,
    recent: operations.slice(-10).reverse().map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      updatedAt: operation.updatedAt,
      nextAction: operation.nextAction,
    })),
  };
}

export function buildMcpCleanupReportPayload(
  input: McpCleanupReportInput,
  deps: {
    operationStore?: OperationStore;
  } = {},
): Record<string, unknown> {
  const parsed = mcpCleanupReportInputObject.parse(input);
  const workspace = resolveWorkspaceRoot(process.cwd());
  const includeGlobal = parsed.includeGlobal !== false;
  const includeOperations = parsed.includeOperations !== false;
  const localConfigPath = workspacePath(workspace, '.codex', 'config.toml');
  const localPackageJson = readPackageJson(workspace);
  const depsNames = dependencyNames(localPackageJson);
  const localBlocks = managedBlocks(readTextIfExists(localConfigPath), LOCAL_MARKER_PREFIX, LOCAL_MARKER_END);
  const warnings: string[] = [];

  const localServers = localBlocks.map((block) => {
    const installedPackageMetadata = block.packageName === null ? false : existsSync(packageJsonPathFor(workspace, block.packageName));
    if (block.packageName === null) {
      warnings.push(`Local managed MCP ${block.serverName} has no inferable npm package path.`);
    } else if (!depsNames.has(block.packageName)) {
      warnings.push(`Local managed MCP ${block.serverName} references ${block.packageName}, but package.json does not list it.`);
    } else if (!installedPackageMetadata) {
      warnings.push(`Local managed MCP ${block.serverName} references ${block.packageName}, but node_modules metadata is missing.`);
    }
    return {
      serverName: block.serverName,
      packageName: block.packageName,
      listedInPackageJson: block.packageName === null ? false : depsNames.has(block.packageName),
      installedPackageMetadata,
    };
  });

  const payload: Record<string, unknown> = {
    ok: true,
    workspace: '<workspace>',
    local: {
      configPath: previewWorkspacePath(localConfigPath, workspace),
      configExists: existsSync(localConfigPath),
      managedServerCount: localServers.length,
      managedServers: localServers,
    },
    warnings,
    nextActions: [
      'Use codex_local_mcp_remove or codex_global_mcp_remove for managed MCP cleanup; avoid raw config edits when possible.',
      'After config changes, use codex_mcp_refresh with an explicit threadId and prove callable catalog state from the continuation.',
    ],
  };

  if (includeGlobal) {
    const globalConfigPath = resolve(parsed.globalConfigPath ?? defaultGlobalConfigPath());
    const globalStateDir = resolve(parsed.globalStateDir ?? defaultGlobalStateDir());
    const globalPaths = { configPath: globalConfigPath, stateDir: globalStateDir };
    const globalBlocks = managedBlocks(readTextIfExists(globalConfigPath), GLOBAL_MARKER_PREFIX, GLOBAL_MARKER_END);
    const runtimeRoot = join(globalStateDir, 'mcps');
    const runtimeDirs = listDirectories(runtimeRoot);
    const expectedRuntimeNames = new Set(globalBlocks.map((block) => safeRuntimeDirName(block.serverName)));
    const orphanRuntimeDirs = runtimeDirs.filter((name) => !expectedRuntimeNames.has(name));
    for (const orphan of orphanRuntimeDirs) {
      warnings.push(`Global MCP runtime directory ${orphan} has no matching managed global config block.`);
    }
    payload.global = {
      configPath: previewGlobalPath(globalConfigPath, globalPaths),
      stateDir: previewGlobalPath(globalStateDir, globalPaths),
      configExists: existsSync(globalConfigPath),
      managedServerCount: globalBlocks.length,
      managedServers: globalBlocks.map((block) => ({
        serverName: block.serverName,
        packageName: block.packageName,
        serverDir: block.serverDir === null ? null : previewGlobalPath(resolve(block.serverDir), globalPaths),
        serverDirExists: block.serverDir === null ? false : existsSync(resolve(block.serverDir)),
      })),
      runtimeDirs: runtimeDirs.map((name) => `<global-state>\\mcps\\${name}`),
      orphanRuntimeDirs: orphanRuntimeDirs.map((name) => `<global-state>\\mcps\\${name}`),
    };
  }

  if (includeOperations) {
    const store = deps.operationStore ?? new OperationStore({ workspace });
    payload.operations = summarizeOperations(store.list());
  }

  return payload;
}
