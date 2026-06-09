import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const profile = join(workspace, 'profile.ps1');
  const output: string[] = [];
  try {
    const exitCode = await runShellHookCommand(['install', '--profile', profile], {
      output: (text) => output.push(text),
    });

    assert.equal(exitCode, 0);
    assert.equal(existsSync(profile), false);
    assert.match(output.join('\n'), /Dry run only/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('shell-hook install and uninstall manage only the marked profile block', async () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  try {
    mkdirSync(join(workspace, 'WindowsPowerShell'), { recursive: true });
    writeFileSync(profile, "Write-Host 'before'\n", 'utf8');

    await runShellHookCommand(['install', '--profile', profile, '--confirm'], { output: () => undefined });
    const installed = readFileSync(profile, 'utf8');
    assert.match(installed, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(installed, /function global:codex/u);
    assert.match(installed, /Write-Host 'before'/u);

    const statusOutput: string[] = [];
    await runShellHookCommand(['status', '--profile', profile], { output: (text) => statusOutput.push(text) });
    assert.match(statusOutput.join('\n'), /installed: true/u);

    await runShellHookCommand(['uninstall', '--profile', profile, '--confirm'], { output: () => undefined });
    const uninstalled = readFileSync(profile, 'utf8');
    assert.doesNotMatch(uninstalled, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(uninstalled, /Write-Host 'before'/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
