import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProcessEntry } from '../src/processes.js';
import { OperationStore } from '../src/tools/operations.js';
import {
  buildSessionHardRelaunchOperationArgs,
  buildSessionHardRelaunchPayload,
  findCurrentCodexSessionTarget,
  parseSessionHardRelaunchOperationArgs,
  runSessionHardRelaunchOperation,
  type PlainCodexLaunchPlan,
} from '../src/tools/session-hard-relaunch.js';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-hard-relaunch-${crypto.randomUUID()}`);
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

function withCwd<T>(cwd: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function currentSessionProcessFixture(
  workspace = resolve(process.cwd()),
  options: { threadId?: string | null } = { threadId: 'thread-a' },
): ProcessEntry[] {
  const resumePrefix = options.threadId ? `resume ${options.threadId} ` : '';
  return [
    {
      pid: 10,
      parentPid: null,
      name: 'cmd.exe',
      commandLine: `"C:\\WINDOWS\\system32\\cmd.exe" /c ""C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd" ${resumePrefix}-C "${workspace}" "initial prompt""`,
    },
    {
      pid: 20,
      parentPid: 10,
      name: 'node.exe',
      commandLine: `"node" "C:\\Users\\Example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" ${resumePrefix}-C "${workspace}" "initial prompt"`,
    },
    {
      pid: 30,
      parentPid: 20,
      name: 'codex.exe',
      commandLine: `codex.exe ${resumePrefix}-C "${workspace}" "initial prompt"`,
    },
    {
      pid: 40,
      parentPid: 30,
      name: 'windows-hidden-stdio-launcher.exe',
      commandLine: `"${workspace}\\.codex-agent-session-manager\\windows-hidden-stdio-launcher.exe" node node_modules/codex-agent-session-manager/dist/cli.js serve`,
    },
    {
      pid: 50,
      parentPid: 40,
      name: 'node.exe',
      commandLine: `node "${workspace}\\node_modules\\codex-agent-session-manager\\dist\\cli.js" serve`,
    },
    {
      pid: 60,
      parentPid: null,
      name: 'codex.exe',
      commandLine: `codex.exe app-server --listen ws://127.0.0.1:5555 -C "${workspace}"`,
    },
  ];
}

test('findCurrentCodexSessionTarget climbs from MCP server to visible Codex terminal root', () => {
  const workspace = resolve(process.cwd());
  const target = findCurrentCodexSessionTarget({
    processes: currentSessionProcessFixture(workspace),
    workspace,
    currentPid: 50,
  });

  assert.equal(target?.currentPid, 50);
  assert.equal(target?.root.pid, 10);
  assert.deepEqual(target?.ancestry.map((entry) => entry.pid), [50, 40, 30, 20, 10]);
  assert.deepEqual(target?.tree.map((entry) => entry.pid), [10, 20, 30, 40, 50]);
});

