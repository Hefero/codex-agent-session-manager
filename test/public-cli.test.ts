import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePublicCommand, runPublicCommand } from '../src/public-cli.js';

test('parsePublicCommand maps app-server lifecycle commands', () => {
  assert.deepEqual(parsePublicCommand(['app-server', 'start', '--port', '4566', '--confirm']), {
    command: 'app-server',
    subcommand: 'start',
    input: {
      port: '4566',
      confirm: true,
      dryRun: false,
    },
  });

  assert.deepEqual(parsePublicCommand(['app-server', 'status', '--no-probe-ready', '--no-process-tree']), {
    command: 'app-server',
    subcommand: 'status',
    input: {
      probeReady: false,
      includeProcessTree: false,
    },
  });

  assert.deepEqual(parsePublicCommand(['app-server', 'stop', '--dry-run', '--timeout-ms', '5000']), {
    command: 'app-server',
    subcommand: 'stop',
    input: {
      dryRun: true,
      timeoutMs: 5_000,
    },
  });
});

test('parsePublicCommand maps mcp refresh with repeated highlight tools', () => {
  assert.deepEqual(
    parsePublicCommand([
      'mcp',
      'refresh',
      '--url',
      'ws://127.0.0.1:4566',
      '--thread-id',
      'thread-a',
      '--highlight-tool',
      'tool-a',
      '--highlight-tool',
      'tool-b',
      '--continuation-timeout-ms',
      '10000',
    ]),
    {
      command: 'mcp',
      subcommand: 'refresh',
      input: {
        appServerUrl: 'ws://127.0.0.1:4566',
        threadId: 'thread-a',
        highlightTools: ['tool-a', 'tool-b'],
        continuationTimeoutMs: 10_000,
      },
    },
  );
});

test('parsePublicCommand maps mcp add npm', () => {
  assert.deepEqual(
    parsePublicCommand([
      'mcp',
      'add',
      'npm',
      '@modelcontextprotocol/server-everything',
      '--server-name',
      'everything',
      '--arg',
      'stdio',
      '--dry-run',
    ]),
    {
      command: 'mcp',
      subcommand: 'add-npm',
      input: {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        extraArgs: ['stdio'],
        dryRun: true,
      },
    },
  );
});

test('parsePublicCommand maps session commands', () => {
  assert.deepEqual(parsePublicCommand(['session', 'launch', '--thread-id', 'thread-a', '--confirm', '--bypass-sandbox']), {
    command: 'session',
    subcommand: 'launch',
    input: {
      threadId: 'thread-a',
      bypassSandbox: true,
      confirm: true,
      dryRun: false,
    },
  });

  assert.deepEqual(parsePublicCommand(['session', 'close', '--thread-id', 'thread-a', '--delay-ms', '0']), {
    command: 'session',
    subcommand: 'close',
    input: {
      threadId: 'thread-a',
      delayMs: 0,
    },
  });

  assert.deepEqual(parsePublicCommand(['session', 'replace', '--thread-id', 'thread-a', '--prompt', 'hello']), {
    command: 'session',
    subcommand: 'replace',
    input: {
      threadId: 'thread-a',
      prompt: 'hello',
    },
  });
});

test('runPublicCommand prints JSON for app-server start dry-run', async () => {
  const output: string[] = [];
  const exitCode = await runPublicCommand(
    ['app-server', 'start', '--dry-run', '--port', '4566'],
    { output: (text) => output.push(text) },
  );

  assert.equal(exitCode, 0);
  const payload = JSON.parse(output.join('\n')) as { ok?: boolean; dryRun?: boolean; plan?: { appServerUrl?: string } };
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.plan?.appServerUrl, 'ws://127.0.0.1:4566');
});

test('runPublicCommand reports missing required thread id', async () => {
  await assert.rejects(
    () => runPublicCommand(['session', 'close', '--url', 'ws://127.0.0.1:4566']),
    /--thread-id is required/u,
  );
});
