import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildSessionCloseOperationArgs,
  buildSessionClosePayload,
  parseSessionCloseOperationArgs,
  runSessionCloseOperation,
} from '../src/tools/session-close.js';
import { OperationStore } from '../src/tools/operations.js';
import { findRemoteTuiTargets, type ProcessEntry } from '../src/processes.js';

const appServerUrl = 'ws://127.0.0.1:57798';
const threadId = 'thread-a';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-close-${crypto.randomUUID()}`);
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
    {
      pid: 60,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe resume ${threadId} --remote ws://127.0.0.1:59999 -C "${workspace}"`,
    },
    {
      pid: 70,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe --remote ${appServerUrl} -C "${workspace}"`,
    },
  ];
}

function combinedRemoteAppServerWrapperFixture(workspace = resolve(process.cwd())): ProcessEntry[] {
  return [
    {
      pid: 80,
      parentPid: null,
      name: 'node.exe',
      commandLine: `node "${workspace}\\node_modules\\codex-agent-session-manager\\dist\\cli.js" remote`,
    },
    {
      pid: 81,
      parentPid: 80,
      name: 'windows-hidden-stdio-launcher.exe',
      commandLine: `windows-hidden-stdio-launcher.exe codex.exe app-server --listen ${appServerUrl}`,
    },
    {
      pid: 82,
      parentPid: 80,
      name: 'codex.exe',
      commandLine: `codex.exe --remote ${appServerUrl} -C "${workspace}"`,
    },
  ];
}

test('findRemoteTuiTargets matches only explicit thread remote TUI roots', () => {
  const workspace = resolve(process.cwd());
  const targets = findRemoteTuiTargets(processFixture(workspace), {
    appServerUrl,
    threadId,
    workspace,
  });

  assert.deepEqual(targets.remoteProcesses.map((entry) => entry.pid), [30]);
  assert.deepEqual(targets.roots.map((entry) => entry.pid), [10]);
});

test('findRemoteTuiTargets can explicitly fall back to workspace and URL for fresh remotes', () => {
  const workspace = resolve(process.cwd());
  const targets = findRemoteTuiTargets(processFixture(workspace), {
    appServerUrl,
    threadId: 'missing-thread-id',
    workspace,
    allowWorkspaceUrlFallback: true,
  });

  assert.deepEqual(targets.remoteProcesses.map((entry) => entry.pid), [30, 50, 70]);
  assert.deepEqual(targets.roots.map((entry) => entry.pid), [10, 50, 70]);
});

test('findRemoteTuiTargets climbs to Windows cmd shim terminal wrapper', () => {
  const workspace = resolve(process.cwd());
  const processes: ProcessEntry[] = [
    {
      pid: 100,
      parentPid: null,
      name: 'cmd.exe',
      commandLine: `"C:\\WINDOWS\\system32\\cmd.exe" /c ""C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd" resume ${threadId} --disable js_repl --remote ${appServerUrl} -C "${workspace}""`,
    },
    {
      pid: 101,
      parentPid: 100,
      name: 'node.exe',
      commandLine: `"node" "C:\\Users\\Example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${threadId} --disable js_repl --remote ${appServerUrl} -C "${workspace}"`,
    },
    {
      pid: 102,
      parentPid: 101,
      name: 'codex.exe',
      commandLine: `codex.exe resume ${threadId} --disable js_repl --remote ${appServerUrl} -C "${workspace}"`,
    },
  ];
  const targets = findRemoteTuiTargets(processes, {
    appServerUrl,
    threadId,
    workspace,
  });

  assert.deepEqual(targets.remoteProcesses.map((entry) => entry.pid), [101, 102]);
  assert.deepEqual(targets.roots.map((entry) => entry.pid), [100]);
});

test('findRemoteTuiTargets does not climb to wrapper that also owns App Server', () => {
  const workspace = resolve(process.cwd());
  const targets = findRemoteTuiTargets(combinedRemoteAppServerWrapperFixture(workspace), {
    appServerUrl,
    threadId: 'missing-thread-id',
    workspace,
    allowWorkspaceUrlFallback: true,
  });

  assert.deepEqual(targets.remoteProcesses.map((entry) => entry.pid), [82]);
  assert.deepEqual(targets.roots.map((entry) => entry.pid), [82]);
});

