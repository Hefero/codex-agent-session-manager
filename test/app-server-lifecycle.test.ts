import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { appServerStateFileForWorkspace, readAppServerStateFile, writeAppServerState } from '../src/app-server/state.js';
import type { ProcessEntry } from '../src/processes.js';
import {
  buildAppServerStatusPayload,
  buildAppServerStopOperationArgs,
  buildAppServerStopPayload,
  parseAppServerStopOperationArgs,
  runAppServerStopOperation,
} from '../src/tools/app-server-lifecycle.js';
import { OperationStore } from '../src/tools/operations.js';

const appServerUrl = 'ws://127.0.0.1:59919';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-app-server-lifecycle-${crypto.randomUUID()}`);
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

function writeOwnedAppServerState(workspace: string, pid = 40): void {
  writeAppServerState(
    {
      url: appServerUrl,
      pid,
      owned: true,
      reusedServer: false,
      status: 'ready',
      workspace,
      updatedAt: '2026-06-07T00:00:00.000Z',
      log: {
        stdout: join(workspace, '.codex-agent-session-manager', 'logs', 'app-server.out.log'),
        stderr: join(workspace, '.codex-agent-session-manager', 'logs', 'app-server.err.log'),
      },
    },
    workspace,
  );
}

function processFixture(workspace: string): ProcessEntry[] {
  return [
    {
      pid: 40,
      parentPid: null,
      name: 'windows-hidden-stdio-launcher.exe',
      commandLine: `"${workspace}\\.codex-agent-session-manager\\windows-hidden-stdio-launcher.exe" codex.exe app-server --listen ${appServerUrl}`,
    },
    {
      pid: 41,
      parentPid: 40,
      name: 'codex.exe',
      commandLine: `codex.exe app-server --listen ${appServerUrl} -C "${workspace}"`,
    },
    {
      pid: 50,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe resume thread-a --remote ${appServerUrl} -C "${workspace}"`,
    },
  ];
}

test('buildAppServerStatusPayload reports managed state, process tree, and ready probe', async () => {
  const fixture = tempStore();
  const { workspace } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    const readyInputs: unknown[] = [];
    const payload = await buildAppServerStatusPayload(
      {
        probeReady: true,
        readyTimeoutMs: 250,
      },
      {
        workspace,
        processLister: () => processFixture(workspace),
        readyProbe: async (url, timeoutMs) => {
          readyInputs.push({ url, timeoutMs });
          return true;
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.deepEqual(readyInputs, [{ url: appServerUrl, timeoutMs: 250 }]);
    const target = payload.managedAppServer as { canStop?: boolean; processTreeCount?: number };
    assert.equal(target.canStop, true);
    assert.equal(target.processTreeCount, 2);
    assert.deepEqual(payload.ready, { probed: true, ok: true, timeoutMs: 250 });
  } finally {
    fixture.cleanup();
  }
});

test('buildAppServerStopPayload dry run reports target without creating operation', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    const payload = buildAppServerStopPayload(
      {
        dryRun: true,
      },
      {
        workspace,
        store,
        processLister: () => processFixture(workspace),
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.confirmRequired, true);
    const target = payload.managedAppServer as { canStop?: boolean; pid?: number };
    assert.equal(target.canStop, true);
    assert.equal(target.pid, 40);
    assert.equal(store.snapshot().count, 0);
  } finally {
    fixture.cleanup();
  }
});

test('buildAppServerStopPayload refuses real stop without confirm', () => {
  const fixture = tempStore();
  const { workspace } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    const payload = buildAppServerStopPayload(
      {
        dryRun: false,
      },
      {
        workspace,
        processLister: () => processFixture(workspace),
        scheduler() {
          throw new Error('scheduler should not run without confirm');
        },
      },
    );

    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.equal(payload.confirmRequired, true);
  } finally {
    fixture.cleanup();
  }
});

test('buildAppServerStopPayload schedules durable stop operation only after confirm', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    const scheduledInputs: unknown[] = [];
    const payload = buildAppServerStopPayload(
      {
        dryRun: false,
        confirm: true,
        timeoutMs: 5_000,
        delayMs: 0,
      },
      {
        workspace,
        store,
        processLister: () => processFixture(workspace),
        scheduler(input) {
          scheduledInputs.push(input);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-app-server-stop-operation',
            argvIncludesSecrets: false,
            delayMs: 0,
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        workspace: resolve(workspace),
        expectedPid: 40,
        expectedAppServerUrl: appServerUrl,
        timeoutMs: 5_000,
        delayMs: 0,
      },
    ]);
    assert.equal(store.read(String(payload.operationId))?.kind, 'app_server_stop');
  } finally {
    fixture.cleanup();
  }
});

test('runAppServerStopOperation stops managed process tree and marks state stopped', async () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    store.create({
      id: 'op-stop',
      kind: 'app_server_stop',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    let listCount = 0;
    const stopped: Array<{ rootPid: number; treePids: number[] }> = [];

    const operation = await runAppServerStopOperation(
      {
        operationId: 'op-stop',
        workspace,
        expectedPid: 40,
        expectedAppServerUrl: appServerUrl,
        timeoutMs: 100,
        delayMs: 0,
      },
      {
        store,
        processLister() {
          listCount += 1;
          return listCount === 1 ? processFixture(workspace) : [];
        },
        processStopper(rootPid, tree) {
          stopped.push({ rootPid, treePids: tree.map((entry) => entry.pid) });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.deepEqual(stopped, [{ rootPid: 40, treePids: [40, 41] }]);
    const state = readAppServerStateFile(appServerStateFileForWorkspace(workspace, 'primary'), 'primary').state;
    assert.equal(state?.status, 'stopped');
    assert.equal(state?.pid, null);
    assert.equal(state?.owned, false);
  } finally {
    fixture.cleanup();
  }
});

test('runAppServerStopOperation uses operation store from input workspace by default', async () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    writeOwnedAppServerState(workspace);
    store.create({
      id: 'op-stop-workspace',
      kind: 'app_server_stop',
      status: 'running',
    });
    let listCount = 0;

    await runAppServerStopOperation(
      {
        operationId: 'op-stop-workspace',
        workspace,
        expectedPid: 40,
        expectedAppServerUrl: appServerUrl,
        timeoutMs: 100,
        delayMs: 0,
      },
      {
        processLister() {
          listCount += 1;
          return listCount === 1 ? processFixture(workspace) : [];
        },
        processStopper() {
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(store.read('op-stop-workspace')?.status, 'completed');
  } finally {
    fixture.cleanup();
  }
});

test('app server stop operation argv round trips', () => {
  const workspace = resolve(process.cwd());
  const args = buildAppServerStopOperationArgs({
    operationId: 'op-a',
    workspace,
    expectedPid: 40,
    expectedAppServerUrl: appServerUrl,
    timeoutMs: 5_000,
    delayMs: 0,
  });

  assert.deepEqual(parseAppServerStopOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    workspace,
    expectedPid: 40,
    expectedAppServerUrl: appServerUrl,
    timeoutMs: 5_000,
    delayMs: 0,
  });
});
