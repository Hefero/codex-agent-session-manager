import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OperationStore } from '../src/tools/operations.js';
import {
  buildMcpRefreshOperationArgs,
  buildMcpRefreshPayload,
  parseMcpRefreshOperationArgs,
  runMcpRefreshOperation,
  type McpRefreshClient,
} from '../src/tools/mcp-refresh.js';

function tempWorkspace(): string {
  return join(tmpdir(), `codex-agent-session-manager-refresh-${crypto.randomUUID()}`);
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

class FakeRefreshClient implements McpRefreshClient {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  closed = false;
  private readCount = 0;

  async initialize(): Promise<unknown> {
    this.calls.push('initialize');
    return { ok: true };
  }

  async reloadMcpServers(): Promise<unknown> {
    this.calls.push('reloadMcpServers');
    return { queued: true };
  }

  async listMcpServerStatuses(): Promise<{
    statuses: Array<{
      name: string;
      serverInfo: { name: string; version: string };
      tools: Record<string, unknown>;
      authStatus: { state: string };
    }>;
    pageCount: number;
  }> {
    this.calls.push('listMcpServerStatuses');
    return {
      pageCount: 1,
      statuses: [
        {
          name: 'codex_agent_session_manager',
          serverInfo: { name: 'codex-agent-session-manager', version: '0.0.0' },
          tools: { codex_mcp_refresh: {}, codex_operation_wait: {} },
          authStatus: { state: 'ok' },
        },
      ],
    };
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
    this.prompts.push(input.input[0]?.text ?? '');
    return { turn: { id: 'turn-refresh' } };
  }

  close(): void {
    this.closed = true;
  }
}

test('buildMcpRefreshPayload schedules reload plus continuation without prompt in argv or evidence', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const prompt = 'secret refresh prompt';
    const scheduledInputs: unknown[] = [];
    const scheduledPrompts: string[] = [];
    const payload = buildMcpRefreshPayload(
      {
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        prompt,
        highlightTools: ['codex_mcp_refresh'],
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
            internalCommand: 'run-mcp-refresh-operation',
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
        highlightTools: ['codex_mcp_refresh'],
        timeoutMs: 5_000,
        continuationTimeoutMs: 10_000,
        continuationPollMs: 500,
        continuationStableMs: 0,
      },
    ]);
    assert.deepEqual(scheduledPrompts, [prompt]);
    assert.doesNotMatch(JSON.stringify(payload), /secret refresh prompt/u);

    const stored = store.read(String(payload.operationId));
    assert.equal(stored?.kind, 'mcp_refresh');
    assert.equal(stored?.status, 'running');
    assert.doesNotMatch(JSON.stringify(stored), /secret refresh prompt/u);
  } finally {
    fixture.cleanup();
  }
});

test('runMcpRefreshOperation reloads MCPs before starting continuation turn', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-refresh',
      kind: 'mcp_refresh',
      status: 'running',
      evidence: { background: { scheduled: true } },
    });
    const fakeClient = new FakeRefreshClient();
    const prompt = 'secret env refresh prompt';

    const operation = await runMcpRefreshOperation(
      {
        operationId: 'op-refresh',
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        highlightTools: ['codex_mcp_refresh'],
        timeoutMs: 5_000,
        continuationTimeoutMs: 200,
        continuationPollMs: 100,
        continuationStableMs: 0,
      },
      {
        store,
        env: { CODEX_AGENT_SESSION_MANAGER_MCP_REFRESH_PROMPT: prompt },
        connectClient: async () => fakeClient,
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.deepEqual(fakeClient.calls, [
      'initialize',
      'listMcpServerStatuses',
      'reloadMcpServers',
      'listMcpServerStatuses',
      'readThread',
      'readThread',
      'startTurn',
    ]);
    assert.deepEqual(fakeClient.prompts, [prompt]);
    assert.equal(fakeClient.closed, true);
    assert.doesNotMatch(JSON.stringify(operation), /secret env refresh prompt/u);

    const evidence = operation?.evidence as {
      statusBefore?: { servers?: Array<{ requestedToolPresence?: Record<string, boolean> }> };
      statusAfter?: { serverCount?: number };
      reload?: { requested?: boolean };
      ready?: { ok?: boolean; attemptCount?: number };
      turnStart?: { requested?: boolean; turnId?: string; inputIncluded?: boolean };
    };
    assert.equal(evidence.statusBefore?.servers?.[0]?.requestedToolPresence?.codex_mcp_refresh, true);
    assert.equal(evidence.statusAfter?.serverCount, 1);
    assert.equal(evidence.reload?.requested, true);
    assert.equal(evidence.ready?.ok, true);
    assert.equal(evidence.ready?.attemptCount, 2);
    assert.equal(evidence.turnStart?.requested, true);
    assert.equal(evidence.turnStart?.turnId, 'turn-refresh');
    assert.equal(evidence.turnStart?.inputIncluded, true);
  } finally {
    fixture.cleanup();
  }
});

test('mcp refresh operation argv round trips without prompt text', () => {
  const args = buildMcpRefreshOperationArgs({
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    highlightTools: ['tool-a', 'tool-b'],
    timeoutMs: 5_000,
    continuationTimeoutMs: 10_000,
    continuationPollMs: 500,
    continuationStableMs: 0,
  });

  assert.doesNotMatch(args.join(' '), /prompt/u);
  assert.deepEqual(parseMcpRefreshOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    highlightTools: ['tool-a', 'tool-b'],
    timeoutMs: 5_000,
    continuationTimeoutMs: 10_000,
    continuationPollMs: 500,
    continuationStableMs: 0,
  });
});
