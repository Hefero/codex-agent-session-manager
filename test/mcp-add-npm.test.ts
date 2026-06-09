import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function fakeInstallPackage(packageName: string, bin: string, scripts: Record<string, string> = {}): NpmRunner {
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

test('mcp add npm dry-run previews package install and config update without writing files', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload({
      packageSpec: '@modelcontextprotocol/server-everything',
    }));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.confirmRequired, true);
    assert.equal(payload.workspace, '<workspace>');
    assert.equal(payload.packageName, '@modelcontextprotocol/server-everything');
    assert.equal(payload.serverName, 'everything');
    assert.equal(payload.lifecycleScriptsAllowed, false);
    assert.match(JSON.stringify(payload), /--ignore-scripts/u);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(workspace, 'package.json')), false);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(escapeRegExp(workspace), 'u'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm refuses real install without confirm', () => {
  const workspace = tempWorkspace();
  try {
    let npmCalled = false;
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        dryRun: false,
      },
      {
        npmRunner: () => {
          npmCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    ));

    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.confirmRequired, true);
    assert.equal(npmCalled, false);
    assert.equal(existsSync(join(workspace, 'package.json')), false);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm installs locally and writes a marked project MCP config block', () => {
  const workspace = tempWorkspace();
  try {
    const npmCalls: string[][] = [];
    const fakeInstaller = fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js');
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        dryRun: false,
        confirm: true,
      },
      {
        npmRunner: (args, options) => {
          npmCalls.push([...args]);
          return fakeInstaller(args, options);
        },
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(payload.confirmRequired, false);
    assert.equal(payload.lifecycleScriptsAllowed, false);
    assert.deepEqual(npmCalls, [[
      'install',
      '--save-dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      './.npm-cache',
      '@modelcontextprotocol/server-everything',
    ]]);
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

test('mcp add npm can forward env var names and omit default stdio arg', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: 'tavily-mcp@latest',
        serverName: 'tavily_search',
        extraArgs: [],
        envVars: ['TAVILY_API_KEY', 'TAVILY_API_KEY'],
        dryRun: false,
        confirm: true,
      },
      {
        npmRunner: fakeInstallPackage('tavily-mcp', 'build/index.js'),
      },
    ));

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.args, ['node_modules/tavily-mcp/build/index.js']);
    assert.deepEqual(payload.envVars, ['TAVILY_API_KEY']);
    assert.doesNotMatch(JSON.stringify(payload), /secret/u);
    assert.match(JSON.stringify(payload.warnings), /env_vars stores variable names only/u);
    assert.match(JSON.stringify(payload.warnings), /App Server launch environment/u);
    assert.match(JSON.stringify(payload.warnings), /OAuth, PII, write-capable, or destructive MCPs/u);
    assert.match(String(payload.nextAction), /restart or relaunch the managed App Server/u);
    assert.match(String(payload.nextAction), /do not stop at MCP status alone/u);
    assert.match(String(payload.nextAction), /do not prove by launching the stdio entrypoint/u);
    assert.match(String(payload.nextAction), /orphan node\/cmd windows/u);

    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /\[mcp_servers\.tavily_search\]/u);
    assert.match(config, /args = \["node_modules\/tavily-mcp\/build\/index\.js"\]/u);
    assert.match(config, /env_vars = \["TAVILY_API_KEY"\]/u);
    assert.doesNotMatch(config, /BRAVE|secret|token-value/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm rejects invalid env var names', () => {
  const workspace = tempWorkspace();
  try {
    assert.throws(
      () => withCwd(workspace, () => buildMcpAddNpmPayload({
        packageSpec: 'tavily-mcp',
        envVars: ['TAVILY-API-KEY'],
      })),
      /Invalid|Environment variable/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm reports package lifecycle scripts suppressed by default', () => {
  const workspace = tempWorkspace();
  try {
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: '@wonderwhy-er/desktop-commander',
        serverName: 'desktop_commander',
        dryRun: false,
        confirm: true,
      },
      {
        npmRunner: fakeInstallPackage('@wonderwhy-er/desktop-commander', 'dist/index.js', {
          postinstall: 'node dist/track-installation.js',
          prepare: 'npm run build',
        }),
      },
    ));

    assert.equal(payload.lifecycleScriptsAllowed, false);
    assert.deepEqual(payload.packageLifecycleScripts, ['postinstall', 'prepare']);
    assert.equal(payload.lifecycleScriptsSuppressed, true);
    assert.match(JSON.stringify(payload.warnings), /--ignore-scripts/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm can explicitly allow npm lifecycle scripts', () => {
  const workspace = tempWorkspace();
  try {
    const npmCalls: string[][] = [];
    const fakeInstaller = fakeInstallPackage('@modelcontextprotocol/server-everything', 'dist/index.js');
    const payload = withCwd(workspace, () => buildMcpAddNpmPayload(
      {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        dryRun: false,
        confirm: true,
        allowScripts: true,
      },
      {
        npmRunner: (args, options) => {
          npmCalls.push([...args]);
          return fakeInstaller(args, options);
        },
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.lifecycleScriptsAllowed, true);
    assert.deepEqual(npmCalls, [[
      'install',
      '--save-dev',
      '--no-audit',
      '--no-fund',
      '--cache',
      './.npm-cache',
      '@modelcontextprotocol/server-everything',
    ]]);
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
          dryRun: false,
          confirm: true,
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

test('mcp add npm rejects path-like version specs', () => {
  const workspace = tempWorkspace();
  try {
    assert.throws(
      () => withCwd(workspace, () => buildMcpAddNpmPayload({
        packageSpec: 'left-pad@../outside',
      })),
      /Only npm registry package specs are supported|Unsupported npm package spec/u,
    );
    assert.throws(
      () => withCwd(workspace, () => buildMcpAddNpmPayload({
        packageSpec: '@scope/pkg@../outside',
      })),
      /Only npm registry package specs are supported|Unsupported npm package spec/u,
    );

    const payload = withCwd(workspace, () => buildMcpAddNpmPayload({
      packageSpec: '@scope/pkg@1.2.3-alpha.1',
      dryRun: true,
    }));
    assert.equal(payload.packageName, '@scope/pkg');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mcp add npm rejects node_modules symlink or junction escapes before install', (t) => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    try {
      symlinkSync(outside, join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink or junction creation is unavailable in this environment');
      return;
    }

    let npmCalled = false;
    assert.throws(
      () => withCwd(workspace, () => buildMcpAddNpmPayload(
        {
          packageSpec: '@modelcontextprotocol/server-everything',
          serverName: 'everything',
          dryRun: false,
          confirm: true,
        },
        {
          npmRunner: () => {
            npmCalled = true;
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      )),
      /symlink or junction/u,
    );
    assert.equal(npmCalled, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
