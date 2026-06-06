import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OperationStore,
  buildOperationReadPayload,
  buildOperationWaitPayload,
} from '../src/tools/operations.js';

test('OperationStore creates, updates, reads, lists, and snapshots operations', () => {
  const store = new OperationStore();
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
});

test('OperationStore returns deep clones of operation evidence', () => {
  const store = new OperationStore();
  const created = store.create({
    id: 'op-clone',
    kind: 'unit',
    evidence: { nested: { value: 1 } },
  });

  (created.evidence as { nested: { value: number } }).nested.value = 2;

  const reread = store.read('op-clone');
  assert.deepEqual(reread?.evidence, { nested: { value: 1 } });
});

test('OperationStore complete and fail mark terminal operation state', () => {
  const store = new OperationStore();
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
});

test('operation read payload reports found operation and count', () => {
  const store = new OperationStore();
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
});

test('waitForOperation resolves when an operation completes', async () => {
  const store = new OperationStore();
  store.create({ id: 'op-wait', kind: 'unit', status: 'running' });
  setTimeout(() => {
    store.complete('op-wait');
  }, 20);

  const result = await store.waitForOperation('op-wait', { timeoutMs: 200, pollMs: 10 });
  assert.equal(result.found, true);
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.operation?.status, 'completed');
});

test('operation wait payload reports missing and timeout states', async () => {
  const store = new OperationStore();
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
});
