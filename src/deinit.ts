import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { PRIMARY_STATE_DIR_NAME } from './app-server/state.js';
import { redactValue } from './security/redaction.js';
import { packageName } from './version.js';

const MCP_SERVER_NAME = 'codex_agent_session_manager';
const TOML_MARKER_START = '# BEGIN codex-agent-session-manager';
const TOML_MARKER_END = '# END codex-agent-session-manager';
const MCP_ADD_MARKER_PREFIX = '# BEGIN codex-agent-session-manager:mcp-add:';
const MCP_ADD_MARKER_END = '# END codex-agent-session-manager:mcp-add';
const AGENTS_MARKER_START = '<!-- codex-agent-session-manager:start -->';
const AGENTS_MARKER_END = '<!-- codex-agent-session-manager:end -->';

const GENERATED_SCRIPTS: Record<string, string> = {
  'codex:init': `${packageName} init`,
  'codex:init:dry-run': `${packageName} init --dry-run`,
  'codex:remote': `${packageName} remote`,
  'codex:remote:dry-run': `${packageName} remote --dry-run --no-resume`,
  'codex:app-server:status': `${packageName} app-server status`,
  'codex:app-server:stop': `${packageName} app-server stop --dry-run`,
};

type DeinitActionKind = 'delete' | 'update' | 'noop' | 'skip';

interface ParsedDeinitArgs {
  workspace?: string;
  confirm?: boolean;
  dryRun?: boolean;
  json?: boolean;
  removeRuntime?: boolean;
  removeAddedMcps?: boolean;
  help?: boolean;
}

interface FileUpdate {
  path: string;
  content: string | null;
  reason: string;
}

export interface DeinitAction {
  kind: DeinitActionKind;
  target: string;
  reason: string;
}

export interface DeinitPlan {
  ok: true;
  dryRun: boolean;
  workspace: string;
  actions: DeinitAction[];
  fileUpdates: FileUpdate[];
  directoryDeletes: string[];
  packagesToUninstall: string[];
}

export interface DeinitDeps {
  output?: (text: string) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager deinit [options]

Options:
  --workspace <path>     Target workspace. Defaults to current directory.
  --dry-run              Preview only. This is the default unless --confirm is passed.
  --confirm              Apply the teardown plan.
  --json                 Print machine-readable JSON output.
  --remove-runtime       Remove local .codex-agent-session-manager/ runtime state.
  --remove-added-mcps    Remove MCP server blocks created by "mcp add npm".
  --help                 Show this help.
`;
}

export function deinitUsage(): string {
  return usage();
}

export function parseDeinitArgs(argv: readonly string[]): ParsedDeinitArgs {
  const options: ParsedDeinitArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index] ?? '';
    const [name, inlineValue] = rawArg.startsWith('--') && rawArg.includes('=')
      ? rawArg.split(/=(.*)/su, 2)
      : [rawArg, undefined];
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

    switch (name) {
      case '--workspace':
        options.workspace = readValue();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--confirm':
        options.confirm = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--remove-runtime':
        options.removeRuntime = true;
        break;
      case '--remove-added-mcps':
        options.removeAddedMcps = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown deinit argument: ${rawArg}`);
    }
  }

  return options;
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

