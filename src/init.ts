import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PRIMARY_STATE_DIR_NAME } from './app-server/state.js';
import { prepareWindowsHiddenLauncherForWorkspace } from './remote.js';
import { redactValue } from './security/redaction.js';
import { assertWorkspacePath, resolveWorkspaceRoot, workspacePath } from './security/workspace.js';
import { packageName, packageVersion } from './version.js';

const MCP_SERVER_NAME = 'codex_agent_session_manager';
const TOML_MARKER_START = '# BEGIN codex-agent-session-manager';
const TOML_MARKER_END = '# END codex-agent-session-manager';
const AGENTS_MARKER_START = '<!-- codex-agent-session-manager:start -->';
const AGENTS_MARKER_END = '<!-- codex-agent-session-manager:end -->';

type InitActionKind = 'create' | 'update' | 'noop' | 'skip';

interface ParsedInitArgs {
  workspace?: string;
  dryRun?: boolean;
  agents?: boolean;
  json?: boolean;
  help?: boolean;
}

interface FileUpdate {
  path: string;
  content: string;
  reason: string;
}

export interface InitAction {
  kind: InitActionKind;
  target: string;
  reason: string;
}

export interface InitPlan {
  ok: true;
  dryRun: boolean;
  workspace: string;
  mcpServerName: string;
  actions: InitAction[];
  fileUpdates: FileUpdate[];
  windowsHiddenLauncherPath: string | null;
}

export interface InitDeps {
  output?: (text: string) => void;
}

function usage(): string {
  return `Usage:
  codex-agent-session-manager init [options]

Options:
  --workspace <path>   Target workspace. Defaults to current directory.
  --dry-run            Print the init plan without changing files.
  --json               Print machine-readable JSON output.
  --no-agents          Do not create or update AGENTS.md.
  --help               Show this help.
`;
}

export function initUsage(): string {
  return usage();
}

export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const options: ParsedInitArgs = { agents: true };

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
      case '--json':
        options.json = true;
        break;
      case '--no-agents':
        options.agents = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown init argument: ${rawArg}`);
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

function replaceMarkedBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = findMarkerLine(content, start);
  if (startIndex < 0) return null;
  const endIndex = findMarkerLine(content, end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Found ${start} without ${end}.`);

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  return ensureTrailingNewline([before, block, after].filter((part) => part.length > 0).join('\n\n'));
}

function appendBlock(content: string, block: string): string {
  const before = content.trimEnd();
  return ensureTrailingNewline(before.length > 0 ? `${before}\n\n${block}` : block);
}

function mcpConfigBlock(): string {
  return `${TOML_MARKER_START}
[mcp_servers.${MCP_SERVER_NAME}]
command = "${packageName}"
args = ["serve"]
${TOML_MARKER_END}`;
}

function upsertMcpConfig(content: string | null): string {
  const block = mcpConfigBlock();
  if (content === null || content.trim().length === 0) return ensureTrailingNewline(block);

  const marked = replaceMarkedBlock(content, TOML_MARKER_START, TOML_MARKER_END, block);
  if (marked !== null) return marked;

  const lines = content.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line.trim() === `[mcp_servers.${MCP_SERVER_NAME}]`);
  if (sectionIndex >= 0) {
    const nextSectionIndex = lines.findIndex((line, index) => index > sectionIndex && /^\s*\[[^\]]+\]\s*$/u.test(line));
    const endIndex = nextSectionIndex >= 0 ? nextSectionIndex : lines.length;
    lines.splice(sectionIndex, endIndex - sectionIndex, ...block.split('\n'));
    return ensureTrailingNewline(lines.join('\n').trimEnd());
  }

  return appendBlock(content, block);
}

function gitignoreContent(content: string | null): string {
  const entry = `${PRIMARY_STATE_DIR_NAME}/`;
  if (content === null || content.trim().length === 0) return `${entry}\n`;
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(PRIMARY_STATE_DIR_NAME)) return ensureTrailingNewline(content);
  return ensureTrailingNewline(`${content.trimEnd()}\n${entry}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function packageJsonContent(content: string | null): string | null {
  if (content === null) return null;

  const parsed = JSON.parse(stripBom(content)) as unknown;
  if (!isRecord(parsed)) throw new Error('package.json must contain a JSON object.');

  const scripts = { ...recordFrom(parsed.scripts) };
  const wantedScripts: Record<string, string> = {
    'codex:init': `${packageName} init`,
    'codex:init:dry-run': `${packageName} init --dry-run`,
    'codex:remote': `${packageName} remote`,
    'codex:remote:dry-run': `${packageName} remote --dry-run --no-resume`,
    'codex:app-server:status': `${packageName} app-server status`,
    'codex:app-server:stop': `${packageName} app-server stop --dry-run`,
  };
  for (const [name, command] of Object.entries(wantedScripts)) {
    if (scripts[name] === undefined) scripts[name] = command;
  }
  parsed.scripts = scripts;

  const dependencies = recordFrom(parsed.dependencies);
  const devDependencies = { ...recordFrom(parsed.devDependencies) };
  if (dependencies[packageName] === undefined && devDependencies[packageName] === undefined) {
    devDependencies[packageName] = packageVersion;
  }
  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = devDependencies;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function agentsBlock(): string {
  return `${AGENTS_MARKER_START}
## Codex Agent Session Manager

This project uses \`${packageName}\` for Codex App Server session control and
MCP callable-catalog validation.

Useful commands:

- \`npm run codex:init\`
- \`npm run codex:init:dry-run\`
- \`npm run codex:remote\`
- \`npm run codex:remote:dry-run\`
- \`${packageName} mcp add npm <package-spec> --dry-run\`
- \`${packageName} mcp add npm <package-spec> --confirm\`
- \`${packageName} mcp refresh --thread-id <thread-id>\`

Treat App Server MCP status as diagnostic. Validate MCP changes with a real
tool call from the continuation or replacement turn. Direct MCP SDK calls are
diagnostic only; they do not prove the model-callable catalog refreshed.
${AGENTS_MARKER_END}`;
}

