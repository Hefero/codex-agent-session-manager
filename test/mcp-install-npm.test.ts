import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpInstallNpmPayload } from '../src/tools/mcp-install-npm.js';
import { inspectNpmMetadataForMcpPackage } from '../src/tools/npm-package-inspect.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-mcp-install-'));
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

function fakeInstallPackage(packageName: string, bin: string) {
  return (_args: readonly string[], options: { cwd: string }) => {
    const packageRoot = join(options.cwd, 'node_modules', ...packageName.split('/'));
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: packageName,
        version: '1.0.0',
        type: 'module',
        bin: { example: bin },
      }, null, 2)}\n`,
    );
    return { status: 0, stdout: 'installed', stderr: '' };
  };
}

function fakeInspection(packageSpec: string) {
  return inspectNpmMetadataForMcpPackage({
    packageSpec,
    metadata: {
      name: packageSpec,
      version: '1.0.0',
      readme: 'Set EXAMPLE_INSTALL_API_KEY before starting this MCP server.',
    },
  });
}

function hiddenLauncher(directory: string, dryRun: boolean): string {
  const launcher = join(directory, 'windows-hidden-stdio-launcher.exe');
  if (!dryRun) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(launcher, '');
  }
  return launcher;
}

test('mcp install npm defaults to local scope and refuses secret-bearing installs without envVars', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpInstallNpmPayload(
      {
        packageSpec: 'example-install-mcp',
        serverName: 'example_install',
        dryRun: false,
        confirm: true,
      },
      {
        packageInspector: fakeInspection,
        localNpmRunner: fakeInstallPackage('example-install-mcp', 'dist/index.js'),
      },
    ));

    assert.equal(payload.ok, false);
    assert.equal(payload.scope, 'local');
    assert.equal(payload.installTool, 'codex_mcp_install_npm');
    assert.deepEqual(payload.suggestedEnvVars, ['EXAMPLE_INSTALL_API_KEY']);
    assert.match(String(payload.nextAction), /codex_mcp_install_npm/u);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp install npm supports global scope explicitly', () => {
  const workspace = tempWorkspace();
  try {
    const configPath = join(workspace, 'config.toml');
    const stateDir = join(workspace, 'state');
    const payload = buildMcpInstallNpmPayload(
      {
        packageSpec: 'example-global-install-mcp',
        scope: 'global',
        serverName: 'example_global_install',
        envVars: ['EXAMPLE_INSTALL_API_KEY'],
        configPath,
        stateDir,
        dryRun: false,
        confirm: true,
      },
      {
        globalNpmRunner: fakeInstallPackage('example-global-install-mcp', 'dist/index.js'),
        prepareWindowsHiddenLauncher: hiddenLauncher,
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.scope, 'global');
    assert.equal(payload.installTool, 'codex_mcp_install_npm');
    const config = readFileSync(configPath, 'utf8');
    assert.match(config, /\[mcp_servers\.example_global_install\]/u);
    assert.match(config, /env_vars = \["EXAMPLE_INSTALL_API_KEY"\]/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