test('buildSessionClosePayload dry run reports targets without creating operation', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const payload = buildSessionClosePayload(
      {
        appServerUrl,
        threadId,
      },
      {
        store,
        processLister: () => processFixture(),
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.confirmRequired, true);
    assert.equal(payload.targetCount, 1);
    assert.equal(payload.remoteProcessCount, 1);
    assert.equal(store.snapshot().count, 0);
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionClosePayload reports fallback match only after thread match misses', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const payload = buildSessionClosePayload(
      {
        appServerUrl,
        threadId: 'missing-thread-id',
        allowWorkspaceUrlFallback: true,
      },
      {
        store,
        processLister: () => processFixture(),
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.targetCount, 3);
    assert.equal(payload.remoteProcessCount, 3);
    assert.equal(payload.fallbackUsed, true);
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionClosePayload refuses real execution without confirm', () => {
  const payload = buildSessionClosePayload(
    {
      appServerUrl,
      threadId,
      dryRun: false,
    },
    {
      processLister: () => processFixture(),
      scheduler() {
        throw new Error('scheduler should not run without confirm');
      },
    },
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.refused, true);
  assert.equal(payload.confirmRequired, true);
  assert.equal(payload.targetCount, 1);
});

test('buildSessionClosePayload schedules durable operation only after confirm', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const scheduledInputs: unknown[] = [];
    const payload = buildSessionClosePayload(
      {
        appServerUrl,
        threadId,
        dryRun: false,
        confirm: true,
        timeoutMs: 5_000,
        delayMs: 0,
      },
      {
        store,
        scheduler(input) {
          scheduledInputs.push(input);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-close-operation',
            argvIncludesSecrets: false,
            delayMs: 0,
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        appServerUrl,
        threadId,
        workspace: resolve(process.cwd()),
        timeoutMs: 5_000,
        delayMs: 0,
      },
    ]);
    assert.equal(store.read(String(payload.operationId))?.kind, 'session_close');
  } finally {
    fixture.cleanup();
  }
});

test('runSessionCloseOperation stops matching remote roots and leaves App Server unmatched', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-close',
      kind: 'session_close',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    let listCount = 0;
    const stopped: Array<{ rootPid: number; treePids: number[] }> = [];

    const operation = await runSessionCloseOperation(
      {
        operationId: 'op-close',
        appServerUrl,
        threadId,
        workspace: resolve(process.cwd()),
        timeoutMs: 100,
        delayMs: 0,
      },
      {
        store,
        processLister() {
          listCount += 1;
          return listCount === 1 ? processFixture() : [];
        },
        processStopper(rootPid, tree) {
          stopped.push({ rootPid, treePids: tree.map((entry) => entry.pid) });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.deepEqual(stopped, [{ rootPid: 10, treePids: [10, 20, 30] }]);
    const evidence = operation?.evidence as {
      background?: unknown;
      match?: { targetCount?: number; remoteProcessCount?: number };
      stopped?: { ok?: boolean };
    };
    assert.deepEqual(evidence.background, { scheduled: true });
    assert.equal(evidence.match?.targetCount, 1);
    assert.equal(evidence.match?.remoteProcessCount, 1);
    assert.equal(evidence.stopped?.ok, true);
  } finally {
    fixture.cleanup();
  }
});

test('session close operation argv round trips without broad cleanup flags', () => {
  const workspace = resolve(process.cwd());
  const args = buildSessionCloseOperationArgs({
    operationId: 'op-a',
    appServerUrl,
    threadId,
    workspace,
    timeoutMs: 5_000,
    delayMs: 0,
  });

  assert.doesNotMatch(args.join(' '), /--all/u);
  assert.deepEqual(parseSessionCloseOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl,
    threadId,
    allowWorkspaceUrlFallback: false,
    workspace,
    timeoutMs: 5_000,
    delayMs: 0,
  });
});

test('session close operation argv round trips workspace URL fallback opt-in', () => {
  const workspace = resolve(process.cwd());
  const args = buildSessionCloseOperationArgs({
    operationId: 'op-a',
    appServerUrl,
    threadId,
    allowWorkspaceUrlFallback: true,
    workspace,
  });

  assert.match(args.join(' '), /--allow-workspace-url-fallback/u);
  assert.equal(parseSessionCloseOperationArgs(args.slice(1)).allowWorkspaceUrlFallback, true);
});

test('session close operation argv rejects missing workspace', () => {
  const missingWorkspace = join(tmpdir(), `codex-agent-session-manager-missing-${crypto.randomUUID()}`);
  const args = buildSessionCloseOperationArgs({
    operationId: 'op-a',
    appServerUrl,
    threadId,
    workspace: missingWorkspace,
  });

  assert.throws(() => parseSessionCloseOperationArgs(args.slice(1)), /Workspace root must exist/u);
});
