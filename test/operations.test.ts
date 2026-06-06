import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  OperationStore,
  buildOperationReadPayload,
  buildOperationWaitPayload,
  operationStateFileForWorkspace,
} from '../src/tools/operations.js';

function tempWorkspace(): string {
  return join(tmpdir(), `codex-agent-session-manager-ops-${crypto.randomUUID()}`);
}

function tempStore(): { workspace: string; stateFile: string; store: OperationStore; cleanup(): void } {
  const workspace = tempWorkspace();
  const stateFile = operationStateFileForWorkspace(workspace);
  const store = new OperationStore({ workspace });
  return {
    workspace,
    stateFile,
    store,
    cleanup() {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

test('OperationStore creates, updates, reads, lists, snapshots, and persists operations', () => {
  const fixture = tempStore();
  const { store, workspace, stateFile } = fixture;
  try {
  const created = store.create({
    id: 'op-a',
    kind: 'unit',
    status: 'running',
    evidence: { step: 1 },
    nextAction: 'wait',
  });

  assert.equal(created.id, 'op-a');
  assert.equal(created.kind, 'unit');
  assert.equal(created.status, 'running');
  assert.deepEqual(created.evidence, { step: 1 });
  assert.equal(created.nextAction, 'wait');
  assert.equal(store.read('missing'), null);

  const updated = store.update('op-a', { evidence: { step: 2 }, nextAction: 'finish' });
  assert.equal(updated?.status, 'running');
  assert.deepEqual(updated?.evidence, { step: 2 });
  assert.equal(updated?.nextAction, 'finish');

  assert.equal(store.list().length, 1);
  assert.deepEqual(store.snapshot(), { operations: [store.read('op-a')], count: 1 });
  assert.equal(existsSync(stateFile), true);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).count, 1);

  const reloadedStore = new OperationStore({ workspace });
  assert.deepEqual(reloadedStore.read('op-a'), store.read('op-a'));
  } finally {
    fixture.cleanup();
  }
});

test('OperationStore returns deep clones of operation evidence', () => {
  const fixture = tempStore();
  const { store, workspace } = fixture;
  try {
  const created = store.create({
    id: 'op-clone',
    kind: 'unit',
    evidence: { nested: { value: 1 } },
  });

  (created.evidence as { nested: { value: number } }).nested.value = 2;

  const reread = store.read('op-clone');
  assert.deepEqual(reread?.evidence, { nested: { value: 1 } });

  if (reread?.evidence && typeof reread.evidence === 'object') {
    (reread.evidence as { nested: { value: number } }).nested.value = 3;
  }
  assert.deepEqual(new OperationStore({ workspace }).read('op-clone')?.evidence, { nested: { value: 1 } });
  } finally {
    fixture.cleanup();
  }
});

test('OperationStore complete and fail mark terminal operation state', () => {
  const fixture = tempStore();
  const { store, workspace } = fixture;
  try {
  store.create({ id: 'op-complete', kind: 'unit' });
  store.create({ id: 'op-fail', kind: 'unit' });

  const completed = store.complete('op-complete', { evidence: { ok: true }, nextAction: 'done' });
  assert.equal(completed?.status, 'completed');
  assert.equal(typeof completed?.completedAt, 'string');
  assert.deepEqual(completed?.evidence, { ok: true });
  assert.equal(completed?.nextAction, 'done');

  const failed = store.fail('op-fail', { failure: { message: 'failed' }, nextAction: 'inspect failure' });
  assert.equal(failed?.status, 'failed');
  assert.equal(typeof failed?.completedAt, 'string');
  assert.deepEqual(failed?.failure, { message: 'failed' });
  assert.equal(failed?.nextAction, 'inspect failure');
  assert.equal(new OperationStore({ workspace }).read('op-fail')?.status, 'failed');
  } finally {
    fixture.cleanup();
  }
});

test('operation read payload reports found operation and count', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
  store.create({ id: 'op-a', kind: 'unit' });

  assert.deepEqual(buildOperationReadPayload({ operationId: 'missing' }, store), {
    ok: true,
    operation: null,
    found: false,
    count: 1,
  });

  const payload = buildOperationReadPayload({ operationId: 'op-a' }, store);
  assert.equal(payload.ok, true);
  assert.equal(payload.found, true);
  assert.equal(payload.count, 1);
  assert.equal((payload.operation as { id?: string } | null)?.id, 'op-a');
  } finally {
    fixture.cleanup();
  }
});

test('waitForOperation resolves when an operation completes', async () => {
  const fixture = tempStore();
  const { store, workspace } = fixture;
  try {
  store.create({ id: 'op-wait', kind: 'unit', status: 'running' });
  setTimeout(() => {
    new OperationStore({ workspace }).complete('op-wait');
  }, 20);

  const result = await store.waitForOperation('op-wait', { timeoutMs: 200, pollMs: 10 });
  assert.equal(result.found, true);
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.operation?.status, 'completed');
  } finally {
    fixture.cleanup();
  }
});

test('operation wait payload reports missing and timeout states', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
  assert.deepEqual(await buildOperationWaitPayload({ operationId: 'missing', timeoutMs: 50, pollMs: 10 }, store), {
    ok: true,
    operation: null,
    completed: false,
    timedOut: false,
    found: false,
  });

  store.create({ id: 'op-running', kind: 'unit', status: 'running' });
  const timedOut = await buildOperationWaitPayload({ operationId: 'op-running', timeoutMs: 20, pollMs: 10 }, store);
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.completed, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.found, true);
  assert.equal((timedOut.operation as { status?: string } | null)?.status, 'running');
  } finally {
    fixture.cleanup();
  }
});

test('OperationStore handles missing and corrupt state files as empty state', () => {
  const fixture = tempStore();
  const { store, stateFile, workspace } = fixture;
  try {
    assert.deepEqual(store.snapshot(), { operations: [], count: 0 });
    assert.equal(existsSync(stateFile), false);

    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, '{ corrupt json');
    const corruptStore = new OperationStore({ workspace });
    assert.deepEqual(corruptStore.snapshot(), { operations: [], count: 0 });

    corruptStore.create({ id: 'op-after-corrupt', kind: 'unit' });
    assert.equal(new OperationStore({ workspace }).read('op-after-corrupt')?.id, 'op-after-corrupt');
  } finally {
    fixture.cleanup();
  }
});