function agentsContent(content: string | null): string {
  const block = agentsBlock();
  if (content === null || content.trim().length === 0) {
    return ensureTrailingNewline(`# Project Agent Notes\n\n${block}`);
  }

  const marked = replaceMarkedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END, block);
  if (marked !== null) return marked;
  return appendBlock(content, block);
}

function actionForFile(path: string, current: string | null, next: string, reason: string): InitAction {
  if (current === next) return { kind: 'noop', target: path, reason };
  return { kind: current === null ? 'create' : 'update', target: path, reason };
}

function maybeAddFileUpdate(plan: InitPlan, path: string, current: string | null, next: string, reason: string): void {
  const action = actionForFile(path, current, next, reason);
  plan.actions.push(action);
  if (action.kind !== 'noop') {
    plan.fileUpdates.push({ path, content: next, reason });
  }
}

export function buildInitPlan(options: ParsedInitArgs = {}): InitPlan {
  const workspace = resolveWorkspaceRoot(options.workspace ?? process.cwd());
  const dryRun = options.dryRun === true;
  const plan: InitPlan = {
    ok: true,
    dryRun,
    workspace,
    mcpServerName: MCP_SERVER_NAME,
    actions: [],
    fileUpdates: [],
    windowsHiddenLauncherPath: prepareWindowsHiddenLauncherForWorkspace(workspace, true),
  };

  const codexConfigPath = workspacePath(workspace, '.codex', 'config.toml');
  const codexConfigCurrent = readTextIfExists(codexConfigPath);
  maybeAddFileUpdate(
    plan,
    codexConfigPath,
    codexConfigCurrent,
    upsertMcpConfig(codexConfigCurrent),
    'register project-scoped MCP server',
  );

  const gitignorePath = workspacePath(workspace, '.gitignore');
  const gitignoreCurrent = readTextIfExists(gitignorePath);
  maybeAddFileUpdate(
    plan,
    gitignorePath,
    gitignoreCurrent,
    gitignoreContent(gitignoreCurrent),
    'ignore local session-manager runtime state',
  );

  const packageJsonPath = workspacePath(workspace, 'package.json');
  const packageCurrent = readTextIfExists(packageJsonPath);
  const packageNext = packageJsonContent(packageCurrent);
  if (packageNext === null) {
    plan.actions.push({
      kind: 'skip',
      target: packageJsonPath,
      reason: 'package.json not found; scripts and devDependency were not added',
    });
  } else {
    maybeAddFileUpdate(plan, packageJsonPath, packageCurrent, packageNext, 'add npm scripts and devDependency');
  }

  const agentsPath = workspacePath(workspace, 'AGENTS.md');
  if (options.agents === false) {
    plan.actions.push({ kind: 'skip', target: agentsPath, reason: 'disabled by --no-agents' });
  } else {
    const agentsCurrent = readTextIfExists(agentsPath);
    maybeAddFileUpdate(
      plan,
      agentsPath,
      agentsCurrent,
      agentsContent(agentsCurrent),
      'add agent operating notes',
    );
  }

  if (plan.windowsHiddenLauncherPath !== null) {
    plan.actions.push({
      kind: existsSync(plan.windowsHiddenLauncherPath) ? 'update' : 'create',
      target: plan.windowsHiddenLauncherPath,
      reason: 'prepare Windows hidden App Server launcher',
    });
  }

  return plan;
}

export function applyInitPlan(plan: InitPlan): void {
  for (const update of plan.fileUpdates) {
    assertWorkspacePath(plan.workspace, update.path);
    mkdirSync(dirname(update.path), { recursive: true });
    writeFileSync(update.path, update.content, 'utf8');
  }

  if (plan.windowsHiddenLauncherPath !== null) {
    prepareWindowsHiddenLauncherForWorkspace(plan.workspace, false);
  }
}

export function initPlanPreview(plan: InitPlan, applied: boolean): Record<string, unknown> {
  return redactValue(
    {
      ok: plan.ok,
      applied,
      dryRun: plan.dryRun,
      workspace: '<workspace>',
      mcpServerName: plan.mcpServerName,
      actions: plan.actions,
    },
    { workspace: plan.workspace },
  ) as Record<string, unknown>;
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

function formatHumanInitPlan(plan: InitPlan, applied: boolean): string {
  const lines = [
    `codex-agent-session-manager init ${plan.dryRun ? 'dry-run' : applied ? 'applied' : 'plan'}`,
    `workspace: <workspace>`,
    `mcp server: ${plan.mcpServerName}`,
    '',
    'actions:',
  ];
  for (const action of plan.actions) {
    const kind = action.kind.padEnd(6, ' ');
    lines.push(`  ${kind} ${previewPath(action.target, plan.workspace)} - ${action.reason}`);
  }
  if (plan.dryRun) {
    lines.push('', 'Dry run only; no files were changed.');
  }
  return lines.join('\n');
}

export async function runInitCommand(argv: readonly string[], deps: InitDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(`${text}\n`));
  const options = parseInitArgs(argv);
  if (options.help === true) {
    output(usage().trimEnd());
    return 0;
  }

  const plan = buildInitPlan(options);
  if (!plan.dryRun) {
    applyInitPlan(plan);
  }
  output(
    options.json === true
      ? JSON.stringify(initPlanPreview(plan, !plan.dryRun), null, 2)
      : formatHumanInitPlan(plan, !plan.dryRun),
  );
  return 0;
}
