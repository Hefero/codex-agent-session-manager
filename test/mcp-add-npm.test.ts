import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpAddNpmPayload, type NpmRunner } from '../src/tools/mcp-add-npm.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-mcp-add-'));
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

function fakeInstallPackage(packageName: string, bin: string): NpmRunner {
  return (_args, options) => {
    const packageRoot = join(options.cwd, 'node_modules', ...packageName.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: packageName,
        version: '1.0.0',
        type: 'module',
        bin: { 'mcp-server-example': bin },
      }, null, 2)}\n`,
    );
    return { status: 0, stdout: 'installed', stderr: '' };
  };
}

test('mcp add npm dry-run previews package install and config update without writing files', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload({
      packageSpec: '@modelcontextprotocol/server-everything',
      dryRun: true,
    }));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.workspace, '<workspace>');
    assert.equal(payload.packageName, '@modelcontextprotocol/server-everything');
    assert.equal(payload.serverName, 'everything');
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(workspace, 'package.json')), false);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(escapeRegExp(workspace), 'u'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm installs locally and writes a marked project MCP config block', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
      },
      {
        npmRunner: fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js'),
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.deepEqual(payload.args, [
      'node_modules/@modelcontextprotocol/server-everything/dist/index.js',
      'stdio',
    ]);

    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /# BEGIN codex-agent-session-manager:mcp-add:everything/u);
    assert.match(config, /\[mcp_servers\.everything\]/u);
    assert.match(config, /command = "node"/u);
    assert.match(config, /args = \["node_modules\/@modelcontextprotocol\/server-everything\/dist\/index\.js", "stdio"\]/u);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      private?: boolean;
    };
    assert.equal(packageJson.private, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm refuses to replace unmanaged server config sections', () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(join(workspace, '.codex', 'config.toml'), '[mcp_servers.everything]\ncommand = "node"\n');

    assert.throws(
      () => withCwd(workspace, () => buildMcpAddNpmPayload(
        {
          packageSpec: '@modelcontextprotocol/server-everything',
          serverName: 'everything',
        },
        {
          npmRunner: fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js'),
        },
      )),
      /already has an unmanaged \[mcp_servers\.everything\] section/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