test('buildSessionHardRelaunchPayload dry run previews current target and redacts prompt', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    const prompt = 'secret hard relaunch prompt';
    const payload = withCwd(workspace, () => buildSessionHardRelaunchPayload(
      {
        prompt,
        bypassSandbox: true,
      },
      {
        store,
        currentPid: 50,
        processLister: () => currentSessionProcessFixture(workspace),
        codexCommandResolver: () => 'codex-test',
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.confirmRequired, true);
    assert.equal(payload.promptProvided, true);
    assert.equal(payload.usesAppServerTurnStart, false);
    assert.deepEqual(payload.resume, {
      resumeMode: 'current',
      threadId: 'thread-a',
      source: 'inferred',
      resolved: true,
    });
    assert.equal((payload.target as { rootPid?: number }).rootPid, 10);
    assert.match(JSON.stringify(payload), /--dangerously-bypass-approvals-and-sandbox/u);
    assert.match(JSON.stringify(payload), /<prompt>/u);
    assert.doesNotMatch(JSON.stringify(payload), /secret hard relaunch prompt/u);
    assert.equal(store.snapshot().count, 0);
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionHardRelaunchPayload schedules operation with prompt through environment', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    const prompt = 'secret hard relaunch prompt';
    const scheduledInputs: unknown[] = [];
    const scheduledPrompts: Array<string | null> = [];
    const payload = withCwd(workspace, () => buildSessionHardRelaunchPayload(
      {
        prompt,
        dryRun: false,
        confirm: true,
        delayMs: 5_000,
      },
      {
        store,
        currentPid: 50,
        processLister: () => currentSessionProcessFixture(workspace),
        codexCommandResolver: () => 'codex-test',
        scheduler(input, childPrompt) {
          scheduledInputs.push(input);
          scheduledPrompts.push(childPrompt);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-hard-relaunch-operation',
            argvIncludesPrompt: false,
            promptTransport: 'environment',
            handoffMode: input.handoffMode ?? 'detached',
            delayMs: input.delayMs ?? 0,
          };
        },
      },
    ));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(scheduledPrompts, [prompt]);
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        workspace: resolve(workspace),
        targetRootPid: 10,
        delayMs: 5_000,
        handoffMode: 'detached',
        resumeMode: 'current',
        threadId: 'thread-a',
      },
    ]);
    const operation = (payload as { operation: { evidence: unknown } }).operation;
    const requested = (operation.evidence as { requested?: Record<string, unknown> }).requested;
    assert.equal(requested?.backgroundChildArgvIncludesPrompt, false);
    assert.equal(requested?.relaunchedCodexPromptTransport, 'argv');
    assert.equal(requested?.relaunchedCodexPromptInProcessCommandLine, true);
    assert.equal(requested?.resumeMode, 'current');
    assert.equal(requested?.threadId, null);
    assert.equal(store.read(String(payload.operationId))?.kind, 'session_hard_relaunch');
    assert.doesNotMatch(JSON.stringify(payload), /secret hard relaunch prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionHardRelaunchPayload can schedule shell resume-next handoff', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    const scheduledInputs: unknown[] = [];
    const payload = withCwd(workspace, () => buildSessionHardRelaunchPayload(
      {
        prompt: 'resume in same shell',
        handoffMode: 'shell-resume-next',
        dryRun: false,
        confirm: true,
      },
      {
        store,
        currentPid: 50,
        processLister: () => currentSessionProcessFixture(workspace),
        codexCommandResolver: () => 'codex-test',
        scheduler(input) {
          scheduledInputs.push(input);
          return {
            scheduled: true,
            pid: 123,
            detached: true,
            windowsHide: true,
            internalCommand: 'run-session-hard-relaunch-operation',
            argvIncludesPrompt: false,
            promptTransport: 'environment',
            handoffMode: input.handoffMode ?? 'detached',
            delayMs: input.delayMs ?? 0,
          };
        },
      },
    ));

    assert.equal(payload.ok, true);
    assert.match(JSON.stringify(payload), /shell-resume-next/u);
    assert.match(JSON.stringify(payload), /requiresShellHook/u);
    assert.doesNotMatch(JSON.stringify(payload), /resume in same shell/u);
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        workspace: resolve(workspace),
        targetRootPid: 10,
        delayMs: 2_000,
        handoffMode: 'shell-resume-next',
        resumeMode: 'current',
        threadId: 'thread-a',
      },
    ]);
    const operation = (payload as { operation: { evidence: unknown } }).operation;
    const requested = (operation.evidence as { requested?: Record<string, unknown> }).requested;
    assert.equal(requested?.backgroundChildArgvIncludesPrompt, false);
    assert.equal(requested?.relaunchedCodexPromptTransport, 'state-file-then-managed-remote');
    assert.equal(requested?.relaunchedCodexPromptInProcessCommandLine, true);
    assert.equal(requested?.shellResumeNextStateWritesPrompt, true);
    assert.equal(requested?.shellResumeNextTarget, 'managed-remote');
    assert.equal(requested?.startsAppServer, true);
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionHardRelaunchPayload refuses default resume when current thread cannot be inferred', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    const payload = withCwd(workspace, () => buildSessionHardRelaunchPayload(
      {
        prompt: 'handoff',
      },
      {
        store,
        currentPid: 50,
        processLister: () => currentSessionProcessFixture(workspace, { threadId: null }),
        codexCommandResolver: () => 'codex-test',
      },
    ));

    assert.equal(payload.ok, false);
    assert.equal(payload.refused, true);
    assert.match(String(payload.message), /Could not infer the current thread id/u);
    assert.deepEqual(payload.resume, {
      resumeMode: 'current',
      threadId: null,
      resolved: false,
      reason: 'thread-id-not-inferable',
    });
  } finally {
    fixture.cleanup();
  }
});

