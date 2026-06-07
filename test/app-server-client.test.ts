import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppServerJsonRpcClient, AppServerRpcError, type AppServerConnection } from '../src/app-server/client.js';

class FakeConnection implements AppServerConnection {
  readonly sent: unknown[] = [];
  closed = false;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as unknown);
  }

  close(): void {
    this.closed = true;
  }
}

function createClient(): { client: AppServerJsonRpcClient; connection: FakeConnection } {
  const connection = new FakeConnection();
  const client = new AppServerJsonRpcClient(connection, {
    url: 'ws://127.0.0.1:4506',
    requestTimeoutMs: 10_000,
    clientInfo: { name: 'unit-client', version: '0.0.0' },
  });
  return { client, connection };
}

async function initializeClient(client: AppServerJsonRpcClient): Promise<void> {
  const initialized = client.initialize();
  client.handleIncomingMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  await initialized;
}

test('initialize sends initialize request and initialized notification', async () => {
  const { client, connection } = createClient();

  const initialized = client.initialize();
  assert.deepEqual(connection.sent[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'unit-client', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    },
  });

  client.handleIncomingMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { server: 'ready' } }));
  assert.deepEqual(await initialized, { server: 'ready' });
  assert.deepEqual(connection.sent[1], {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  });
});

test('listLoadedThreads resolves by matching JSON-RPC response id', async () => {
  const { client, connection } = createClient();
  await initializeClient(client);

  const loaded = client.listLoadedThreads();
  assert.deepEqual(connection.sent[2], {
    jsonrpc: '2.0',
    id: 2,
    method: 'thread/loaded/list',
    params: {},
  });

  client.handleIncomingMessage(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { data: ['wrong-thread'] } }));
  client.handleIncomingMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: ['thread-a', 123, 'thread-b'] } }));

  assert.deepEqual(await loaded, {
    threadIds: ['thread-a', 'thread-b'],
    raw: { data: ['thread-a', 123, 'thread-b'] },
  });
});

test('reloadMcpServers sends config/mcpServer/reload without params', async () => {
  const { client, connection } = createClient();
  await initializeClient(client);

  const reload = client.reloadMcpServers();
  assert.deepEqual(connection.sent[2], {
    jsonrpc: '2.0',
    id: 2,
    method: 'config/mcpServer/reload',
  });

  client.handleIncomingMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { queued: true } }));
  assert.deepEqual(await reload, { queued: true });
});

test('App Server errors become AppServerRpcError with redacted public message', async () => {
  const { client } = createClient();
  await initializeClient(client);

  const loaded = client.listLoadedThreads();
  client.handleIncomingMessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32000,
        message: 'Authorization: Bearer secret-token ws://user:pass@127.0.0.1:4506?api_key=secret',
        data: { token: 'secret-token', visible: 'safe' },
      },
    }),
  );

  await assert.rejects(
    loaded,
    (error: unknown) => {
      assert.ok(error instanceof AppServerRpcError);
      assert.equal(error.method, 'thread/loaded/list');
      assert.doesNotMatch(error.message, /secret-token|user:pass|api_key=secret/u);
      assert.match(error.message, /Authorization: <redacted>/u);
      assert.deepEqual((error.redactedError as Record<string, unknown>).data, { token: '<redacted>', visible: 'safe' });
      assert.doesNotMatch(JSON.stringify(error.redactedError), /secret-token|user:pass|api_key=secret/u);
      return true;
    },
  );
});
