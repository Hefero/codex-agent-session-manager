import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGlobalMcpAddNpmPayload, buildGlobalMcpRemovePayload, type GlobalMcpNpmRunner } from '../src/tools/global-mcp-npm.js';
import { inspectNpmMetadataForMcpPackage } from '../src/tools/npm-package-inspect.js';
import { OperationStore } from '../src/tools/operations.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-global-mcp-'));
}

function fakeInstallPackage(packageName: string, bin: string, scripts: Record<string, string> = {}): GlobalMcpNpmRunner {
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
        scripts,
      }, null, 2)}\n`,
    );
    return { status: 0, stdout: 'installed', stderr: '' };
  };
}

function hiddenLauncher(directory: string, dryRun: boolean): string {
  const launcher = join(directory, 'windows-hidden-stdio-launcher.exe');
  if (!dryRun) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(launcher, '');
  }
  return launcher;
}

function fakeSecretBearingInspection(packageSpec: string) {
  return inspectNpmMetadataForMcpPackage({
    packageSpec,
    metadata: {
      name: packageSpec,
      version: '1.0.0',
      readme: 'Set EXAMPLE_GLOBAL_API_KEY before starting this MCP server.',
    },
  });
}

test('global mcp add npm dry-run previews isolated install and user-global config update', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, '.codex', 'config.toml');
    const stateDir = join(workspace, 'state');
    const payload = buildGlobalMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        configPath,
        stateDir,
      },
      { prepareWindowsHiddenLauncher: hiddenLauncher },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.scope, 'global');
    assert.equal(payload.dryRun, true);
    assert.equal(payload.serverName, 'everything');
    assert.equal(payload.configPath, '<user-codex-config>');
    assert.match(JSON.stringify(payload), /user-global Codex MCP config/u);
    assert.match(JSON.stringify(payload), /--ignore-scripts/u);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(stateDir), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global mcp add npm installs in isolated runtime and writes marked global config block', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, '.codex', 'config.toml');
    const stateDir = join(workspace, 'state');
    const operationStore = new OperationStore({ workspace });
    const payload = buildGlobalMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        envVars: ['EVERYTHING_API_KEY'],
        configPath,
        stateDir,
        dryRun: false,
        confirm: true,
      },
      {
        operationStore,
        npmRunner: fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js'),
        prepareWindowsHiddenLauncher: hiddenLauncher,
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.equal(payload.dryRun, false);
    assert.equal(payload.packageName, '@modelcontextprotocol/server-everything');
    assert.equal(existsSync(join(stateDir, 'mcps', 'everything', 'package.json')), true);
    assert.equal(existsSync(join(stateDir, 'windows-hidden-stdio-launcher.exe')), true);
    const config = readFileSync(configPath, 'utf8');
    assert.match(config, /BEGIN codex-agent-session-manager:global-mcp-add:everything/u);
    assert.match(config, /\[mcp_servers\.everything\]/u);
    assert.match(config, /windows-hidden-stdio-launcher\.exe/u);
    assert.match(config, /env_vars = \["EVERYTHING_API_KEY"\]/u);
    assert.doesNotMatch(config, /EVERYTHING_API_KEY=.*secret/u);
    assert.deepEqual(payload.envVarStatus, {
      allAvailable: false,
      missing: ['EVERYTHING_API_KEY'],
      entries: [{
        name: 'EVERYTHING_API_KEY',
        available: false,
        sources: [],
        recommendedSetCommand: 'codex-agent-session-manager secret set EVERYTHING_API_KEY',
      }],
    });
    assert.match(JSON.stringify(payload.warnings), /Missing configured env_vars: EVERYTHING_API_KEY/u);
    assert.match(String(payload.nextAction), /Do not treat keyless or fallback behavior as proof/u);
    const operation = operationStore.read(String(payload.operationId));
    assert.equal(operation?.kind, 'global_mcp_add_npm');
    assert.equal(operation?.status, 'completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global mcp add npm refuses real install when package inspection finds env vars but envVars is empty', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, '.codex', 'config.toml');
    const stateDir = join(workspace, 'state');
    let npmCalled = false;
    const payload = buildGlobalMcpAddNpmPayload(
      {
        packageSpec: 'example-global-mcp',
        serverName: 'example_global',
        configPath,
        stateDir,
        dryRun: false,
        confirm: true,
      },
      {
        packageInspector: fakeSecretBearingInspection,
        prepareWindowsHiddenLauncher: hiddenLauncher,
        npmRunner: () => {
          npmCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(npmCalled, false);
    assert.deepEqual(payload.suggestedEnvVars, ['EXAMPLE_GLOBAL_API_KEY']);
    assert.match(String(payload.nextAction), /secret set EXAMPLE_GLOBAL_API_KEY/u);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global mcp add npm refuses unmanaged global server section', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, '.codex', 'config.toml');
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(configPath, '[mcp_servers.everything]\ncommand = "custom"\n', 'utf8');

    assert.throws(
      () => buildGlobalMcpAddNpmPayload({
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        configPath,
        stateDir: join(workspace, 'state'),
      }),
      /already has an unmanaged \[mcp_servers\.everything\] section/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global mcp remove deletes managed global config block and optionally isolated runtime', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, '.codex', 'config.toml');
    const stateDir = join(workspace, 'state');
    buildGlobalMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        configPath,
        stateDir,
        dryRun: false,
        confirm: true,
      },
      {
        npmRunner: fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js'),
        prepareWindowsHiddenLauncher: hiddenLauncher,
      },
    );

    const serverDir = join(stateDir, 'mcps', 'everything');
    assert.equal(existsSync(serverDir), true);
    const operationStore = new OperationStore({ workspace });
    const payload = buildGlobalMcpRemovePayload(
      {
        serverName: 'everything',
        uninstallPackage: true,
        configPath,
        stateDir,
        dryRun: false,
        confirm: true,
      },
      { operationStore },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.equal(payload.found, true);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(serverDir), false);
    const operation = operationStore.read(String(payload.operationId));
    assert.equal(operation?.kind, 'global_mcp_remove');
    assert.equal(operation?.status, 'completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
