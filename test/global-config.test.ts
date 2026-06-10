import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { applyGlobalPlan, buildGlobalPlan, parseGlobalArgs, runGlobalCommand } from '../src/global-config.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-global-'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('parseGlobalArgs maps global install options', () => {
  assert.deepEqual(
    parseGlobalArgs([
      'install',
      '--config',
      'config.toml',
      '--state-dir',
      'state',
      '--shell-hook-profile',
      'profile.ps1',
      '--shell-hook-shell',
      'powershell',
      '--shell-hook-wsl-prefer-linux-path',
      '--confirm',
      '--json',
    ]),
    {
      subcommand: 'install',
      config: 'config.toml',
      stateDir: 'state',
      shellHookProfile: 'profile.ps1',
      shellHookShell: 'powershell',
      shellHookWslPreferLinuxPath: true,
      confirm: true,
      json: true,
    },
  );

  assert.throws(
    () => parseGlobalArgs(['install', '--mcp-only', '--shell-hook-only']),
    /Choose only one of --mcp-only or --shell-hook-only/u,
  );
  assert.throws(
    () => parseGlobalArgs(['install', '--mcp-only', '--shell-hook-wsl-prefer-linux-path']),
    /cannot be used with --mcp-only/u,
  );
});

test('global install can opt into WSL Linux PATH preference for bash hook', () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const profile = join(workspace, 'profile.bash');
  const stateDir = join(workspace, 'state');
  try {
    const plan = buildGlobalPlan({
      subcommand: 'install',
      confirm: true,
      shellHookOnly: true,
      config,
      stateDir,
      shellHookShell: 'bash',
      shellHookProfile: profile,
      shellHookWslPreferLinuxPath: true,
    });
    applyGlobalPlan(plan, {
      prepareWindowsHiddenLauncher: () => null,
    });

    const installedProfile = readFileSync(profile, 'utf8');
    assert.match(installedProfile, /codex_asm_prefer_wsl_linux_path/u);
    assert.match(installedProfile, /resolves to a Windows shim under \/mnt\/c/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global install defaults to dry-run and writes nothing', async () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const profile = join(workspace, 'profile.ps1');
  const stateDir = join(workspace, 'state');
  const output: string[] = [];
  try {
    const exitCode = await runGlobalCommand(
      ['install', '--config', config, '--state-dir', stateDir, '--shell-hook-profile', profile, '--shell-hook-shell', 'powershell'],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    assert.equal(existsSync(config), false);
    assert.equal(existsSync(profile), false);
    const text = output.join('\n');
    assert.match(text, /global install dry-run/u);
    assert.match(text, /Dry run only/u);
    assert.match(text, /install user-global MCP server/u);
    assert.match(text, /install PowerShell codex function hook/u);
    assert.doesNotMatch(text, /Reload this shell/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global install and uninstall manage MCP config and shell hook', () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const profile = join(workspace, 'profile.ps1');
  const stateDir = join(workspace, 'state');
  try {
    const plan = buildGlobalPlan({
      subcommand: 'install',
      confirm: true,
      config,
      stateDir,
      shellHookShell: 'powershell',
      shellHookProfile: profile,
    });
    applyGlobalPlan(plan, {
      prepareWindowsHiddenLauncher(directory) {
        mkdirSync(directory, { recursive: true });
        const launcher = join(directory, 'windows-hidden-stdio-launcher.exe');
        writeFileSync(launcher, '');
        return launcher;
      },
    });

    const installedConfig = readFileSync(config, 'utf8');
    assert.match(installedConfig, /BEGIN codex-agent-session-manager:global/u);
    assert.match(installedConfig, /\[mcp_servers\.codex_agent_session_manager\]/u);
    assert.match(installedConfig, /args = /u);
    assert.match(installedConfig, /serve/u);

    const installedProfile = readFileSync(profile, 'utf8');
    assert.match(installedProfile, /BEGIN codex-agent-session-manager:shell-hook/u);
    assert.match(installedProfile, /function global:codex/u);
    assert.match(installedProfile, /Resolve-CodexAgentSessionManagerCli/u);
    assert.match(installedProfile, /Convert-CodexArgsToManagedRemoteArgs/u);

    const status = buildGlobalPlan({
      subcommand: 'status',
      config,
      stateDir,
      shellHookShell: 'powershell',
      shellHookProfile: profile,
    });
    assert.equal(status.mcpInstalled, true);
    assert.equal(status.shellHookInstalled, true);

    const uninstall = buildGlobalPlan({
      subcommand: 'uninstall',
      confirm: true,
      config,
      stateDir,
      shellHookShell: 'powershell',
      shellHookProfile: profile,
    });
    applyGlobalPlan(uninstall);

    assert.equal(existsSync(config), false);
    assert.doesNotMatch(readFileSync(profile, 'utf8'), /BEGIN codex-agent-session-manager:shell-hook/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global install applied output reports post-apply installed state', async () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const profile = join(workspace, 'profile.ps1');
  const stateDir = join(workspace, 'state');
  const output: string[] = [];
  try {
    const exitCode = await runGlobalCommand(
      [
        'install',
        '--confirm',
        '--config',
        config,
        '--state-dir',
        stateDir,
        '--shell-hook-shell',
        'powershell',
        '--shell-hook-profile',
        profile,
      ],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.match(text, /global install applied/u);
    assert.match(text, /mcp: installed/u);
    assert.match(text, /shell-hook: installed/u);
    assert.match(text, new RegExp(`\\. '${escapeRegExp(profile)}'`, 'u'));
    assert.match(readFileSync(profile, 'utf8'), /Convert-CodexArgsToManagedRemoteArgs/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global mcp-only leaves shell profile untouched', () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const profile = join(workspace, 'profile.ps1');
  const stateDir = join(workspace, 'state');
  try {
    writeFileSync(profile, "Write-Host 'keep'\n", 'utf8');
    const plan = buildGlobalPlan({
      subcommand: 'install',
      confirm: true,
      mcpOnly: true,
      config,
      stateDir,
      shellHookShell: 'powershell',
      shellHookProfile: profile,
    });
    applyGlobalPlan(plan, {
      prepareWindowsHiddenLauncher(directory) {
        mkdirSync(directory, { recursive: true });
        const launcher = join(directory, 'windows-hidden-stdio-launcher.exe');
        writeFileSync(launcher, '');
        return launcher;
      },
    });

    assert.match(readFileSync(config, 'utf8'), /codex_agent_session_manager/u);
    assert.equal(readFileSync(profile, 'utf8'), "Write-Host 'keep'\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global install refuses unmanaged MCP server section', () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  try {
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    writeFileSync(config, '[mcp_servers.codex_agent_session_manager]\ncommand = "custom"\n', 'utf8');

    assert.throws(
      () => buildGlobalPlan({ subcommand: 'install', confirm: true, config, mcpOnly: true }),
      /already has an unmanaged \[mcp_servers\.codex_agent_session_manager\] section/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('global JSON preview includes state and component flags', async () => {
  const workspace = tempWorkspace();
  const config = join(workspace, '.codex', 'config.toml');
  const stateDir = join(workspace, 'state');
  const output: string[] = [];
  try {
    const exitCode = await runGlobalCommand(
      ['status', '--mcp-only', '--config', config, '--state-dir', stateDir, '--json'],
      { output: (text) => output.push(text) },
    );

    assert.equal(exitCode, 0);
    const payload = JSON.parse(output.join('\n')) as {
      configPath?: string;
      stateDir?: string;
      mcpEnabled?: boolean;
      shellHookEnabled?: boolean;
    };
    assert.equal(payload.configPath, resolve(config));
    assert.equal(payload.stateDir, resolve(stateDir));
    assert.equal(payload.mcpEnabled, true);
    assert.equal(payload.shellHookEnabled, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
