import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { appServerStateFileForWorkspace, writeAppServerState } from '../src/app-server/state.js';
import { buildRemotePlan, executeRemotePlan, parseRemoteArgs, runRemoteCommand } from '../src/remote.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-remote-'));
}

test('parseRemoteArgs rejects conflicting resume modes', () => {
  assert.throws(() => parseRemoteArgs(['--session-id', 'thread-a', '--resume-last']), /Choose only one/u);
  assert.deepEqual(parseRemoteArgs(['--port', '4506', '--no-resume']), {
    port: '4506',
    noResume: true,
  });
});

test('buildRemotePlan ignores legacy state and uses primary state only', async () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex-mcp-hot-reloader', 'state'), { recursive: true });
    writeFileSync(
      appServerStateFileForWorkspace(workspace, 'legacy'),
      `${JSON.stringify({ url: 'ws://127.0.0.1:4510', status: 'ready' })}\n`,
    );

    const first = await buildRemotePlan(
      { workspace, noResume: true },
      { codexCommandResolver: () => 'codex-test', freePort: async () => 4511 },
    );
    assert.equal(first.source, 'port-auto');
    assert.equal(first.appServerUrl, 'ws://127.0.0.1:4511');
    assert.equal(first.startsAppServer, true);

    writeAppServerState({ url: 'ws://127.0.0.1:4512', status: 'ready', owned: true }, workspace);
    const second = await buildRemotePlan(
      { workspace, noResume: true },
      { codexCommandResolver: () => 'codex-test', freePort: async () => 4513 },
    );
    assert.equal(second.source, 'primary-state');
    assert.equal(second.appServerUrl, 'ws://127.0.0.1:4512');
    assert.equal(second.startsAppServer, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runRemoteCommand dry run redacts workspace and prints traditional commands', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    const exitCode = await runRemoteCommand(
      ['--workspace', workspace, '--port', '4506', '--dry-run', '--no-resume'],
      {
        codexCommandResolver: () => 'codex-test',
        output: (text) => output.push(text),
      },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.doesNotMatch(text, new RegExp(escapeRegExp(resolve(workspace)), 'u'));
    assert.match(text, /"source": "port-argument"/u);
    assert.match(text, /"app-server"/u);
    assert.match(text, /"--remote"/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRemotePlan wraps Windows App Server process with hidden launcher only', async () => {
  const workspace = tempWorkspace();
  try {
    const codexCommand = join(workspace, 'codex.exe');
    writeFileSync(codexCommand, '');

    const plan = await buildRemotePlan(
      { workspace, port: '4506', noResume: true, dryRun: true },
      { codexCommandResolver: () => codexCommand },
    );

    if (process.platform === 'win32') {
      assert.equal(plan.server.command, join(workspace, '.codex-agent-session-manager', 'windows-hidden-stdio-launcher.exe'));
      assert.equal(plan.server.args[0], codexCommand);
      assert.equal(plan.tui.command, codexCommand);
    } else {
      assert.equal(plan.server.command, codexCommand);
      assert.equal(plan.server.args[0], 'app-server');
      assert.equal(plan.tui.command, codexCommand);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('executeRemotePlan starts App Server in no-resume mode and writes primary state', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    const plan = await buildRemotePlan(
      { workspace, port: '4506', noResume: true },
      { codexCommandResolver: () => 'codex-test' },
    );
    let readyCalls = 0;
    let tuiCalled = false;
    const exitCode = await executeRemotePlan(plan, {
      output: (text) => output.push(text),
      readyProbe: async () => {
        readyCalls += 1;
        return readyCalls > 1;
      },
      codexProbe: async () => true,
      appServerSpawner: () => ({ pid: 123 }),
      tuiSpawner: async () => {
        tuiCalled = true;
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(tuiCalled, false);
    assert.match(output.join('\n'), /NoResume set/u);
    const state = JSON.parse(readFileSync(appServerStateFileForWorkspace(workspace, 'primary'), 'utf8')) as {
      url?: string;
      pid?: number;
      owned?: boolean;
      status?: string;
    };
    assert.equal(state.url, 'ws://127.0.0.1:4506');
    assert.equal(state.pid, 123);
    assert.equal(state.owned, true);
    assert.equal(state.status, 'ready');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