test('buildSessionHardRelaunchPayload allows explicit fresh fallback without thread id', () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    const payload = withCwd(workspace, () => buildSessionHardRelaunchPayload(
      {
        prompt: 'fresh handoff',
        resumeMode: 'fresh',
      },
      {
        store,
        currentPid: 50,
        processLister: () => currentSessionProcessFixture(workspace, { threadId: null }),
        codexCommandResolver: () => 'codex-test',
      },
    ));

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.resume, {
      resumeMode: 'fresh',
      threadId: null,
      source: 'fresh',
      resolved: true,
    });
    assert.doesNotMatch(JSON.stringify(payload.handoff), /resume/u);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionHardRelaunchOperation launches plain Codex before stopping old root', async () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    store.create({
      id: 'op-hard',
      kind: 'session_hard_relaunch',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const prompt = 'secret hard relaunch prompt';
    const plans: PlainCodexLaunchPlan[] = [];
    const stopped: Array<{ rootPid: number; treePids: number[] }> = [];

    const operation = await runSessionHardRelaunchOperation(
      {
        operationId: 'op-hard',
        workspace,
        targetRootPid: 10,
        resumeMode: 'current',
        threadId: 'thread-a',
        bypassSandbox: true,
        delayMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_HARD_RELAUNCH_PROMPT: prompt },
        processLister: () => currentSessionProcessFixture(workspace),
        codexCommandResolver: () => 'codex-test',
        launchExecutor(plan) {
          plans.push(plan);
          return { ok: true, mode: 'fake', pid: 456 };
        },
        processStopper(rootPid, tree) {
          stopped.push({ rootPid, treePids: tree.map((entry) => entry.pid) });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.args, [
      'resume',
      'thread-a',
      '--disable',
      'js_repl',
      '--disable',
      'image_generation',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workspace,
      prompt,
    ]);
    assert.deepEqual(stopped, [{ rootPid: 10, treePids: [10, 20, 30, 40, 50] }]);
    assert.doesNotMatch(JSON.stringify(operation), /secret hard relaunch prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('runSessionHardRelaunchOperation writes shell resume-next state before stopping old root', async () => {
  const fixture = tempStore();
  const { workspace, store } = fixture;
  try {
    store.create({
      id: 'op-shell',
      kind: 'session_hard_relaunch',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const prompt = 'resume in same shell';
    const stopped: Array<{ rootPid: number; treePids: number[] }> = [];

    const operation = await runSessionHardRelaunchOperation(
      {
        operationId: 'op-shell',
        workspace,
        targetRootPid: 10,
        handoffMode: 'shell-resume-next',
        resumeMode: 'current',
        threadId: 'thread-a',
        bypassSandbox: true,
        delayMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_HARD_RELAUNCH_PROMPT: prompt },
        processLister: () => currentSessionProcessFixture(workspace),
        launchExecutor() {
          throw new Error('shell resume-next must not launch directly');
        },
        processStopper(rootPid, tree) {
          stopped.push({ rootPid, treePids: tree.map((entry) => entry.pid) });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    const statePath = join(workspace, '.codex-agent-session-manager', 'state', 'shell-resume-next.json');
    assert.equal(operation?.status, 'completed');
    assert.equal(existsSync(statePath), true);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { mode?: string; resumeMode?: string; threadId?: string; prompt?: string; bypassSandbox?: boolean };
    assert.equal(state.mode, 'managed-remote');
    assert.equal(state.resumeMode, 'current');
    assert.equal(state.threadId, 'thread-a');
    assert.equal(state.prompt, prompt);
    assert.equal(state.bypassSandbox, true);
    assert.match(String(operation?.nextAction), /managed-remote/u);
    assert.deepEqual(stopped, [{ rootPid: 10, treePids: [10, 20, 30, 40, 50] }]);
    assert.doesNotMatch(JSON.stringify(operation), /resume in same shell/u);
  } finally {
    fixture.cleanup();
  }
});

test('session hard relaunch operation argv round trips without prompt text', () => {
  const workspace = resolve(process.cwd());
  const args = buildSessionHardRelaunchOperationArgs({
    operationId: 'op-hard',
    workspace,
    targetRootPid: 10,
    bypassSandbox: true,
    enableImageGeneration: true,
    delayMs: 5_000,
    resumeMode: 'current',
    threadId: 'thread-a',
  });
  assert.deepEqual(parseSessionHardRelaunchOperationArgs(args.slice(1)), {
    operationId: 'op-hard',
    workspace,
    targetRootPid: 10,
    bypassSandbox: true,
    enableImageGeneration: true,
    delayMs: 5_000,
    resumeMode: 'current',
    threadId: 'thread-a',
  });
  assert.doesNotMatch(JSON.stringify(args), /prompt/u);
});
