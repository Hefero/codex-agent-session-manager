import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { OperationStore } from '../src/tools/operations.js';
import {
  buildSessionLaunchOperationArgs,
  buildSessionLaunchPayload,
  parseSessionLaunchOperationArgs,
  runSessionLaunchOperation,
  type LaunchPlan,
} from '../src/tools/session-launch.js';

const appServerUrl = 'ws://127.0.0.1:57798';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-launch-${crypto.randomUUID()}`);
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

test('buildSessionLaunchPayload dry run previews launch without prompt text', () => {
  const prompt = 'secret launch prompt';
  const payload = buildSessionLaunchPayload(
    {
      appServerUrl,
      threadId: 'thread-a',
      prompt,
      bypassSandbox: true,
    },
    {
      codexCommandResolver: () => 'codex-test',
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.confirmRequired, true);
  assert.equal(payload.mode, 'session');
  assert.equal(payload.promptProvided, true);
  assert.equal(payload.promptCharCount, prompt.length);
  assert.doesNotMatch(JSON.stringify(payload), /secret launch prompt/u);
  assert.match(JSON.stringify(payload), /<prompt>/u);
  assert.match(JSON.stringify(payload), /--dangerously-bypass-approvals-and-sandbox/u);
});

test('session launch refuses mode=session without threadId', () => {
  assert.throws(
    () => buildSessionLaunchPayload({ appServerUrl, mode: 'session' }, { codexCommandResolver: () => 'codex-test' }),
    /requires threadId/u,
  );
});

test('buildSessionLaunchPayload refuses real launch without confirm', () => {
  const payload = buildSessionLaunchPayload(
    {
      appServerUrl,
      mode: 'fresh',
      dryRun: false,
    },
    {
      codexCommandResolver: () => 'codex-test',
      scheduler() {
        throw new Error('scheduler should not run without confirm');
      },
    },
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.refused, true);
  assert.equal(payload.confirmRequired, true);
  assert.equal(payload.startsAppServer, false);
});

test('buildSessionLaunchPayload schedules durable launch with prompt through environment', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const prompt = 'secret launch prompt';
    const scheduledInputs: unknown[] = [];
    const scheduledPrompts: Array<string | null> = [];
    const payload = buildSessionLaunchPayload(
      {
        appServerUrl,
        threadId: 'thread-a',
        prompt,
        dryRun: false,
        confirm: true,
        bypassSandbox: true,
        enableImageGeneration: true,
        timeoutMs: 5_000,
      },
      {
        store,
        codexCommandResolver: () => 'codex-test',
        scheduler(input, childPrompt) {
          scheduledInputs.push(input);
          scheduledPrompts.push(childPrompt);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-launch-operation',
            argvIncludesPrompt: false,
            promptTransport: 'environment',
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledPrompts, [prompt]);
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        appServerUrl,
        workspace: resolve(process.cwd()),
        mode: 'session',
        threadId: 'thread-a',
        bypassSandbox: true,
        enableImageGeneration: true,
        timeoutMs: 5_000,
      },
    ]);
    assert.equal(store.read(String(payload.operationId))?.kind, 'session_launch');
    assert.doesNotMatch(JSON.stringify(payload), /secret launch prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionLaunchOperation records launch result without prompt text', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-launch',
      kind: 'session_launch',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const plans: LaunchPlan[] = [];
    const prompt = 'secret launch prompt';

    const operation = await runSessionLaunchOperation(
      {
        operationId: 'op-launch',
        appServerUrl,
        workspace: resolve(process.cwd()),
        mode: 'session',
        threadId: 'thread-a',
        bypassSandbox: true,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_LAUNCH_PROMPT: prompt },
        codexCommandResolver: () => 'codex-test',
        launchExecutor(plan) {
          plans.push(plan);
          return { ok: true, mode: 'fake', pid: 456 };
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.args.slice(0, 2), ['resume', 'thread-a']);
    assert.equal(plans[0]?.args.at(-1), prompt);
    assert.doesNotMatch(JSON.stringify(operation), /secret launch prompt/u);
    const evidence = operation?.evidence as {
      background?: unknown;
      launched?: { ok?: boolean; mode?: string; pid?: number };
    };
    assert.deepEqual(evidence.background, { scheduled: true });
    assert.deepEqual(evidence.launched, { ok: true, mode: 'fake', pid: 456 });
  } finally {
    fixture.cleanup();
  }
});

test('session launch operation argv round trips without prompt text', () => {
  const workspace = resolve(process.cwd());
  const args = buildSessionLaunchOperationArgs({
    operationId: 'op-a',
    appServerUrl,
    workspace,
    mode: 'session',
    threadId: 'thread-a',
    bypassSandbox: true,
    enableImageGeneration: true,
    timeoutMs: 5_000,
  });

  assert.doesNotMatch(args.join(' '), /prompt/u);
  assert.deepEqual(parseSessionLaunchOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl,
    workspace,
    mode: 'session',
    threadId: 'thread-a',
    bypassSandbox: true,
    enableImageGeneration: true,
    timeoutMs: 5_000,
  });
});
