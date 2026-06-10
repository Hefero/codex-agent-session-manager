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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
    assert.doesNotMatch(output.join('\n'), /Reload this shell/u);
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
    assert.doesNotMatch(installed, /global remote fallback/u);
    assert.doesNotMatch(installed, /codex-agent-session-manager remote/u);
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
    const bashOutput: string[] = [];
    await runShellHookCommand(['install', '--shell', 'bash', '--profile', bashProfile, '--confirm'], { output: (text) => bashOutput.push(text) });
    const bashHook = readFileSync(bashProfile, 'utf8');
    assert.match(bashHook, /codex\(\) \{/u);
    assert.match(bashHook, /\.codex-agent-session-manager\/shell\/codex\.mjs/u);
    assert.match(bashHook, /node "\$hook" "\$@"/u);
    assert.match(bashHook, /command codex "\$@"/u);
    assert.match(bashOutput.join('\n'), new RegExp(`source '${escapeRegExp(bashProfile)}'`, 'u'));

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

test('shell-hook can install global remote fallback mode explicitly', async () => {
  const workspace = tempWorkspace();
  const psProfile = join(workspace, 'profile.ps1');
  const bashProfile = join(workspace, 'profile.bash');
  try {
    await runShellHookCommand(['install', '--shell', 'powershell', '--profile', psProfile, '--global-remote-fallback', '--confirm'], { output: () => undefined });
    const psHook = readFileSync(psProfile, 'utf8');
    assert.match(psHook, /Resolve-CodexAgentSessionManagerCli/u);
    assert.match(psHook, /Convert-CodexArgsToManagedRemoteArgs/u);
    assert.ok(psHook.includes("$invokeArgs = @('remote') + @($remoteArgs)"));

    await runShellHookCommand(['install', '--shell', 'bash', '--profile', bashProfile, '--global-remote-fallback', '--confirm'], { output: () => undefined });
    const bashHook = readFileSync(bashProfile, 'utf8');
    assert.match(bashHook, /codex_asm_remote/u);
    assert.match(bashHook, /codex_asm_find_manager/u);
    assert.match(bashHook, /command "\$manager" remote --workspace/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('shell-hook WSL path preference refuses Windows manager shims in POSIX fallback', async () => {
  const workspace = tempWorkspace();
  const bashProfile = join(workspace, 'profile.bash');
  try {
    await runShellHookCommand([
      'install',
      '--shell',
      'bash',
      '--profile',
      bashProfile,
      '--global-remote-fallback',
      '--wsl-prefer-linux-path',
      '--confirm',
    ], { output: () => undefined });

    const bashHook = readFileSync(bashProfile, 'utf8');
    assert.match(bashHook, /codex_asm_prefer_wsl_linux_path/u);
    assert.match(bashHook, /\/mnt\/\[A-Za-z\]\/\*/u);
    assert.match(bashHook, /resolves to a Windows shim under \/mnt\/c/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('PowerShell global remote fallback routes no-arg codex without empty prompt', async (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell hook replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    const profile = join(workspace, 'profile.ps1');
    const binDir = join(workspace, 'bin');
    const logPath = join(workspace, 'manager-argv.txt');
    try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'codex-agent-session-manager.cmd'),
      '@echo off\r\necho %*>>"%ASM_MANAGER_LOG%"\r\nexit /b 0\r\n',
      'utf8',
    );
    await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--global-remote-fallback', '--confirm'], { output: () => undefined });

    const result = spawnSync(
      shellCommand,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${JSON.stringify(profile)}; codex`],
      {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${binDir};${process.env.PATH ?? ''}`,
          ASM_MANAGER_LOG: logPath,
        },
      },
    );

    assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
    const logged = readFileSync(logPath, 'utf8').trim();
    assert.match(logged, /^remote --workspace /u);
    assert.doesNotMatch(logged, /--prompt/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('PowerShell global remote fallback routes native sandbox bypass flag through managed remote', async (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell hook replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    const profile = join(workspace, 'profile.ps1');
    const binDir = join(workspace, 'bin');
    const logPath = join(workspace, 'manager-bypass-argv.txt');
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'codex-agent-session-manager.cmd'),
        '@echo off\r\necho %*>>"%ASM_MANAGER_LOG%"\r\nexit /b 0\r\n',
        'utf8',
      );
      await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--global-remote-fallback', '--confirm'], { output: () => undefined });

      const result = spawnSync(
        shellCommand,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${JSON.stringify(profile)}; codex --dangerously-bypass-approvals-and-sandbox 'hello bypass'`],
        {
          cwd: workspace,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${binDir};${process.env.PATH ?? ''}`,
            ASM_MANAGER_LOG: logPath,
          },
        },
      );

      assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
      const logged = readFileSync(logPath, 'utf8').trim();
      assert.match(logged, /^remote --workspace /u);
      assert.match(logged, /-- --dangerously-bypass-approvals-and-sandbox "hello bypass"$/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('PowerShell global remote fallback routes managed no-bypass flag through managed remote', async (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell hook replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    const profile = join(workspace, 'profile.ps1');
    const binDir = join(workspace, 'bin');
    const logPath = join(workspace, 'manager-no-bypass-argv.txt');
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'codex-agent-session-manager.cmd'),
        '@echo off\r\necho %*>>"%ASM_MANAGER_LOG%"\r\nexit /b 0\r\n',
        'utf8',
      );
      await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--global-remote-fallback', '--confirm'], { output: () => undefined });

      const result = spawnSync(
        shellCommand,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${JSON.stringify(profile)}; codex --no-bypass-sandbox 'hello no bypass'`],
        {
          cwd: workspace,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${binDir};${process.env.PATH ?? ''}`,
            ASM_MANAGER_LOG: logPath,
          },
        },
      );

      assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
      const logged = readFileSync(logPath, 'utf8').trim();
      assert.match(logged, /^remote --workspace /u);
      assert.match(logged, /--no-bypass-sandbox -- "hello no bypass"$/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('PowerShell global remote fallback preserves native Codex flags through passthrough argv', async (t) => {
  const shellCommands = availablePowerShellCommands();
  if (shellCommands.length === 0) {
    t.skip('PowerShell hook replay is Windows-only');
    return;
  }

  for (const shellCommand of shellCommands) {
    const workspace = tempWorkspace();
    const profile = join(workspace, 'profile.ps1');
    const binDir = join(workspace, 'bin');
    const logPath = join(workspace, 'manager-native-flags-argv.txt');
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'codex-agent-session-manager.cmd'),
        '@echo off\r\necho %*>>"%ASM_MANAGER_LOG%"\r\nexit /b 0\r\n',
        'utf8',
      );
      await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--global-remote-fallback', '--confirm'], { output: () => undefined });

      const result = spawnSync(
        shellCommand,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${JSON.stringify(profile)}; codex --model gpt-5 --search 'hello native flags'`],
        {
          cwd: workspace,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${binDir};${process.env.PATH ?? ''}`,
            ASM_MANAGER_LOG: logPath,
          },
        },
      );

      assert.equal(result.status, 0, `${shellCommand}\n${result.stdout}\n${result.stderr}`);
      const logged = readFileSync(logPath, 'utf8').trim();
      assert.match(logged, /^remote --workspace /u);
      assert.match(logged, /-- --model gpt-5 --search "hello native flags"$/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('shell-hook refreshes a marked PowerShell profile that starts with UTF-8 BOM', async () => {
  const workspace = tempWorkspace();
  const profile = join(workspace, 'profile.ps1');
  try {
    writeFileSync(
      profile,
      '\uFEFF# BEGIN codex-agent-session-manager:shell-hook\nold\n# END codex-agent-session-manager:shell-hook\n',
      'utf8',
    );

    const output: string[] = [];
    await runShellHookCommand(['install', '--shell', 'powershell', '--profile', profile, '--global-remote-fallback', '--confirm'], {
      output: (text) => output.push(text),
    });

    const installed = readFileSync(profile, 'utf8');
    assert.match(output.join('\n'), /refresh PowerShell codex function hook/u);
    assert.doesNotMatch(installed, /^old$/mu);
    assert.match(installed, /Convert-CodexArgsToManagedRemoteArgs/u);
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
