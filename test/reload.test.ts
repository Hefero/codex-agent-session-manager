import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OperationStore } from '../src/tools/operations.js';
import {
  buildMcpReloadPayload,
  buildMcpReloadOperationArgs,
  parseMcpReloadOperationArgs,
  runMcpReloadOperation,
  type McpReloadClient,
} from '../src/tools/reload.js';

function tempWorkspace(): string {
  const workspace = join(tmpdir(), `codex-agent-session-manager-reload-${crypto.randomUUID()}`);
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

class FakeReloadClient implements McpReloadClient {
  readonly calls: string[] = [];
  closed = false;

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
          tools: { codex_mcp_reload: {}, codex_operation_read: {} },
          authStatus: { state: 'ok' },
        },
      ],
    };
  }

  close(): void {
    this.closed = true;
  }
}

test('buildMcpReloadPayload creates a durable running operation and schedules background child', () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    const scheduledInputs: unknown[] = [];
    const payload = buildMcpReloadPayload(
      {
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        highlightTools: ['codex_mcp_reload'],
        timeoutMs: 5_000,
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
            internalCommand: 'run-mcp-reload-operation',
            argvIncludesSecrets: false,
          };
        },
      },
    );

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.operationId, 'string');
    assert.deepEqual(payload.background, {
      scheduled: true,
      pid: 123,
      detached: true,
      windowsHide: true,
      internalCommand: 'run-mcp-reload-operation',
      argvIncludesSecrets: false,
    });
    assert.deepEqual(scheduledInputs, [
      {
        operationId: payload.operationId,
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        highlightTools: ['codex_mcp_reload'],
        timeoutMs: 5_000,
      },
    ]);
    const stored = store.read(String(payload.operationId));
    assert.equal(stored?.kind, 'mcp_reload');
    assert.equal(stored?.status, 'running');
    assert.equal(stored?.nextAction, 'Use codex_operation_wait with this operationId, then codex_operation_read for final evidence.');
  } finally {
    fixture.cleanup();
  }
});

test('runMcpReloadOperation completes operation with before and after status summaries', async () => {
  const fixture = tempStore();
  const { store } = fixture;
  try {
    store.create({
      id: 'op-reload',
      kind: 'mcp_reload',
      status: 'running',
      evidence: { background: { scheduled: true, pid: 123 } },
    });
    const fakeClient = new FakeReloadClient();

    const operation = await runMcpReloadOperation(
      {
        operationId: 'op-reload',
        appServerUrl: 'ws://127.0.0.1:4506',
        threadId: 'thread-a',
        highlightTools: ['codex_mcp_reload'],
        timeoutMs: 5_000,
      },
      {
        store,
        connectClient: async () => fakeClient,
      },
    );

    assert.equal(operation?.status, 'completed');
    assert.equal(operation?.nextAction, 'Reload requested. Use a continuation or fresh replacement session for callable MCP proof.');
    assert.deepEqual(fakeClient.calls, ['initialize', 'listMcpServerStatuses', 'reloadMcpServers', 'listMcpServerStatuses']);
    assert.equal(fakeClient.closed, true);

    const evidence = operation?.evidence as {
      background?: { scheduled?: boolean; pid?: number };
      statusBefore?: { serverCount?: number; servers?: Array<{ requestedToolPresence?: Record<string, boolean> }> };
      statusAfter?: { serverCount?: number };
      reload?: { requested?: boolean };
    };
    assert.deepEqual(evidence.background, { scheduled: true, pid: 123 });
    assert.equal(evidence.statusBefore?.serverCount, 1);
    assert.equal(evidence.statusBefore?.servers?.[0]?.requestedToolPresence?.codex_mcp_reload, true);
    assert.equal(evidence.statusAfter?.serverCount, 1);
    assert.equal(evidence.reload?.requested, true);
  } finally {
    fixture.cleanup();
  }
});

test('reload operation argv round trips optional values', () => {
  const args = buildMcpReloadOperationArgs({
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    highlightTools: ['tool-a', 'tool-b'],
    timeoutMs: 5_000,
  });

  assert.deepEqual(parseMcpReloadOperationArgs(args.slice(1)), {
    operationId: 'op-a',
    appServerUrl: 'ws://127.0.0.1:4506',
    threadId: 'thread-a',
    highlightTools: ['tool-a', 'tool-b'],
    timeoutMs: 5_000,
  });
});
