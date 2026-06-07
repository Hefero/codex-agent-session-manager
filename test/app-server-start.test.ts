import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { RemoteOptions, RemotePlan } from '../src/remote.js';
import { OperationStore } from '../src/tools/operations.js';
import {
  buildAppServerStartOperationArgs,
  buildAppServerStartPayload,
  parseAppServerStartOperationArgs,
  runAppServerStartOperation,
} from '../src/tools/app-server-start.js';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-app-server-start-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function tempStore(): { workspace: string; store: OperationStore; cleanup(): void } {
  const workspace = tempWorkspace();
  const store = new OperationStore({ workspace });
  return {
    workspace,
    store,
    cleanup() {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function fakePlan(options: RemoteOptions): RemotePlan {
  const workspace = resolve(options.workspace ?? process.cwd());
  const appServerUrl = options.url ?? 'ws://127.0.0.1:4555';
  return {
    workspace,
    appServerUrl,
    source: options.url ? 'argument-url' : 'port-auto',
    codexCommand: 'codex-test',
    mode: 'fresh',
    startsAppServer: options.url === undefined,
    noResume: options.noResume === true,
    server: {
      command: 'codex-test',
      args: ['app-server', '--listen', appServerUrl],
      stdoutLog: join(workspace, '.codex-agent-session-manager', 'logs', 'app-server.out.log'),
      stderrLog: join(workspace, '.codex-agent-session-manager', 'logs', 'app-server.err.log'),
    },
    tui: {
      command: 'codex-test',
      args: ['--remote', appServerUrl],
    },
    stateFile: join(workspace, '.codex-agent-session-manager', 'state', 'app-server.json'),
  };
}

test('buildAppServerStartPayload dry run previews managed no-resume plan', async () => {
  const seenOptions: RemoteOptions[] = [];
  const payload = await buildAppServerStartPayload(
    {
      port: '4555',
    },
    {
      planBuilder: async (options) => {
        seenOptions.push(options);
        return fakePlan(options);
      },
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.confirmRequired, true);
  assert.equal(seenOptions[0]?.noResume, true);
  assert.equal(seenOptions[0]?.port, '4555');
  assert.match(JSON.stringify(payload), /app-server/u);
});

test('buildAppServerStartPayload refuses real start without confirm', async () => {
  const payload = await buildAppServerStartPayload(
    {
      appServerUrl: 'ws://127.0.0.1:4556',
      dryRun: false,
    },
    {
      planBuilder: async (options) => fakePlan(options),
      scheduler() {
        throw new Error('scheduler should not run without confirm');
      },
    },
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.refused, true);
  assert.equal(payload.confirmRequired, true);
});

test('buildAppServerStartPayload schedules durable App Server start operation', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const scheduledInputs: unknown[] = [];
    const payload = await buildAppServerStartPayload(
      {
        appServerUrl: 'ws://127.0.0.1:4557',
        dryRun: false,
        confirm: true,
        enableImageGeneration: true,
      },
      {
        store,
        planBuilder: async (options) => fakePlan(options),
        scheduler(input) {
          scheduledInputs.push(input);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-app-server-start-operation',
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        appServerUrl: 'ws://127.0.0.1:4557',
        workspace: resolve(process.cwd()),
        enableImageGeneration: true,
      },
    ]);
    assert.equal(store.read(String(payload.operationId))?.kind, 'app_server_start');
  } finally {
    fixture.cleanup();
  }
});

test('runAppServerStartOperation records executor result and output', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-start',
      kind: 'app_server_start',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const operation = await runAppServerStartOperation(
      {
        operationId: 'op-start',
        appServerUrl: 'ws://127.0.0.1:4558',
        workspace: resolve(process.cwd()),
      },
      {
        store,
        planBuilder: async (options) => fakePlan(options),
        executor: async (_plan, deps) => {
          deps?.output?.('NoResume set; leaving App Server available at ws://127.0.0.1:4558');
          return 0;
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.match(JSON.stringify(operation?.evidence), /NoResume set/u);
  } finally {
    fixture.cleanup();
  }
});

test('runAppServerStartOperation uses operation store from input workspace by default', async () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    store.create({
      id: 'op-start-workspace',
      kind: 'app_server_start',
      status: 'running',
    });

    await runAppServerStartOperation(
      {
        operationId: 'op-start-workspace',
        appServerUrl: 'ws://127.0.0.1:4560',
        workspace,
      },
      {
        planBuilder: async (options) => fakePlan(options),
        executor: async () => 0,
      },
    );

    assert.equal(store.read('op-start-workspace')?.status, 'completed');
  } finally {
    fixture.cleanup();
  }
});

test('app server start operation argv round trips', () => {
  const workspace = resolve(process.cwd());
  const args = buildAppServerStartOperationArgs({
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4559',
    workspace,
    enableImageGeneration: true,
  });

  assert.deepEqual(parseAppServerStartOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4559',
    workspace,
    enableImageGeneration: true,
  });
});
