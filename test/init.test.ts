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
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('parseInitArgs maps dry-run, workspace, json, agents opt-out, and shell hook opt-in', () => {
  assert.deepEqual(parseInitArgs(['--workspace', 'project-a', '--dry-run', '--json', '--no-agents', '--install-shell-hook', '--shell-hook-shell', 'bash', '--shell-hook-profile', 'profile.sh']), {
    workspace: 'project-a',
    dryRun: true,
    json: true,
    agents: false,
    installShellHook: true,
    shellHookShell: 'bash',
    shellHookProfile: 'profile.sh',
  });

  assert.throws(
    () => parseInitArgs(['--shell-hook-profile', 'profile.ps1']),
    /--shell-hook-profile requires --install-shell-hook/u,
  );
  assert.throws(
    () => parseInitArgs(['--shell-hook-shell', 'bash']),
    /--shell-hook-shell requires --install-shell-hook/u,
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

test('applyInitPlan creates project config, package scripts, gitignore, and AGENTS notes idempotently', () => {
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
    assert.doesNotMatch(shellCodex, /--dangerously-bypass-approvals-and-sandbox/u);
    assert.doesNotMatch(shellCodex, /Resolve-CodexAgentSessionManagerRealCodex/u);

    const posixCodex = readFileSync(join(workspace, '.codex-agent-session-manager', 'shell', 'codex.mjs'), 'utf8');
    assert.match(posixCodex, /convertCodexArgsToManagedRemoteArgs/u);
    assert.match(posixCodex, /convertShellResumeStateToManagedRemoteArgs/u);
    assert.match(posixCodex, /shouldDelegateToRealCodex/u);
    assert.match(posixCodex, /resolveRealCodexCli/u);
    assert.match(posixCodex, /remote', \.\.\.remoteArgs/u);
    assert.doesNotMatch(posixCodex, /dangerously-bypass-approvals-and-sandbox/u);

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
    assert.match(agents, /Prefer read-only scopes first/u);
    assert.match(agents, /Do not patch files under `node_modules`/u);
    assert.match(agents, /Do not validate by launching stdio MCP entrypoints/u);
    assert.match(agents, /orphan node\/cmd windows/u);
    assert.match(agents, /If env vars were created or changed after App Server started/u);
    assert.match(agents, /keep using `codex-agent-session-manager mcp refresh --thread-id <thread-id>`/u);
    assert.match(agents, /Direct MCP SDK calls\s+are diagnostic only/u);
    assert.match(agents, /When scheduling a continuation for the current thread/u);
    assert.match(agents, /do not call\s+`codex_operation_wait` or `codex_operation_read` from that same active turn/u);

    const second = buildInitPlan({ workspace });
    assert.equal(second.fileUpdates.length, 0);
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
      ['remote', '--workspace', '<workspace>', '--prompt', 'initial posix prompt'],
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

test('init creates package metadata when package.json is absent and honors --no-agents', () => {
  const workspace = tempWorkspace();
  try {
    const plan = buildInitPlan({ workspace, agents: false });
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
  if (process.platform !== 'win32') {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

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
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor, 'initial prompt'],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    const expectedWorkspace = realpathSync.native(workspace);
    assert.deepEqual(calls, [
      ['remote', '--workspace', expectedWorkspace, '--prompt', 'initial prompt'],
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
});

test('generated PowerShell supervisor delegates native Codex subcommands to the real CLI', (t) => {
  if (process.platform !== 'win32') {
    t.skip('PowerShell supervisor replay is Windows-only');
    return;
  }

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
      'powershell.exe',
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

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'mcp list');
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
