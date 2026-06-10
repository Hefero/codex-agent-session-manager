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
  assert.throws(() => parseRemoteArgs(['--resume', 'thread-a', '--session-id', 'thread-b']), /--session-id or --resume/u);
  assert.deepEqual(parseRemoteArgs(['--port', '4506', '--no-resume']), {
    port: '4506',
    noResume: true,
  });
  assert.deepEqual(parseRemoteArgs(['--resume', 'thread-a']), {
    sessionId: 'thread-a',
  });
  assert.deepEqual(parseRemoteArgs(['--dangerously-bypass-approvals-and-sandbox']), {
    noBypassSandbox: false,
  });
  assert.deepEqual(parseRemoteArgs(['--workspace', 'project-a', '--', '--model', 'gpt-5', '--search', 'hello']), {
    workspace: 'project-a',
    codexArgs: ['--model', 'gpt-5', '--search', 'hello'],
  });
});

test('buildRemotePlan treats --resume alias as a session resume with default sandbox bypass', async () => {
  const workspace = tempWorkspace();
  try {
    const options = parseRemoteArgs(['--workspace', workspace, '--port', '4506', '--resume', 'thread-a']);
    const plan = await buildRemotePlan(
      options,
      { codexCommandResolver: () => 'codex-test' },
    );

    assert.equal(plan.mode, 'session');
    assert.deepEqual(plan.tui.args.slice(0, 2), ['resume', 'thread-a']);
    assert.equal(plan.tui.args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRemotePlan forwards non-secret prompt to launched Codex TUI', async () => {
  const workspace = tempWorkspace();
  try {
    const options = parseRemoteArgs(['--workspace', workspace, '--port', '4506', '--resume', 'thread-a', '--prompt', 'hello managed remote']);
    const plan = await buildRemotePlan(
      options,
      { codexCommandResolver: () => 'codex-test' },
    );

    assert.equal(plan.tui.promptIncluded, true);
    assert.deepEqual(plan.tui.args.slice(0, 2), ['resume', 'thread-a']);
    assert.equal(plan.tui.args.at(-1), 'hello managed remote');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRemotePlan preserves native Codex argv after passthrough separator', async () => {
  const workspace = tempWorkspace();
  try {
    const options = parseRemoteArgs(['--workspace', workspace, '--port', '4506', '--', '--model', 'gpt-5', '--search', 'hello passthrough']);
    const plan = await buildRemotePlan(
      options,
      { codexCommandResolver: () => 'codex-test' },
    );

    assert.equal(plan.tui.promptIncluded, true);
    assert.equal(plan.tui.args.includes('--remote'), true);
    assert.equal(plan.tui.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.deepEqual(plan.tui.args.slice(-4), ['--model', 'gpt-5', '--search', 'hello passthrough']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRemotePlan preserves native App Server argv while owning listen URL', async () => {
  const workspace = tempWorkspace();
  try {
    const plan = await buildRemotePlan(
      {
        workspace,
        port: '4506',
        noResume: true,
        appServerArgs: ['--config', 'model="gpt-5"', '--enable', 'js_repl', '--enable', 'image_generation'],
      },
      { codexCommandResolver: () => 'codex-test' },
    );

    assert.deepEqual(plan.server.args, [
      'app-server',
      '--listen',
      'ws://127.0.0.1:4506',
      '--config',
      'model="gpt-5"',
      '--enable',
      'js_repl',
      '--enable',
      'image_generation',
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildRemotePlan rejects native App Server listen transport overrides', async () => {
  const workspace = tempWorkspace();
  try {
    await assert.rejects(
      () => buildRemotePlan(
        {
          workspace,
          port: '4506',
          noResume: true,
          appServerArgs: ['--listen', 'stdio://'],
        },
        { codexCommandResolver: () => 'codex-test' },
      ),
      /owns --listen\/--stdio/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

test('runRemoteCommand dry run redacts prompt text', async () => {
  const workspace = tempWorkspace();
  const output: string[] = [];
  try {
    const exitCode = await runRemoteCommand(
      ['--workspace', workspace, '--port', '4506', '--dry-run', '--prompt', 'secret prompt text'],
      {
        codexCommandResolver: () => 'codex-test',
        output: (text) => output.push(text),
      },
    );

    assert.equal(exitCode, 0);
    const text = output.join('\n');
    assert.match(text, /"<prompt>"/u);
    assert.doesNotMatch(text, /secret prompt text/u);
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
