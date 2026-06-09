import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runShellHookCommand } from '../src/shell-hook.js';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-shell-hook-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

test('shell-hook install defaults to dry-run and does not write profile', async () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'profile.sh');
  const output: string[] = [];
  try {
    const exitCode = await runShellHookCommand(['install', '--shell', 'bash', '--profile', profile], {
      output: (text) => output.push(text),
    });

    assert.equal(exitCode, 0);
    assert.equal(existsSync(profile), false);
    assert.match(output.join('\n'), /Dry run only/u);
    assert.match(output.join('\n'), /shell: bash/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('shell-hook install and uninstall manage only the marked PowerShell profile block', async () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  try {
    mkdirSync(join(workspace, 'WindowsPowerShell'), { recursive: true });
    writeFileSync(profile, "Write-Host 'before'\n", 'utf8');

    await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--confirm'], { output: () => undefined });
    const installed = readFileSync(profile, 'utf8');
    assert.match(installed, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(installed, /function global:codex/u);
    assert.match(installed, /Write-Host 'before'/u);

    const statusOutput: string[] = [];
    await runShellHookCommand(['status', '--shell', 'powershell', '--profile', profile], { output: (text) => statusOutput.push(text) });
    assert.match(statusOutput.join('\n'), /installed: true/u);
    assert.match(statusOutput.join('\n'), /shell: powershell/u);

    await runShellHookCommand(['uninstall', '--shell', 'powershell', '--profile', profile, '--confirm'], { output: () => undefined });
    const uninstalled = readFileSync(profile, 'utf8');
    assert.doesNotMatch(uninstalled, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(uninstalled, /Write-Host 'before'/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('shell-hook installs bash and zsh profile functions that delegate to codex.mjs', async () => {
  const workspace = tempWorkspace();
  const bashProfile = join(workspace, '.bashrc');
  const zshProfile = join(workspace, '.zshrc');
  try {
    await runShellHookCommand(['install', '--shell', 'bash', '--profile', bashProfile, '--confirm'], { output: () => undefined });
    const bashHook = readFileSync(bashProfile, 'utf8');
    assert.match(bashHook, /codex\(\) \{/u);
    assert.match(bashHook, /\.codex-agent-session-manager\/shell\/codex\.mjs/u);
    assert.match(bashHook, /node "\$hook" "\$@"/u);
    assert.match(bashHook, /command codex "\$@"/u);

    await runShellHookCommand(['install', '--shell', 'zsh', '--profile', zshProfile, '--confirm'], { output: () => undefined });
    const zshHook = readFileSync(zshProfile, 'utf8');
    assert.match(zshHook, /codex\(\) \{/u);
    assert.match(zshHook, /\.codex-agent-session-manager\/shell\/codex\.mjs/u);

    await runShellHookCommand(['uninstall', '--shell', 'bash', '--profile', bashProfile, '--confirm'], { output: () => undefined });
    assert.doesNotMatch(readFileSync(bashProfile, 'utf8'), /BEGIN codex-agent-session-manager:shell-hook/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('bash shell hook routes initialized workspace codex calls to the POSIX supervisor when bash is available', async (t) => {
  const workspace = tempWorkspace();
  if (process.platform === 'win32') {
    t.skip('bash runtime hook probe is skipped on Windows');
    rmSync(workspace, { recursive: true, force: true });
    return;
  }

  const probe = spawnSync('bash', ['-lc', 'printf ok'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0 || probe.stdout !== 'ok') {
    t.skip('bash is not available on this host');
    rmSync(workspace, { recursive: true, force: true });
    return;
  }

  const project = join(workspace, 'project');
  const profile = join(workspace, 'profile.bash');
  const logPath = join(workspace, 'hook-args.jsonl');
  try {
    mkdirSync(join(project, 'subdir'), { recursive: true });
    mkdirSync(join(project, '.codex-agent-session-manager', 'shell'), { recursive: true });
    writeFileSync(
      join(project, '.codex-agent-session-manager', 'shell', 'codex.mjs'),
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
      'utf8',
    );

    await runShellHookCommand(['install', '--shell', 'bash', '--profile', profile, '--confirm'], { output: () => undefined });
    const result = spawnSync('bash', ['-lc', 'source ./profile.bash && cd ./project/subdir && codex "hello bash" --flag'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(logPath, 'utf8').trim()) as string[], ['hello bash', '--flag']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
