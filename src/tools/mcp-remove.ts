import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { runNpm, type NpmRunResult } from '../npm.js';
import { redactValue } from '../security/redaction.js';
import { assertWorkspacePath, resolveWorkspaceRoot, workspacePath } from '../security/workspace.js';
import { OperationStore } from './operations.js';

const CONFIG_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:mcp-add:';
const CONFIG_MARKER_END = '# END codex-agent-session-manager:mcp-add';

const serverNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .describe('Managed project-scoped MCP server name to remove from .codex/config.toml.');

export const localMcpRemoveInputSchema = {
  serverName: serverNameSchema,
  uninstallPackage: z
    .boolean()
    .optional()
    .describe('When true, also runs npm uninstall -D for the package inferred from the managed config block. Defaults false.'),
  dryRun: z.boolean().optional().describe('Defaults true. Preview config/package removal without changing files.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

const localMcpRemoveInputObject = z.object(localMcpRemoveInputSchema);
type LocalMcpRemoveInput = z.infer<typeof localMcpRemoveInputObject>;

export type NpmRemoveRunner = (args: readonly string[], options: { cwd: string }) => NpmRunResult;

interface McpRemoveAction {
  kind: 'delete' | 'update' | 'noop' | 'run' | 'skip';
  target: string;
  reason: string;
  command?: string[];
}

interface ManagedBlock {
  serverName: string;
  startIndex: number;
  endIndex: number;
  block: string;
  packageName: string | null;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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

function finalizeFileContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return ensureTrailingNewline(content.trimEnd());
}

function inferManagedMcpPackageName(block: string): string | null {
  const normalized = block.replace(/\\/gu, '/');
  const match = /node_modules\/((?:@[^/"\s]+\/)?[^/"\s]+)/u.exec(normalized);
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

function npmUninstallArgs(packageName: string): string[] {
  return ['uninstall', '-D', '--no-audit', '--no-fund', '--cache', './.npm-cache', packageName];
}

function packageUsedByOtherManagedServer(content: string | null, removedServerName: string, packageName: string | null): boolean {
  if (content === null || packageName === null) return false;
  return managedBlocks(content).some((block) => block.serverName !== removedServerName && block.packageName === packageName);
}

function missingLocalServerNextAction(serverName: string): string {
  return `No managed project-local MCP block was found for serverName "${serverName}". Call codex_mcp_cleanup_report with includeGlobal:false, inspect local.managedServers[].serverName, then retry with the exact managed serverName. If the block is unmanaged, remove it manually from .codex/config.toml or choose the matching local/global remove tool.`;
}

function configAction(input: {
  configPath: string;
  current: string | null;
  next: string | null;
  workspace: string;
}): McpRemoveAction {
  const target = previewPath(input.configPath, input.workspace);
  if (input.current === null && input.next === null) return { kind: 'noop', target, reason: 'project MCP config not found' };
  if (input.current === input.next) return { kind: 'noop', target, reason: 'managed MCP server block not found' };
  if (input.next === null) return { kind: 'delete', target, reason: 'remove managed project MCP config file after deleting server block' };
  return { kind: 'update', target, reason: 'remove managed project MCP server block' };
}

export function buildLocalMcpRemovePayload(
  input: LocalMcpRemoveInput,
  deps: {
    npmRunner?: NpmRemoveRunner;
    operationStore?: OperationStore;
  } = {},
): Record<string, unknown> {
  const parsed = localMcpRemoveInputObject.parse(input);
  const workspace = resolveWorkspaceRoot(process.cwd());
  const dryRun = parsed.dryRun ?? true;
  const confirm = parsed.confirm === true;
  const uninstallPackage = parsed.uninstallPackage === true;
  const configPath = workspacePath(workspace, '.codex', 'config.toml');
  const configCurrent = readTextIfExists(configPath);
  const blocks = configCurrent === null ? [] : managedBlocks(configCurrent);
  const targetBlock = blocks.find((block) => block.serverName === parsed.serverName) ?? null;
  const configNext = configCurrent !== null && targetBlock !== null
    ? removeManagedBlock(configCurrent, targetBlock)
    : configCurrent;
  const packageName = targetBlock?.packageName ?? null;
  const packageShared = packageUsedByOtherManagedServer(configCurrent, parsed.serverName, packageName);
  const actions: McpRemoveAction[] = [
    configAction({ configPath, current: configCurrent, next: configNext, workspace }),
  ];
  const warnings: string[] = [];

  const shouldUninstallPackage = uninstallPackage && packageName !== null && !packageShared && targetBlock !== null;
  if (uninstallPackage && targetBlock === null) {
    warnings.push('No managed MCP server block was found, so no package uninstall was scheduled.');
  } else if (uninstallPackage && packageName === null) {
    warnings.push('The managed MCP block did not contain an inferable node_modules package path; package uninstall was skipped.');
  } else if (uninstallPackage && packageShared) {
    warnings.push(`Package ${packageName} is still referenced by another managed MCP block; package uninstall was skipped.`);
  }

  if (shouldUninstallPackage && packageName !== null) {
    actions.push({
      kind: 'run',
      target: '<workspace>',
      reason: 'uninstall npm MCP package from project devDependencies',
      command: ['npm', ...npmUninstallArgs(packageName)],
    });
  } else if (targetBlock !== null && packageName !== null) {
    actions.push({
      kind: 'skip',
      target: '<workspace>',
      reason: 'package uninstall requires uninstallPackage:true and no other managed MCP block reference',
      command: ['npm', ...npmUninstallArgs(packageName)],
    });
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmRequired: !confirm,
      workspace: '<workspace>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName,
      uninstallPackage,
      packageShared,
      actions,
      warnings,
      nextAction: targetBlock === null
        ? missingLocalServerNextAction(parsed.serverName)
        : 'Run with dryRun:false and confirm:true to remove the managed MCP config block. Then use codex_mcp_refresh with an explicit threadId to reload MCP processes and validate the callable catalog.',
    };
  }

  if (!confirm) {
    return {
      ok: false,
      refused: true,
      dryRun: false,
      confirmRequired: true,
      workspace: '<workspace>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName,
      uninstallPackage,
      packageShared,
      actions,
      warnings,
      message: 'Pass confirm:true with dryRun:false to remove a managed MCP server block.',
    };
  }

  const store = deps.operationStore ?? new OperationStore({ workspace });
  const operation = store.create({
    kind: 'local_mcp_remove',
    status: 'running',
    evidence: {
      scope: 'local',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName,
      uninstallPackage,
      packageShared,
    },
    nextAction: 'Remove managed project MCP config and optional package.',
  });

  try {
    if (configCurrent !== configNext) {
      assertWorkspacePath(workspace, configPath);
      if (configNext === null) {
        unlinkSync(configPath);
      } else {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, configNext, 'utf8');
      }
    }

    let npm: Record<string, unknown> | null = null;
    if (shouldUninstallPackage && packageName !== null) {
      const uninstallArgs = npmUninstallArgs(packageName);
      const runner = deps.npmRunner ?? runNpm;
      const npmResult = runner(uninstallArgs, { cwd: workspace });
      if (npmResult.error !== undefined || npmResult.status !== 0) {
        const reason = (npmResult.error?.message ?? npmResult.stderr.trim()) || 'unknown error';
        throw new Error(`npm uninstall failed for ${packageName}: ${reason}`);
      }
      npm = {
        status: npmResult.status,
        stdoutIncluded: npmResult.stdout.length > 0,
        stderrIncluded: npmResult.stderr.length > 0,
      };
    }

    const nextAction = targetBlock === null
      ? missingLocalServerNextAction(parsed.serverName)
      : 'Use codex_mcp_refresh with an explicit threadId to reload MCP processes and validate that the removed tool namespace is absent from the callable catalog.';
    const payload = {
      ok: true,
      dryRun: false,
      confirmRequired: false,
      operationId: operation.id,
      workspace: '<workspace>',
      serverName: parsed.serverName,
      found: targetBlock !== null,
      packageName,
      uninstallPackage,
      packageShared,
      actions,
      ...(npm === null ? {} : { npm }),
      warnings,
      nextAction,
    };
    store.complete(operation.id, {
      evidence: {
        scope: 'local',
        serverName: parsed.serverName,
        found: targetBlock !== null,
        packageName,
        uninstallPackage,
        packageShared,
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
        scope: 'local',
        serverName: parsed.serverName,
        found: targetBlock !== null,
        packageName,
        uninstallPackage,
        packageShared,
        actions,
      },
      nextAction: 'Fix the failed local MCP remove operation, then retry with dryRun:false and confirm:true.',
    });
    throw error;
  }
}
