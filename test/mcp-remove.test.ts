import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLocalMcpRemovePayload, type NpmRemoveRunner } from '../src/tools/mcp-remove.js';
import { OperationStore } from '../src/tools/operations.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-mcp-remove-'));
}

function withCwd<T>(cwd: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function managedBlock(serverName: string, packageName: string): string {
  return `# BEGIN codex-agent-session-manager:mcp-add:${serverName}
[mcp_servers.${serverName}]
command = "node"
args = ["node_modules/${packageName}/dist/index.js", "stdio"]
cwd = "."
# END codex-agent-session-manager:mcp-add`;
}

function writeConfig(workspace: string, content: string): void {
  const configDir = join(workspace, '.codex');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.toml'), `${content.trim()}\n`, 'utf8');
}

test('local mcp remove dry-run reports missing managed block without writing files', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildLocalMcpRemovePayload({ serverName: 'missing' }));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.found, false);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('local mcp remove deletes a managed project MCP config block', () => {
  const workspace = tempWorkspace();
  try {
    writeConfig(workspace, `
${managedBlock('everything', '@modelcontextprotocol/server-everything')}

${managedBlock('search_mcp', 'example-search-mcp')}
`);

    const operationStore = new OperationStore({ workspace });
    const payload = withCwd(workspace, () => buildLocalMcpRemovePayload({
      serverName: 'everything',
      dryRun: false,
      confirm: true,
    }, { operationStore }));

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.equal(payload.found, true);
    assert.equal(payload.packageName, '@modelcontextprotocol/server-everything');
    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /mcp_servers\.everything/u);
    assert.match(config, /mcp_servers\.search_mcp/u);
    const operation = operationStore.read(String(payload.operationId));
    assert.equal(operation?.kind, 'local_mcp_remove');
    assert.equal(operation?.status, 'completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('local mcp remove can uninstall the inferred npm package when requested', () => {
  const workspace = tempWorkspace();
  try {
    writeConfig(workspace, managedBlock('everything', '@modelcontextprotocol/server-everything'));
    const npmCalls: string[][] = [];
    const npmRunner: NpmRemoveRunner = (args) => {
      npmCalls.push([...args]);
      return { status: 0, stdout: 'removed', stderr: '' };
    };

    const payload = withCwd(workspace, () => buildLocalMcpRemovePayload(
      {
        serverName: 'everything',
        uninstallPackage: true,
        dryRun: false,
        confirm: true,
      },
      { npmRunner },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.packageName, '@modelcontextprotocol/server-everything');
    assert.deepEqual(npmCalls, [[
      'uninstall',
      '-D',
      '--no-audit',
      '--no-fund',
      '--cache',
      './.npm-cache',
      '@modelcontextprotocol/server-everything',
    ]]);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('local mcp remove skips package uninstall when another managed block uses the same package', () => {
  const workspace = tempWorkspace();
  try {
    writeConfig(workspace, `
${managedBlock('server_a', 'example-mcp')}

${managedBlock('server_b', 'example-mcp')}
`);
    let npmCalled = false;

    const payload = withCwd(workspace, () => buildLocalMcpRemovePayload(
      {
        serverName: 'server_a',
        uninstallPackage: true,
        dryRun: false,
        confirm: true,
      },
      {
        npmRunner: () => {
          npmCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.packageShared, true);
    assert.equal(npmCalled, false);
    assert.match(JSON.stringify(payload.warnings), /still referenced/u);
    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /mcp_servers\.server_a/u);
    assert.match(config, /mcp_servers\.server_b/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
