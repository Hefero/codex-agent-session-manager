import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePublicCommand, runPublicCommand } from '../src/public-cli.js';
import { OperationStore } from '../src/tools/operations.js';

function tempWorkspace(prefix = 'codex-agent-session-manager-public-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withCwd<T>(cwd: string, run: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

async function withCwdAsync<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

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

  assert.deepEqual(parsePublicCommand(['stop', '--confirm', '--delay-ms', '0']), {
    command: 'app-server',
    subcommand: 'stop',
    input: {
      confirm: true,
      dryRun: false,
      delayMs: 0,
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
      '--allow-scripts',
      '--dry-run',
    ]),
    {
      command: 'mcp',
      subcommand: 'add-npm',
      input: {
        packageSpec: '@modelcontextprotocol/server-everything',
        serverName: 'everything',
        extraArgs: ['stdio'],
        allowScripts: true,
        dryRun: true,
      },
    },
  );
});

test('parsePublicCommand maps mcp add npm env vars and empty extra args', () => {
  assert.deepEqual(
    parsePublicCommand([
      'mcp',
      'add',
      'npm',
      'tavily-mcp@latest',
      '--server-name',
      'tavily_search',
      '--env-var',
      'TAVILY_API_KEY',
      '--no-default-stdio-arg',
      '--dry-run',
    ]),
    {
      command: 'mcp',
      subcommand: 'add-npm',
      input: {
        packageSpec: 'tavily-mcp@latest',
        serverName: 'tavily_search',
        extraArgs: [],
        envVars: ['TAVILY_API_KEY'],
        dryRun: true,
      },
    },
  );

  assert.throws(
    () => parsePublicCommand(['mcp', 'add', 'npm', 'tavily-mcp', '--arg', 'stdio', '--no-default-stdio-arg']),
    /either --arg or --no-default-stdio-arg/u,
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

  assert.deepEqual(parsePublicCommand(['session', 'close', '--thread-id', 'thread-a', '--delay-ms', '0', '--allow-workspace-url-fallback']), {
    command: 'session',
    subcommand: 'close',
    input: {
      threadId: 'thread-a',
      delayMs: 0,
      allowWorkspaceUrlFallback: true,
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

test('parsePublicCommand maps operation commands', () => {
  assert.deepEqual(parsePublicCommand(['operation', 'read', '--operation-id', 'op-a']), {
    command: 'operation',
    subcommand: 'read',
    input: {
      operationId: 'op-a',
    },
  });

  assert.deepEqual(parsePublicCommand(['operation', 'wait', '--operation-id', 'op-a', '--timeout-ms', '5000', '--poll-ms', '250']), {
    command: 'operation',
    subcommand: 'wait',
    input: {
      operationId: 'op-a',
      timeoutMs: 5_000,
      pollMs: 250,
    },
  });
});

test('parsePublicCommand rejects ignored public CLI flags and extra positionals', () => {
  assert.throws(
    () => parsePublicCommand(['session', 'close', '--thread-id', 'thread-a', '--allow-scripts', '--confirm']),
    /Unknown option for session close: --allow-scripts/u,
  );

  assert.throws(
    () => parsePublicCommand(['app-server', 'status', '--confirm']),
    /Unknown option for app-server status: --confirm/u,
  );

  assert.throws(
    () => parsePublicCommand(['mcp', 'add', 'npm', 'tavily-mcp', 'extra']),
    /Unexpected argument for mcp add npm: extra/u,
  );

  assert.throws(
    () => parsePublicCommand(['session', 'launch', 'extra', '--dry-run']),
    /Unexpected argument for session launch: extra/u,
  );

  assert.throws(
    () => parsePublicCommand(['mcp', 'refresh', '--thread-id', 'thread-a', '--server-name', 'wrong']),
    /Unknown option for mcp refresh: --server-name/u,
  );

  assert.throws(
    () => parsePublicCommand(['operation', 'read', '--operation-id', 'op-a', '--confirm']),
    /Unknown option for operation read: --confirm/u,
  );
});

test('parsePublicCommand reads prompt files only from the current workspace', () => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace('codex-agent-session-manager-public-cli-outside-');
  try {
    writeFileSync(join(workspace, 'prompt.txt'), 'workspace prompt', 'utf8');
    writeFileSync(join(outside, 'secret.txt'), 'outside prompt', 'utf8');

    withCwd(workspace, () => {
      assert.deepEqual(parsePublicCommand(['session', 'replace', '--thread-id', 'thread-a', '--prompt-file', 'prompt.txt']), {
        command: 'session',
        subcommand: 'replace',
        input: {
          threadId: 'thread-a',
          prompt: 'workspace prompt',
        },
      });

      assert.throws(
        () => parsePublicCommand(['session', 'replace', '--thread-id', 'thread-a', '--prompt-file', join(outside, 'secret.txt')]),
        /must stay inside the workspace/u,
      );
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('parsePublicCommand rejects prompt-file symlink or junction escapes', (t) => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace('codex-agent-session-manager-public-cli-outside-');
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside prompt', 'utf8');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(workspace, 'linked-prompt.txt'), 'file');
    } catch {
      t.skip('symlink creation is unavailable in this environment');
      return;
    }

    withCwd(workspace, () => {
      assert.throws(
        () => parsePublicCommand(['mcp', 'refresh', '--thread-id', 'thread-a', '--prompt-file', 'linked-prompt.txt']),
        /symlink or junction/u,
      );
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('parsePublicCommand applies prompt length limits to prompt text and files', () => {
  const workspace = tempWorkspace();
  try {
    const longPrompt = 'x'.repeat(4_001);
    writeFileSync(join(workspace, 'long-prompt.txt'), longPrompt, 'utf8');

    withCwd(workspace, () => {
      assert.throws(
        () => parsePublicCommand(['session', 'launch', '--prompt', longPrompt]),
        /--prompt must be at most 4000 characters/u,
      );
      assert.throws(
        () => parsePublicCommand(['session', 'launch', '--prompt-file', 'long-prompt.txt']),
        /--prompt-file must be at most 4000 characters/u,
      );
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

test('runPublicCommand reads and waits for workspace operation state', async () => {
  const workspace = tempWorkspace();
  try {
    const store = new OperationStore({ workspace });
    store.create({
      id: 'op-public',
      kind: 'test',
      status: 'running',
      evidence: { threadId: 'thread-a' },
    });

    await withCwdAsync(workspace, async () => {
      const readOutput: string[] = [];
      const readCode = await runPublicCommand(['operation', 'read', '--operation-id', 'op-public'], {
        output: (text) => readOutput.push(text),
      });
      assert.equal(readCode, 0);
      const readPayload = JSON.parse(readOutput[0] ?? '{}') as {
        found?: boolean;
        operation?: { id?: string; status?: string; evidence?: { threadId?: string } };
      };
      assert.equal(readPayload.found, true);
      assert.equal(readPayload.operation?.id, 'op-public');
      assert.equal(readPayload.operation?.status, 'running');
      assert.equal(readPayload.operation?.evidence?.threadId, 'thread-a');

      const waitOutput: string[] = [];
      const waitCode = await runPublicCommand(['operation', 'wait', '--operation-id', 'op-public', '--timeout-ms', '0'], {
        output: (text) => waitOutput.push(text),
      });
      assert.equal(waitCode, 0);
      const waitPayload = JSON.parse(waitOutput[0] ?? '{}') as { found?: boolean; timedOut?: boolean; completed?: boolean };
      assert.equal(waitPayload.found, true);
      assert.equal(waitPayload.timedOut, true);
      assert.equal(waitPayload.completed, false);
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runPublicCommand reports missing required thread id', async () => {
  await assert.rejects(
    () => runPublicCommand(['session', 'close', '--url', 'ws://127.0.0.1:4566']),
    /--thread-id is required/u,
  );
});
