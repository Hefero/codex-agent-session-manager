import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpCleanupReportPayload } from '../src/tools/mcp-report.js';
import { OperationStore } from '../src/tools/operations.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-mcp-report-'));
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

test('mcp cleanup report summarizes local/global managed MCP state and operations', () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(
      join(workspace, '.codex', 'config.toml'),
      `# BEGIN codex-agent-session-manager:mcp-add:everything
[mcp_servers.everything]
command = "node"
args = ["node_modules/@modelcontextprotocol/server-everything/dist/index.js", "stdio"]
cwd = "."
# END codex-agent-session-manager:mcp-add
`,
      'utf8',
    );
    writeFileSync(
      join(workspace, 'package.json'),
      `${JSON.stringify({
        devDependencies: {
          '@modelcontextprotocol/server-everything': '1.0.0',
        },
      }, null, 2)}\n`,
      'utf8',
    );
    mkdirSync(join(workspace, 'node_modules', '@modelcontextprotocol', 'server-everything'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules', '@modelcontextprotocol', 'server-everything', 'package.json'), '{}\n', 'utf8');

    const globalConfig = join(workspace, 'home', '.codex', 'config.toml');
    const globalState = join(workspace, 'global-state');
    const serverDir = join(globalState, 'mcps', 'global_everything');
    mkdirSync(join(workspace, 'home', '.codex'), { recursive: true });
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(join(globalState, 'mcps', 'orphan_runtime'), { recursive: true });
    writeFileSync(
      globalConfig,
      `# BEGIN codex-agent-session-manager:global-mcp-add:global_everything
[mcp_servers.global_everything]
command = "node"
args = ["node_modules/example-global/dist/index.js", "stdio"]
cwd = "${serverDir.replace(/\\/gu, '/')}"
# END codex-agent-session-manager:global-mcp-add
`,
      'utf8',
    );

    const operationStore = new OperationStore({ workspace });
    operationStore.complete(operationStore.create({ kind: 'local_mcp_add_npm', status: 'running' }).id);

    const payload = withCwd(workspace, () => buildMcpCleanupReportPayload(
      {
        globalConfigPath: globalConfig,
        globalStateDir: globalState,
      },
      { operationStore },
    ));

    assert.equal(payload.ok, true);
    assert.equal((payload.local as { managedServerCount: number }).managedServerCount, 1);
    assert.equal((payload.global as { managedServerCount: number }).managedServerCount, 1);
    assert.match(JSON.stringify(payload.global), /orphan_runtime/u);
    assert.match(JSON.stringify(payload.operations), /local_mcp_add_npm/u);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
