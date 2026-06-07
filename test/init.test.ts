import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { applyInitPlan, buildInitPlan, parseInitArgs, runInitCommand } from '../src/init.js';
import { packageName, packageVersion } from '../src/version.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-init-'));
}

test('parseInitArgs maps dry-run, workspace, json, and agents opt-out', () => {
  assert.deepEqual(parseInitArgs(['--workspace', 'project-a', '--dry-run', '--json', '--no-agents']), {
    workspace: 'project-a',
    dryRun: true,
    json: true,
    agents: false,
  });
});

test('runInitCommand dry-run defaults to human output without writing files', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    const exitCode = await runInitCommand(
      ['--workspace', workspace, '--dry-run'],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.doesNotMatch(text, new RegExp(escapeRegExp(resolve(workspace)), 'u'));
    assert.match(text, /codex-agent-session-manager init dry-run/u);
    assert.match(text, /workspace: <workspace>/u);
    assert.match(text, /mcp server: codex_agent_session_manager/u);
    assert.match(text, /create\s+<workspace>.*\.codex.*config\.toml/u);
    assert.match(text, /Dry run only; no files were changed\./u);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runInitCommand supports JSON output for automation', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    const exitCode = await runInitCommand(
      ['--workspace', workspace, '--dry-run', '--json'],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    const payload = JSON.parse(text) as { workspace?: string; mcpServerName?: string; dryRun?: boolean };
    assert.equal(payload.workspace, '<workspace>');
    assert.equal(payload.mcpServerName, 'codex_agent_session_manager');
    assert.equal(payload.dryRun, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('applyInitPlan creates project config, package scripts, gitignore, and AGENTS notes idempotently', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);

    const first = buildInitPlan({ workspace });
    assert.ok(first.fileUpdates.length > 0);
    applyInitPlan(first);

    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /\[mcp_servers\.codex_agent_session_manager\]/u);
    assert.match(config, /command = "codex-agent-session-manager"/u);
    assert.match(config, /args = \["serve"\]/u);

    const gitignore = readFileSync(join(workspace, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.codex-agent-session-manager\//u);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['codex:init'], `${packageName} init`);
    assert.equal(packageJson.scripts?.['codex:init:dry-run'], `${packageName} init --dry-run`);
    assert.equal(packageJson.scripts?.['codex:remote'], `${packageName} remote`);
    assert.equal(packageJson.scripts?.['codex:remote:dry-run'], `${packageName} remote --dry-run --no-resume`);
    assert.equal(packageJson.scripts?.['codex:app-server:status'], `${packageName} app-server status`);
    assert.equal(packageJson.scripts?.['codex:app-server:stop'], `${packageName} app-server stop --dry-run`);
    assert.equal(packageJson.devDependencies?.[packageName], packageVersion);

    const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
    assert.match(agents, /codex-agent-session-manager:start/u);
    assert.match(agents, /MCP callable-catalog validation/u);
    assert.match(agents, /mcp add npm <package-spec>/u);
    assert.match(agents, /Direct MCP SDK calls are\s+diagnostic only/u);

    const second = buildInitPlan({ workspace });
    assert.equal(second.fileUpdates.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init skips package updates when package.json is absent and honors --no-agents', () => {
  const workspace = tempWorkspace();
  try {
    const plan = buildInitPlan({ workspace, agents: false });
    applyInitPlan(plan);

    assert.equal(existsSync(join(workspace, 'package.json')), false);
    assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), true);
    assert.equal(existsSync(join(workspace, '.gitignore')), true);
    assert.ok(plan.actions.some((action) => action.kind === 'skip' && action.target.endsWith('package.json')));
    assert.ok(plan.actions.some((action) => action.kind === 'skip' && action.target.endsWith('AGENTS.md')));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init accepts package.json with UTF-8 BOM', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `\uFEFF${JSON.stringify({ name: 'bom-project' }, null, 2)}\n`);

    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['codex:init'], `${packageName} init`);
    assert.equal(packageJson.scripts?.['codex:remote:dry-run'], `${packageName} remote --dry-run --no-resume`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init rejects managed directory symlink or junction escapes', (t) => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    try {
      symlinkSync(outside, join(workspace, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink or junction creation is unavailable in this environment');
      return;
    }

    assert.throws(() => buildInitPlan({ workspace }), /symlink or junction/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