function removeMarkedBlock(content: string, start: string, end: string): string | null {
  const startIndex = findMarkerLine(content, start);
  if (startIndex < 0) return null;
  const endIndex = findMarkerLine(content, end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Found ${start} without ${end}.`);

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  const joined = [before, after].filter((part) => part.length > 0).join('\n\n');
  return joined.length > 0 ? ensureTrailingNewline(joined) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function finalizeFileContent(path: string, content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (path.endsWith('AGENTS.md') && trimmed === '# Project Agent Notes') return null;
  return ensureTrailingNewline(content.trimEnd());
}

function actionForFile(path: string, current: string | null, next: string | null, reason: string): DeinitAction {
  if (current === null && next === null) return { kind: 'noop', target: path, reason };
  if (current === next) return { kind: 'noop', target: path, reason };
  if (next === null) return { kind: 'delete', target: path, reason };
  return { kind: current === null ? 'update' : 'update', target: path, reason };
}

function maybeAddFileUpdate(plan: DeinitPlan, path: string, current: string | null, next: string | null, reason: string): void {
  const action = actionForFile(path, current, next, reason);
  plan.actions.push(action);
  if (action.kind === 'delete' || action.kind === 'update') {
    plan.fileUpdates.push({ path, content: next, reason });
  }
}

function removeManagedMcpConfig(content: string | null, removeAddedMcps: boolean): {
  next: string | null;
  removedAddedPackages: string[];
  removedAddedCount: number;
} {
  if (content === null) return { next: null, removedAddedPackages: [], removedAddedCount: 0 };

  let next = removeMarkedBlock(content, TOML_MARKER_START, TOML_MARKER_END) ?? content;
  let removedAddedCount = 0;
  const removedAddedPackages = new Set<string>();

  if (removeAddedMcps) {
    while (true) {
      const startIndex = next.indexOf(MCP_ADD_MARKER_PREFIX);
      if (startIndex < 0) break;
      const lineEndIndex = next.indexOf('\n', startIndex);
      const markerEndIndex = lineEndIndex >= 0 ? lineEndIndex : next.length;
      const blockEndMarkerIndex = next.indexOf(MCP_ADD_MARKER_END, markerEndIndex);
      if (blockEndMarkerIndex < 0) {
        throw new Error(`Found ${MCP_ADD_MARKER_PREFIX} without ${MCP_ADD_MARKER_END}.`);
      }

      const blockEndIndex = blockEndMarkerIndex + MCP_ADD_MARKER_END.length;
      const block = next.slice(startIndex, blockEndIndex);
      const packageName = inferManagedMcpPackageName(block);
      if (packageName !== null) removedAddedPackages.add(packageName);

      const before = next.slice(0, startIndex).trimEnd();
      const after = next.slice(blockEndIndex).trimStart();
      const joined = [before, after].filter((part) => part.length > 0).join('\n\n');
      next = joined.length > 0 ? ensureTrailingNewline(joined) : '';
      removedAddedCount += 1;
    }
  }

  return {
    next: finalizeFileContent('config.toml', next),
    removedAddedPackages: [...removedAddedPackages].sort(),
    removedAddedCount,
  };
}

function inferManagedMcpPackageName(block: string): string | null {
  const normalized = block.replace(/\\/gu, '/');
  const match = /node_modules\/((?:@[^/"\s]+\/)?[^/"\s]+)/u.exec(normalized);
  return match?.[1] ?? null;
}

function removeGeneratedGitignoreEntry(content: string | null): string | null {
  if (content === null) return null;
  const lines = content.split(/\r?\n/u);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== `${PRIMARY_STATE_DIR_NAME}/` && trimmed !== PRIMARY_STATE_DIR_NAME;
  });
  return finalizeFileContent('.gitignore', kept.join('\n'));
}

function removeGeneratedAgentsBlock(content: string | null): string | null {
  if (content === null) return null;
  const removed = removeMarkedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END);
  return removed === null ? content : finalizeFileContent('AGENTS.md', removed);
}

function removeGeneratedPackageScripts(content: string | null): string | null {
  if (content === null) return null;

  const parsed = JSON.parse(stripBom(content)) as unknown;
  if (!isRecord(parsed)) throw new Error('package.json must contain a JSON object.');

  const scripts = isRecord(parsed.scripts) ? { ...parsed.scripts } : null;
  let changed = false;
  if (scripts !== null) {
    for (const [name, command] of Object.entries(GENERATED_SCRIPTS)) {
      if (scripts[name] === command) {
        delete scripts[name];
        changed = true;
      }
    }
    if (Object.keys(scripts).length > 0) {
      parsed.scripts = scripts;
    } else if (changed) {
      delete parsed.scripts;
    }
  }

  return changed ? `${JSON.stringify(parsed, null, 2)}\n` : content;
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

function addRuntimeAction(plan: DeinitPlan, removeRuntime: boolean): void {
  const runtimePath = join(plan.workspace, PRIMARY_STATE_DIR_NAME);
  if (!removeRuntime) {
    plan.actions.push({
      kind: 'skip',
      target: runtimePath,
      reason: 'runtime state removal requires --remove-runtime',
    });
    return;
  }

  if (!existsSync(runtimePath)) {
    plan.actions.push({
      kind: 'noop',
      target: runtimePath,
      reason: 'runtime state directory not found',
    });
    return;
  }

  plan.actions.push({
    kind: 'delete',
    target: runtimePath,
    reason: 'remove local session-manager runtime state',
  });
  plan.directoryDeletes.push(runtimePath);
}

export function buildDeinitPlan(options: ParsedDeinitArgs = {}): DeinitPlan {
  const workspace = resolve(options.workspace ?? process.cwd());
  const dryRun = options.confirm === true ? options.dryRun === true : true;
  const plan: DeinitPlan = {
    ok: true,
    dryRun,
    workspace,
    actions: [],
    fileUpdates: [],
    directoryDeletes: [],
    packagesToUninstall: [packageName],
  };

  const codexConfigPath = join(workspace, '.codex', 'config.toml');
  const codexConfigCurrent = readTextIfExists(codexConfigPath);
  const configRemoval = removeManagedMcpConfig(codexConfigCurrent, options.removeAddedMcps === true);
  for (const packageToUninstall of configRemoval.removedAddedPackages) {
    if (!plan.packagesToUninstall.includes(packageToUninstall)) plan.packagesToUninstall.push(packageToUninstall);
  }
  maybeAddFileUpdate(
    plan,
    codexConfigPath,
    codexConfigCurrent,
    configRemoval.next,
    options.removeAddedMcps === true
      ? `remove session-manager and ${configRemoval.removedAddedCount} managed npm MCP config block(s)`
      : 'remove session-manager MCP config block',
  );
  if (options.removeAddedMcps !== true && codexConfigCurrent?.includes(MCP_ADD_MARKER_PREFIX)) {
    plan.actions.push({
      kind: 'skip',
      target: codexConfigPath,
      reason: 'managed npm MCP blocks were kept; pass --remove-added-mcps to remove them',
    });
  }

  const gitignorePath = join(workspace, '.gitignore');
  const gitignoreCurrent = readTextIfExists(gitignorePath);
  maybeAddFileUpdate(
    plan,
    gitignorePath,
    gitignoreCurrent,
    removeGeneratedGitignoreEntry(gitignoreCurrent),
    'remove local runtime ignore rule',
  );

  const packageJsonPath = join(workspace, 'package.json');
  const packageCurrent = readTextIfExists(packageJsonPath);
  maybeAddFileUpdate(
    plan,
    packageJsonPath,
    packageCurrent,
    removeGeneratedPackageScripts(packageCurrent),
    'remove generated npm scripts',
  );

  const agentsPath = join(workspace, 'AGENTS.md');
  const agentsCurrent = readTextIfExists(agentsPath);
  maybeAddFileUpdate(
    plan,
    agentsPath,
    agentsCurrent,
    removeGeneratedAgentsBlock(agentsCurrent),
    'remove agent operating notes',
  );

  addRuntimeAction(plan, options.removeRuntime === true);
  plan.packagesToUninstall.sort();
  return plan;
}

function assertWorkspaceDeletePath(workspace: string, target: string): void {
  const realWorkspace = realpathSync.native(workspace);
  const realTarget = realpathSync.native(target);
  const normalizedWorkspace = realWorkspace.toLowerCase();
  const normalizedTarget = realTarget.toLowerCase();
  if (
    normalizedTarget !== normalizedWorkspace
    && !normalizedTarget.startsWith(`${normalizedWorkspace}\\`)
    && !normalizedTarget.startsWith(`${normalizedWorkspace}/`)
  ) {
    throw new Error(`Refusing to delete path outside workspace: ${target}`);
  }
}

export function applyDeinitPlan(plan: DeinitPlan): void {
  if (plan.dryRun) return;

  for (const update of plan.fileUpdates) {
    if (update.content === null) {
      if (existsSync(update.path)) unlinkSync(update.path);
      continue;
    }
    mkdirSync(dirname(update.path), { recursive: true });
    writeFileSync(update.path, update.content, 'utf8');
  }

  for (const target of plan.directoryDeletes) {
    if (!existsSync(target)) continue;
    assertWorkspaceDeletePath(plan.workspace, target);
    rmSync(target, { recursive: true, force: true });
  }
}

export function deinitPlanPreview(plan: DeinitPlan, applied: boolean): Record<string, unknown> {
  return redactValue(
    {
      ok: plan.ok,
      applied,
      dryRun: plan.dryRun,
      workspace: '<workspace>',
      actions: plan.actions,
      packagesToUninstall: plan.packagesToUninstall,
      nextAction: `Run npm uninstall -D ${plan.packagesToUninstall.join(' ')} after deinit if those packages should be removed from package-lock.json and node_modules.`,
    },
    { workspace: plan.workspace },
  ) as Record<string, unknown>;
}

function formatHumanDeinitPlan(plan: DeinitPlan, applied: boolean): string {
  const lines = [
    `codex-agent-session-manager deinit ${plan.dryRun ? 'dry-run' : applied ? 'applied' : 'plan'}`,
    'workspace: <workspace>',
    '',
    'actions:',
  ];
  for (const action of plan.actions) {
    const kind = action.kind.padEnd(6, ' ');
    lines.push(`  ${kind} ${previewPath(action.target, plan.workspace)} - ${action.reason}`);
  }
  lines.push('', `packages to uninstall after deinit: ${plan.packagesToUninstall.join(', ')}`);
  if (plan.dryRun) {
    lines.push('', 'Dry run only; no files were changed. Pass --confirm to apply.');
  } else {
    lines.push('', `Next: npm uninstall -D ${plan.packagesToUninstall.join(' ')}`);
  }
  return lines.join('\n');
}

export async function runDeinitCommand(argv: readonly string[], deps: DeinitDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const options = parseDeinitArgs(argv);
  if (options.help === true) {
    output(usage().trimEnd());
    return 0;
  }

  const plan = buildDeinitPlan(options);
  applyDeinitPlan(plan);
  output(
    options.json === true
      ? JSON.stringify(deinitPlanPreview(plan, !plan.dryRun), null, 2)
      : formatHumanDeinitPlan(plan, !plan.dryRun),
  );
  return 0;
}
