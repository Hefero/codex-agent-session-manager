import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OperationStore } from '../src/tools/operations.js';
import {
  buildSessionContinueOperationArgs,
  buildSessionContinuePayload,
  parseSessionContinueOperationArgs,
  runSessionContinueOperation,
  type SessionContinueClient,
} from '../src/tools/session-continue.js';

function tempWorkspace(): string {
  return join(tmpdir(), `codex-agent-session-manager-continue-${crypto.randomUUID()}`);
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

class FakeContinueClient implements SessionContinueClient {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  throwPromptInStartError = false;
  closed = false;
  private readCount = 0;

  async initialize(): Promise<unknown> {
    this.calls.push('initialize');
    return { ok: true };
  }

  async readThread(): Promise<{
    thread: {
      status: {
        type: string;
        activeFlags: string[];
      };
    };
  }> {
    this.calls.push('readThread');
    this.readCount += 1;
    return {
      thread: {
        status: this.readCount === 1 ? { type: 'active', activeFlags: [] } : { type: 'idle', activeFlags: [] },
      },
    };
  }

  async startTurn(input: { input: Array<{ text: string }> }): Promise<{ turn: { id: string } }> {
    this.calls.push('startTurn');
    const prompt = input.input[0]?.text ?? '';
    this.prompts.push(prompt);
    if (this.throwPromptInStartError) {
      throw new Error(`start failed for ${prompt}`);
    }
    return { turn: { id: 'turn-a' } };
  }

  close(): void {
    this.closed = true;
  }
}

test('buildSessionContinuePayload creates durable operation and schedules prompt via non-argv transport', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const prompt = 'secret continuation prompt';
    const scheduledInputs: unknown[] = [];
    const scheduledPrompts: string[] = [];

    const payload = buildSessionContinuePayload(
      {
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        prompt,
        timeoutMs: 5_000,
        continuationTimeoutMs: 10_000,
        continuationPollMs: 500,
        continuationStableMs: 0,
      },
      {
        store,
        scheduler(input, childPrompt) {
          scheduledInputs.push(input);
          scheduledPrompts.push(childPrompt);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-continue-operation',
            argvIncludesPrompt: false,
            promptTransport: 'environment',
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        timeoutMs: 5_000,
        continuationTimeoutMs: 10_000,
        continuationPollMs: 500,
        continuationStableMs: 0,
      },
    ]);
    assert.deepEqual(scheduledPrompts, [prompt]);
    assert.doesNotMatch(JSON.stringify(payload), /secret continuation prompt/u);

    const stored = store.read(String(payload.operationId));
    assert.equal(stored?.kind, 'session_continue');
    assert.equal(stored?.status, 'running');
    assert.doesNotMatch(JSON.stringify(stored), /secret continuation prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionContinueOperation waits for idle and starts turn with env prompt', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-continue',
      kind: 'session_continue',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const fakeClient = new FakeContinueClient();
    const prompt = 'secret env prompt';

    const operation = await runSessionContinueOperation(
      {
        operationId: 'op-continue',
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        timeoutMs: 5_000,
        continuationTimeoutMs: 200,
        continuationPollMs: 100,
        continuationStableMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_CONTINUE_PROMPT: prompt },
        connectClient: async () => fakeClient,
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.deepEqual(fakeClient.calls, ['initialize', 'readThread', 'readThread', 'startTurn']);
    assert.deepEqual(fakeClient.prompts, [prompt]);
    assert.equal(fakeClient.closed, true);
    assert.doesNotMatch(JSON.stringify(operation), /secret env prompt/u);

    const evidence = operation?.evidence as {
      background?: unknown;
      ready?: { ok?: boolean; attemptCount?: number };
      turnStart?: { requested?: boolean; turnId?: string; inputIncluded?: boolean };
    };
    assert.deepEqual(evidence.background, { scheduled: true });
    assert.equal(evidence.ready?.ok, true);
    assert.equal(evidence.ready?.attemptCount, 2);
    assert.equal(evidence.turnStart?.requested, true);
    assert.equal(evidence.turnStart?.turnId, 'turn-a');
    assert.equal(evidence.turnStart?.inputIncluded, true);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionContinueOperation redacts prompt text from failure evidence', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-continue-fail',
      kind: 'session_continue',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const fakeClient = new FakeContinueClient();
    fakeClient.throwPromptInStartError = true;
    const prompt = 'secret failure prompt';

    const operation = await runSessionContinueOperation(
      {
        operationId: 'op-continue-fail',
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        timeoutMs: 5_000,
        continuationTimeoutMs: 200,
        continuationPollMs: 100,
        continuationStableMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_CONTINUE_PROMPT: prompt },
        connectClient: async () => fakeClient,
      },
    );

    assert.equal(operation?.status, 'failed');
    assert.deepEqual(fakeClient.prompts, [prompt]);
    assert.equal(fakeClient.closed, true);
    assert.doesNotMatch(JSON.stringify(operation), /secret failure prompt/u);
    assert.match(JSON.stringify(operation?.failure), /<redacted:continuation-prompt>/u);
  } finally {
    fixture.cleanup();
  }
});

test('session continue operation argv does not include prompt text', () => {
  const args = buildSessionContinueOperationArgs({
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    timeoutMs: 5_000,
    continuationTimeoutMs: 10_000,
    continuationPollMs: 500,
    continuationStableMs: 0,
  });

  assert.doesNotMatch(args.join(' '), /prompt/u);
  assert.deepEqual(parseSessionContinueOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    timeoutMs: 5_000,
    continuationTimeoutMs: 10_000,
    continuationPollMs: 500,
    continuationStableMs: 0,
  });
});
