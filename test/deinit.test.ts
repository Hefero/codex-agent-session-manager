import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { applyInitPlan, buildInitPlan } from '../src/init.js';
import { applyDeinitPlan, buildDeinitPlan, parseDeinitArgs, runDeinitCommand } from '../src/deinit.js';
import { packageName, packageVersion } from '../src/version.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-deinit-'));
}

function initWorkspace(workspace: string): void {
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
  applyInitPlan(buildInitPlan({ workspace }));
}

test('parseDeinitArgs maps workspace, confirm, json, runtime, and added MCP removal', () => {
  assert.deepEqual(
    parseDeinitArgs([
      '--workspace',
      'project-a',
      '--confirm',
      '--json',
      '--remove-runtime',
      '--remove-added-mcps',
    ]),
    {
      workspace: 'project-a',
      confirm: true,
      json: true,
      removeRuntime: true,
      removeAddedMcps: true,
    },
  );
});

test('runDeinitCommand defaults to dry-run and does not modify files', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    initWorkspace(workspace);

    const exitCode = await runDeinitCommand(
      ['--workspace', workspace],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.doesNotMatch(text, new RegExp(escapeRegExp(resolve(workspace)), 'u'));
    assert.match(text, /codex-agent-session-manager deinit dry-run/u);
    assert.match(text, /Dry run only; no files were changed\. Pass --confirm to apply\./u);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), true);
    assert.equal(existsSync(join(workspace, 'AGENTS.md')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('deinit confirm removes scaffold and optional runtime while leaving npm package uninstall to next action', () => {
  const workspace = tempWorkspace();
  try {
    initWorkspace(workspace);
    mkdirSync(join(workspace, '.codex-agent-session-manager', 'state'), { recursive: true });
    writeFileSync(join(workspace, '.codex-agent-session-manager', 'state', 'app-server.json'), '{}\n');

    const plan = buildDeinitPlan({ workspace, confirm: true, removeRuntime: true });
    assert.equal(plan.dryRun, false);
    applyDeinitPlan(plan);

    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(workspace, '.gitignore')), false);
    assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
    assert.equal(existsSync(join(workspace, '.codex-agent-session-manager')), false);
    assert.deepEqual(plan.packagesToUninstall, [packageName]);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.scripts, undefined);
    assert.equal(packageJson.devDependencies?.[packageName], packageVersion);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('deinit preserves custom scripts and unrelated file content', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(
      join(workspace, 'package.json'),
      `${JSON.stringify({
        name: 'target-project',
        scripts: {
          'codex:remote': 'custom-command',
          'codex:init': `${packageName} init`,
        },
      }, null, 2)}\n`,
    );
    writeFileSync(join(workspace, 'AGENTS.md'), `# Existing\n\n<!-- codex-agent-session-manager:start -->\nmanaged\n<!-- codex-agent-session-manager:end -->\n`);

    const plan = buildDeinitPlan({ workspace, confirm: true });
    applyDeinitPlan(plan);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.deepEqual(packageJson.scripts, { 'codex:remote': 'custom-command' });
    assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), '# Existing\n');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('deinit can remove managed mcp-add blocks and reports added packages', () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(
      join(workspace, '.codex', 'config.toml'),
      [
        '# BEGIN codex-agent-session-manager:mcp-add:everything',
        '[mcp_servers.everything]',
        'command = "node"',
        'args = ["node_modules/@modelcontextprotocol/server-everything/dist/index.js", "stdio"]',
        '# END codex-agent-session-manager:mcp-add',
        '',
        '# BEGIN codex-agent-session-manager',
        '[mcp_servers.codex_agent_session_manager]',
        'command = "codex-agent-session-manager"',
        'args = ["serve"]',
        '# END codex-agent-session-manager',
        '',
      ].join('\n'),
    );

    const plan = buildDeinitPlan({ workspace, confirm: true, removeAddedMcps: true });
    applyDeinitPlan(plan);

    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
    assert.deepEqual(plan.packagesToUninstall, [
      '@modelcontextprotocol/server-everything',
      packageName,
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init does not mistake managed mcp-add blocks for the base manager block', () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(
      join(workspace, '.codex', 'config.toml'),
      [
        '# BEGIN codex-agent-session-manager:mcp-add:everything',
        '[mcp_servers.everything]',
        'command = "node"',
        'args = ["node_modules/@modelcontextprotocol/server-everything/dist/index.js", "stdio"]',
        '# END codex-agent-session-manager:mcp-add',
        '',
      ].join('\n'),
    );

    applyInitPlan(buildInitPlan({ workspace, agents: false }));
    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /codex-agent-session-manager:mcp-add:everything/u);
    assert.match(config, /\[mcp_servers\.everything\]/u);
    assert.match(config, /\[mcp_servers\.codex_agent_session_manager\]/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('deinit rejects managed directory symlink or junction escapes', (t) => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    initWorkspace(workspace);
    rmSync(join(workspace, '.codex'), { recursive: true, force: true });
    try {
      symlinkSync(outside, join(workspace, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink or junction creation is unavailable in this environment');
      return;
    }

    assert.throws(() => buildDeinitPlan({ workspace, confirm: true }), /symlink or junction/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
