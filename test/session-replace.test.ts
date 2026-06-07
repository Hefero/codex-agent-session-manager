import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { OperationStore } from '../src/tools/operations.js';
import {
  buildSessionReplaceOperationArgs,
  buildSessionReplacePayload,
  parseSessionReplaceOperationArgs,
  runSessionReplaceOperation,
} from '../src/tools/session-replace.js';
import { type LaunchPlan } from '../src/tools/session-launch.js';
import { type ProcessEntry } from '../src/processes.js';

const appServerUrl = 'ws://127.0.0.1:57798';
const threadId = 'thread-a';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-replace-${crypto.randomUUID()}`);
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

function processFixture(workspace = resolve(process.cwd())): ProcessEntry[] {
  return [
    {
      pid: 10,
      parentPid: null,
      name: 'powershell.exe',
      commandLine: `powershell -File "${workspace}\\.codex-agent-session-manager\\state\\remote-launch.ps1"`,
    },
    {
      pid: 20,
      parentPid: 10,
      name: 'node.exe',
      commandLine: `node C:\\tools\\codex-remote.mjs --url ${appServerUrl} --session-id ${threadId} --workspace "${workspace}"`,
    },
    {
      pid: 30,
      parentPid: 20,
      name: 'codex.exe',
      commandLine: `codex.exe resume ${threadId} --remote ${appServerUrl} -C "${workspace}"`,
    },
    {
      pid: 40,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe app-server --listen ${appServerUrl} -C "${workspace}"`,
    },
    {
      pid: 50,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe resume other-thread --remote ${appServerUrl} -C "${workspace}"`,
    },
  ];
}

test('buildSessionReplacePayload dry run previews close and launch without prompt text', () => {
  const prompt = 'secret replace prompt';
  const payload = buildSessionReplacePayload(
    {
      appServerUrl,
      threadId,
      prompt,
      bypassSandbox: true,
    },
    {
      processLister: () => processFixture(),
      codexCommandResolver: () => 'codex-test',
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.confirmRequired, true);
  assert.equal(payload.promptProvided, true);
  assert.equal(payload.promptCharCount, prompt.length);
  assert.doesNotMatch(JSON.stringify(payload), /secret replace prompt/u);
  assert.match(JSON.stringify(payload), /<prompt>/u);
  assert.match(JSON.stringify(payload), /--dangerously-bypass-approvals-and-sandbox/u);
  const close = payload.close as {
    targetCount?: number;
    remoteProcessCount?: number;
    targets?: Array<{ pid?: number; name?: string; commandLinePreview?: string }>;
  };
  assert.equal(close.targetCount, 1);
  assert.equal(close.remoteProcessCount, 1);
  assert.equal(close.targets?.[0]?.pid, 10);
  assert.equal(close.targets?.[0]?.name, 'powershell.exe');
  assert.doesNotMatch(close.targets?.[0]?.commandLinePreview ?? '', new RegExp(escapeRegExp(resolve(process.cwd())), 'u'));
});

test('buildSessionReplacePayload refuses real replacement without confirm', () => {
  const payload = buildSessionReplacePayload(
    {
      appServerUrl,
      threadId,
      dryRun: false,
    },
    {
      processLister: () => processFixture(),
      codexCommandResolver: () => 'codex-test',
      scheduler() {
        throw new Error('scheduler should not run without confirm');
      },
    },
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.refused, true);
  assert.equal(payload.confirmRequired, true);
  assert.match(String(payload.message), /confirm:true/u);
});

test('buildSessionReplacePayload schedules durable operation only after confirm', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const prompt = 'secret replace prompt';
    const scheduledInputs: unknown[] = [];
    const scheduledPrompts: Array<string | null> = [];
    const payload = buildSessionReplacePayload(
      {
        appServerUrl,
        threadId,
        prompt,
        dryRun: false,
        confirm: true,
        bypassSandbox: true,
        enableImageGeneration: true,
        timeoutMs: 5_000,
        delayMs: 0,
      },
      {
        store,
        processLister: () => processFixture(),
        codexCommandResolver: () => 'codex-test',
        scheduler(input, childPrompt) {
          scheduledInputs.push(input);
          scheduledPrompts.push(childPrompt);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-replace-operation',
            argvIncludesPrompt: false,
            promptTransport: 'environment',
            delayMs: 0,
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
        threadId,
        bypassSandbox: true,
        enableImageGeneration: true,
        timeoutMs: 5_000,
        delayMs: 0,
      },
    ]);
    assert.equal(store.read(String(payload.operationId))?.kind, 'session_replace');
    assert.doesNotMatch(JSON.stringify(payload), /secret replace prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionReplaceOperation stops matching remote roots and launches resumed thread', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-replace',
      kind: 'session_replace',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    let listCount = 0;
    const stopped: Array<{ rootPid: number; treePids: number[] }> = [];
    const plans: LaunchPlan[] = [];
    const prompt = 'secret replace prompt';

    const operation = await runSessionReplaceOperation(
      {
        operationId: 'op-replace',
        appServerUrl,
        workspace: resolve(process.cwd()),
        threadId,
        bypassSandbox: true,
        timeoutMs: 100,
        delayMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_REPLACE_PROMPT: prompt },
        processLister() {
          listCount += 1;
          return listCount === 1 ? processFixture() : [];
        },
        processStopper(rootPid, tree) {
          stopped.push({ rootPid, treePids: tree.map((entry) => entry.pid) });
          return { status: 0, stdout: '', stderr: '' };
        },
        codexCommandResolver: () => 'codex-test',
        launchExecutor(plan) {
          plans.push(plan);
          return { ok: true, mode: 'fake', pid: 456 };
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.deepEqual(stopped, [{ rootPid: 10, treePids: [10, 20, 30] }]);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.args.slice(0, 2), ['resume', threadId]);
    assert.equal(plans[0]?.args.at(-1), prompt);
    assert.doesNotMatch(JSON.stringify(operation), /secret replace prompt/u);
    const evidence = operation?.evidence as {
      background?: unknown;
      close?: { targetCount?: number; remoteProcessCount?: number };
      stopped?: { ok?: boolean };
      launched?: { ok?: boolean; mode?: string; pid?: number };
    };
    assert.deepEqual(evidence.background, { scheduled: true });
    assert.equal(evidence.close?.targetCount, 1);
    assert.equal(evidence.close?.remoteProcessCount, 1);
    assert.equal(evidence.stopped?.ok, true);
    assert.deepEqual(evidence.launched, { ok: true, mode: 'fake', pid: 456 });
  } finally {
    fixture.cleanup();
  }
});

test('session replace operation argv round trips without prompt text or broad cleanup flags', () => {
  const workspace = resolve(process.cwd());
  const args = buildSessionReplaceOperationArgs({
    operationId: 'op-a',
    appServerUrl,
    workspace,
    threadId,
    bypassSandbox: true,
    enableImageGeneration: true,
    timeoutMs: 5_000,
    delayMs: 0,
  });

  assert.doesNotMatch(args.join(' '), /prompt/u);
  assert.doesNotMatch(args.join(' '), /--all/u);
  assert.deepEqual(parseSessionReplaceOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl,
    workspace,
    threadId,
    bypassSandbox: true,
    enableImageGeneration: true,
    timeoutMs: 5_000,
    delayMs: 0,
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
