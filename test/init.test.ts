import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { applyInitPlan, buildInitPlan, parseInitArgs, runInitCommand } from '../src/init.js';
import { packageName, packageVersion } from '../src/version.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-init-'));
}

function availablePowerShellCommands(): string[] {
  if (process.platform !== 'win32') return [];
  return ['powershell.exe', 'pwsh.exe'].filter((command) => {
    const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  });
}

function fakeInstaller(workspace: string): { npmInstaller(input: { workspace: string; args: string[] }): { status: number; stdout: string; stderr: string } } {
  return {
    npmInstaller(input) {
      assert.equal(resolve(input.workspace), resolve(workspace));
      assert.deepEqual(input.args, [
        'install',
        '--save-dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        './.npm-cache',
        `${packageName}@${packageVersion}`,
      ]);
      const distDir = join(workspace, 'node_modules', packageName, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'cli.js'), '#!/usr/bin/env node\n');
      writeFileSync(join(workspace, 'node_modules', packageName, 'package.json'), `${JSON.stringify({
        name: packageName,
        version: packageVersion,
      }, null, 2)}\n`);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('parseInitArgs maps dry-run, workspace, package spec, json, and shell hook opt-in', () => {
  assert.deepEqual(parseInitArgs(['--workspace', 'project-a', '--package-spec', './package.tgz', '--dry-run', '--json', '--install-shell-hook', '--shell-hook-shell', 'bash', '--shell-hook-profile', 'profile.sh', '--shell-hook-wsl-prefer-linux-path']), {
    workspace: 'project-a',
    packageSpec: './package.tgz',
    dryRun: true,
    json: true,
    installShellHook: true,
    shellHookShell: 'bash',
    shellHookProfile: 'profile.sh',
    shellHookWslPreferLinuxPath: true,
  });

  assert.throws(
    () => parseInitArgs(['--shell-hook-profile', 'profile.ps1']),
    /--shell-hook-profile requires --install-shell-hook/u,
  );
  assert.throws(
    () => parseInitArgs(['--shell-hook-shell', 'bash']),
    /--shell-hook-shell requires --install-shell-hook/u,
  );
  assert.throws(
    () => parseInitArgs(['--shell-hook-wsl-prefer-linux-path']),
    /--shell-hook-wsl-prefer-linux-path requires --install-shell-hook/u,
  );
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

test('init shell hook opt-in is dry-run safe and redacts profile target', async () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'profile.ps1');
  const output: string[] = [];
  try {
    const exitCode = await runInitCommand(
      ['--workspace', workspace, '--dry-run', '--install-shell-hook', '--shell-hook-shell', 'powershell', '--shell-hook-profile', profile],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.match(text, /<shell-profile> - install PowerShell codex function hook/u);
    assert.doesNotMatch(text, new RegExp(escapeRegExp(profile), 'u'));
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('applyInitPlan creates project config, package scripts, and gitignore idempotently without AGENTS.md', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);

    const first = buildInitPlan({ workspace });
    assert.ok(first.fileUpdates.length > 0);
    assert.ok(first.actions.some((action) => action.kind === 'run' && action.command?.includes(`${packageName}@${packageVersion}`)));
    applyInitPlan(first, fakeInstaller(workspace));

    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /\[mcp_servers\.codex_agent_session_manager\]/u);
    if (process.platform === 'win32') {
      assert.match(config, /command = "\.codex-agent-session-manager\/windows-hidden-stdio-launcher\.exe"/u);
      assert.match(config, /args = \["node", "node_modules\/codex-agent-session-manager\/dist\/cli\.js", "serve"\]/u);
    } else {
      assert.match(config, /command = "node"/u);
      assert.match(config, /args = \["node_modules\/codex-agent-session-manager\/dist\/cli\.js", "serve"\]/u);
    }
    assert.match(config, /cwd = "\."/u);

    const gitignore = readFileSync(join(workspace, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.codex-agent-session-manager\//u);
    assert.match(gitignore, /^\.npm-cache\/$/mu);
    assert.match(gitignore, /^\.env$/mu);
    assert.match(gitignore, /^\.env\.\*$/mu);
    assert.match(gitignore, /^!\.env\.example$/mu);
    assert.match(gitignore, /^\.secrets\/$/mu);
    assert.match(gitignore, /^\*credentials\*\.json$/mu);
    assert.match(gitignore, /^\*token\*\.json$/mu);
    assert.match(gitignore, /^\*oauth\*\.json$/mu);

    const shellCodex = readFileSync(join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1'), 'utf8');
    assert.match(shellCodex, /Resolve-CodexAgentSessionManagerCli/u);
    assert.match(shellCodex, /supports managed shell prompts/u);
    assert.match(shellCodex, /--prompt/u);
    assert.match(shellCodex, /Convert-CodexArgsToManagedRemoteArgs/u);
    assert.match(shellCodex, /Convert-ShellResumeStateToManagedRemoteArgs/u);
    assert.match(shellCodex, /Should-DelegateToRealCodex/u);
    assert.match(shellCodex, /Resolve-CodexRealCli/u);
    assert.match(shellCodex, /managed-remote/u);
    assert.match(shellCodex, /--no-bypass-sandbox/u);
    assert.match(shellCodex, /@\('remote'\)/u);
    assert.match(shellCodex, /Test-CodexNativeSubcommand/u);
    assert.match(shellCodex, /Test-CodexManagerOnlyArg/u);
    assert.doesNotMatch(shellCodex, /Resolve-CodexAgentSessionManagerRealCodex/u);

    const posixCodex = readFileSync(join(workspace, '.codex-agent-session-manager', 'shell', 'codex.mjs'), 'utf8');
    assert.match(posixCodex, /convertCodexArgsToManagedRemoteArgs/u);
    assert.match(posixCodex, /convertShellResumeStateToManagedRemoteArgs/u);
    assert.match(posixCodex, /shouldDelegateToRealCodex/u);
    assert.match(posixCodex, /isCodexNativeSubcommand/u);
    assert.match(posixCodex, /isCodexManagerOnlyArg/u);
    assert.match(posixCodex, /resolveRealCodexCli/u);
    assert.match(posixCodex, /remote', \.\.\.remoteArgs/u);

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['codex:init'], `${packageName} init`);
    assert.equal(packageJson.scripts?.['codex:init:dry-run'], `${packageName} init --dry-run`);
    assert.equal(packageJson.scripts?.['codex:remote'], `${packageName} remote`);
    assert.equal(packageJson.scripts?.['codex:remote:dry-run'], `${packageName} remote --dry-run --no-resume`);
    assert.equal(packageJson.scripts?.['codex:app-server:status'], `${packageName} app-server status`);
    assert.equal(packageJson.scripts?.['codex:app-server:stop'], `${packageName} app-server stop --confirm`);
    assert.equal(packageJson.scripts?.['codex:app-server:stop:dry-run'], `${packageName} app-server stop --dry-run`);
    assert.equal(packageJson.devDependencies?.[packageName], packageVersion);

    assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);

    const second = buildInitPlan({ workspace });
    assert.equal(second.fileUpdates.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init can install from an explicit package spec for unpublished tarball testing', () => {
  const workspace = tempWorkspace();
  const packageSpec = '/tmp/codex-agent-session-manager-0.1.0-alpha.7.tgz';
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);

    const plan = buildInitPlan({ workspace, packageSpec });
    assert.ok(plan.actions.some((action) => action.kind === 'run' && action.command?.includes(packageSpec)));

    const installedArgs: string[][] = [];
    applyInitPlan(plan, {
      npmInstaller(input) {
        installedArgs.push(input.args);
        const distDir = join(workspace, 'node_modules', packageName, 'dist');
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, 'cli.js'), '#!/usr/bin/env node\n');
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(installedArgs, [[
      'install',
      '--save-dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      './.npm-cache',
      packageSpec,
    ]]);
    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.devDependencies?.[packageName], packageSpec);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init reinstalls when an explicit package spec is supplied over an existing local package', () => {
  const workspace = tempWorkspace();
  const packageSpec = '/tmp/codex-agent-session-manager-0.1.0-alpha.7.tgz';
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({
      name: 'target-project',
      devDependencies: {
        [packageName]: '0.1.0-alpha.6',
      },
    }, null, 2)}\n`);
    const distDir = join(workspace, 'node_modules', packageName, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'cli.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(workspace, 'node_modules', packageName, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: packageVersion,
    }, null, 2)}\n`);

    const plan = buildInitPlan({ workspace, packageSpec });
    assert.ok(plan.actions.some((action) => action.kind === 'run' && action.command?.includes(packageSpec)));

    const packageUpdate = plan.fileUpdates.find((update) => update.path === join(workspace, 'package.json'));
    assert.ok(packageUpdate);
    const packageJson = JSON.parse(packageUpdate.content) as {
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.devDependencies?.[packageName], packageSpec);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init reinstalls when the existing local package version is stale', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({
      name: 'target-project',
      devDependencies: {
        [packageName]: '0.1.0-alpha.6',
      },
    }, null, 2)}\n`);
    const distDir = join(workspace, 'node_modules', packageName, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'cli.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(workspace, 'node_modules', packageName, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: '0.1.0-alpha.6',
    }, null, 2)}\n`);

    const plan = buildInitPlan({ workspace });
    assert.ok(plan.actions.some((action) => action.kind === 'run' && action.command?.includes(`${packageName}@${packageVersion}`)));

    const packageUpdate = plan.fileUpdates.find((update) => update.path === join(workspace, 'package.json'));
    assert.ok(packageUpdate);
    const packageJson = JSON.parse(packageUpdate.content) as {
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.devDependencies?.[packageName], packageVersion);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init can install the PowerShell codex shell hook only with explicit opt-in', () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);

    const defaultPlan = buildInitPlan({ workspace });
    assert.equal(defaultPlan.shellHookPlan, undefined);

    const plan = buildInitPlan({ workspace, installShellHook: true, shellHookShell: 'powershell', shellHookProfile: profile });
    assert.ok(plan.shellHookPlan);
    assert.ok(plan.actions.some((action) => action.target === '<shell-profile>' && action.reason.includes('PowerShell codex function hook')));
    applyInitPlan(plan, fakeInstaller(workspace));

    const installed = readFileSync(profile, 'utf8');
    assert.match(installed, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(installed, /function global:codex/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated POSIX supervisor consumes shell resume-next state through managed remote', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-posix.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const path = require('node:path');
const workspace = process.cwd();
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
if (args[0] !== 'remote') {
  console.error('unexpected args: ' + JSON.stringify(args));
  process.exit(2);
}
const logPath = ${JSON.stringify(logPath)};
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const markerPath = path.join(workspace, '.codex-agent-session-manager', 'state', 'posix-state-written.marker');
if (!fs.existsSync(markerPath)) {
  const stateDir = path.dirname(markerPath);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(markerPath, 'written\\n');
  fs.writeFileSync(path.join(stateDir, 'shell-resume-next.json'), JSON.stringify({
    mode: 'managed-remote',
    resumeMode: 'current',
    threadId: 'thread-posix',
    prompt: 'posix followup',
    bypassSandbox: false,
    enableImageGeneration: true
  }, null, 2) + '\\n');
}
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.mjs');
    const result = spawnSync(process.execPath, [supervisor, 'initial posix prompt'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    for (const call of calls) {
      const workspaceIndex = call.indexOf('--workspace');
      assert.notEqual(workspaceIndex, -1);
      assert.equal(realpathSync.native(call[workspaceIndex + 1] ?? ''), realpathSync.native(workspace));
      call[workspaceIndex + 1] = '<workspace>';
    }
    assert.deepEqual(calls, [
      ['remote', '--workspace', '<workspace>', '--', 'initial posix prompt'],
      [
        'remote',
        '--workspace',
        '<workspace>',
        '--resume',
        'thread-posix',
        '--enable-image-generation',
        '--no-bypass-sandbox',
        '--prompt',
        'posix followup',
      ],
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated POSIX supervisor routes native sandbox bypass flag through managed remote', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-posix-bypass.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.mjs');
    const result = spawnSync(process.execPath, [supervisor, '--dangerously-bypass-approvals-and-sandbox', 'initial posix prompt'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[];
    const workspaceIndex = call.indexOf('--workspace');
    assert.notEqual(workspaceIndex, -1);
    assert.equal(realpathSync.native(call[workspaceIndex + 1] ?? ''), realpathSync.native(workspace));
    call[workspaceIndex + 1] = '<workspace>';
    assert.deepEqual(call, ['remote', '--workspace', '<workspace>', '--', '--dangerously-bypass-approvals-and-sandbox', 'initial posix prompt']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated POSIX supervisor routes managed no-bypass flag through managed remote', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-posix-no-bypass.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.mjs');
    const result = spawnSync(process.execPath, [supervisor, '--no-bypass-sandbox', 'initial posix prompt'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[];
    const workspaceIndex = call.indexOf('--workspace');
    assert.notEqual(workspaceIndex, -1);
    assert.equal(realpathSync.native(call[workspaceIndex + 1] ?? ''), realpathSync.native(workspace));
    call[workspaceIndex + 1] = '<workspace>';
    assert.deepEqual(call, ['remote', '--workspace', '<workspace>', '--no-bypass-sandbox', '--', 'initial posix prompt']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init creates package metadata when package.json is absent and never writes AGENTS.md', () => {
  const workspace = tempWorkspace();
  try {
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    assert.equal(existsSync(join(workspace, 'package.json')), true);
    assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
    assert.equal(existsSync(join(workspace, '.codex', 'config.toml')), true);
    const config = readFileSync(join(workspace, '.codex', 'config.toml'), 'utf8');
    if (process.platform === 'win32') {
      assert.match(config, /command = "\.codex-agent-session-manager\/windows-hidden-stdio-launcher\.exe"/u);
      assert.match(config, /args = \["node", "node_modules\/codex-agent-session-manager\/dist\/cli\.js", "serve"\]/u);
    } else {
      assert.match(config, /command = "node"/u);
      assert.match(config, /args = \["node_modules\/codex-agent-session-manager\/dist\/cli\.js", "serve"\]/u);
    }
    assert.match(config, /cwd = "\."/u);
    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      private?: boolean;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.scripts?.['codex:remote'], `${packageName} remote`);
    assert.equal(packageJson.devDependencies?.[packageName], packageVersion);
    assert.equal(existsSync(join(workspace, '.gitignore')), true);
    assert.ok(plan.actions.some((action) => action.kind === 'create' && action.target.endsWith('package.json')));
    assert.ok(plan.actions.some((action) => action.kind === 'run' && action.command?.[0] === 'npm'));
    assert.equal(plan.actions.some((action) => action.target.endsWith('AGENTS.md')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('init accepts package.json with UTF-8 BOM', () => {
  const workspace = tempWorkspace();
  try {
    writeFileSync(join(workspace, 'package.json'), `\uFEFF${JSON.stringify({ name: 'bom-project' }, null, 2)}\n`);

    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['codex:init'], `${packageName} init`);
    assert.equal(packageJson.scripts?.['codex:remote:dry-run'], `${packageName} remote --dry-run --no-resume`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated PowerShell supervisor consumes shell resume-next state through managed remote', (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const path = require('node:path');
const workspace = process.cwd();
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
if (args[0] !== 'remote') {
  console.error('unexpected args: ' + JSON.stringify(args));
  process.exit(2);
}
const logPath = ${JSON.stringify(logPath)};
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const markerPath = path.join(workspace, '.codex-agent-session-manager', 'state', 'state-written.marker');
if (!fs.existsSync(markerPath)) {
  const stateDir = path.dirname(markerPath);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(markerPath, 'written\\n');
  fs.writeFileSync(path.join(stateDir, 'shell-resume-next.json'), JSON.stringify({
    mode: 'managed-remote',
    resumeMode: 'current',
    threadId: 'thread-a',
    prompt: 'followup prompt',
    bypassSandbox: false,
    enableImageGeneration: true
  }, null, 2) + '\\n');
}
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1');
    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, 'initial prompt'],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    const expectedWorkspace = realpathSync.native(workspace);
    assert.deepEqual(calls, [
      ['remote', '--workspace', expectedWorkspace, '--', 'initial prompt'],
      [
        'remote',
        '--workspace',
        expectedWorkspace,
        '--resume',
        'thread-a',
        '--enable-image-generation',
        '--no-bypass-sandbox',
        '--prompt',
        'followup prompt',
      ],
    ]);
    assert.doesNotMatch(JSON.stringify(calls), /--dangerously-bypass-approvals-and-sandbox|--disable|js_repl|"-C"/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('generated PowerShell supervisor routes no-arg codex without empty prompt', (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-noargs.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1');
    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[];
    assert.deepEqual(call, ['remote', '--workspace', realpathSync.native(workspace)]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('generated PowerShell supervisor routes native sandbox bypass flag through managed remote', (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-bypass.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1');
    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, '--dangerously-bypass-approvals-and-sandbox', 'initial prompt'],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[];
    assert.deepEqual(call, ['remote', '--workspace', realpathSync.native(workspace), '--', '--dangerously-bypass-approvals-and-sandbox', 'initial prompt']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('generated PowerShell supervisor routes managed no-bypass flag through managed remote', (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const logPath = join(workspace, 'remote-argv-no-bypass.jsonl');
    const localCli = join(workspace, 'node_modules', packageName, 'dist', 'cli.js');
    writeFileSync(
      localCli,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === '--help') {
  console.log('remote help with --prompt');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1');
    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, '--no-bypass-sandbox', 'initial prompt'],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[];
    assert.deepEqual(call, ['remote', '--workspace', realpathSync.native(workspace), '--no-bypass-sandbox', '--', 'initial prompt']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('generated PowerShell supervisor delegates native Codex subcommands to the real CLI', (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    try {
    writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: 'target-project' }, null, 2)}\n`);
    const plan = buildInitPlan({ workspace });
    applyInitPlan(plan, fakeInstaller(workspace));

    const binDir = join(workspace, 'fake-bin');
    const logPath = join(workspace, 'real-codex-argv.txt');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'codex.cmd'),
      '@echo off\r\necho %*>>"%REAL_CODEX_LOG%"\r\nexit /b 0\r\n',
      'utf8',
    );

    const supervisor = join(workspace, '.codex-agent-session-manager', 'shell', 'codex.ps1');
    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, 'mcp', 'list'],
      {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${binDir};${process.env.PATH ?? ''}`,
          REAL_CODEX_LOG: logPath,
        },
      },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'mcp list');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
