import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), 'serve'],
  {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

const rl = createInterface({ input: child.stdout });
const responses = new Map<number, JsonRpcResponse>();
const stderr: string[] = [];

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

rl.on('line', (line) => {
  const msg = JSON.parse(line) as JsonRpcResponse;
  if (typeof msg.id === 'number') {
    responses.set(msg.id, msg);
  }
});

function send(message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id: number): Promise<JsonRpcResponse> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = responses.get(id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for response ${id}. stderr=${stderr.join('')}`);
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-client', version: '0.0.0' },
    },
  });

  const init = await waitForResponse(1);
  if (init.error) throw new Error(`initialize failed: ${init.error.message ?? 'unknown'}`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitForResponse(2);
  const toolNames = (tools.result as { tools?: Array<{ name?: string }> }).tools?.map((tool) => tool.name) ?? [];
  const requiredTools = ['codex_session_manager_probe', 'codex_threads_list', 'codex_mcp_status_list', 'codex_thread_context'];
  const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`Required tools missing: ${missingTools.join(', ')}. Saw: ${toolNames.join(', ')}`);
  }

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'codex_session_manager_probe',
      arguments: { echo: 'smoke' },
    },
  });
  const call = await waitForResponse(3);
  const content = (call.result as { content?: Array<{ text?: string }> }).content ?? [];
  const text = content[0]?.text ?? '';
  if (!text.includes('"echo": "smoke"') || !text.includes('codex-agent-session-manager:probe:v1')) {
    throw new Error(`Unexpected probe result: ${text}`);
  }

  send({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} });
  const resources = await waitForResponse(4);
  const resourceUris =
    (resources.result as { resources?: Array<{ uri?: string }> }).resources?.map((resource) => resource.uri) ?? [];
  if (!resourceUris.includes('codex-session-manager://operations')) {
    throw new Error(`Operations resource missing. Saw: ${resourceUris.join(', ')}`);
  }

  process.stdout.write('smoke ok\n');
} finally {
  child.kill();
  await once(child, 'exit').catch(() => undefined);
}
