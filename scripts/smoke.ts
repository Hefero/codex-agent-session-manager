import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const cliEntry = join(repoRoot, 'src', 'cli.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', cliEntry, 'serve'],
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
  const requiredTools = [
    'codex_session_manager_probe',
    'codex_threads_list',
    'codex_mcp_status_list',
    'codex_app_server_state_read',
    'codex_thread_context',
    'codex_operation_read',
    'codex_operation_wait',
    'codex_mcp_add_npm',
    'codex_mcp_reload',
    'codex_mcp_refresh',
    'codex_app_server_start',
    'codex_app_server_status',
    'codex_app_server_stop',
    'codex_session_continue',
    'codex_session_close',
    'codex_session_launch',
    'codex_session_replace',
  ];
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

  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'codex_app_server_start',
      arguments: { dryRun: true, port: '4566' },
    },
  });
  const startCall = await waitForResponse(4);
  const startText = ((startCall.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';
  if (!startText.includes('"dryRun": true') || !startText.includes('ws://127.0.0.1:4566')) {
    throw new Error(`Unexpected app server start dry-run result: ${startText}`);
  }

  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'codex_app_server_status',
      arguments: { probeReady: false, includeProcessTree: false },
    },
  });
  const statusCall = await waitForResponse(5);
  const statusText = ((statusCall.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';
  if (!statusText.includes('"ok": true') || !statusText.includes('managedAppServer')) {
    throw new Error(`Unexpected app server status result: ${statusText}`);
  }

  send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'codex_app_server_stop',
      arguments: { dryRun: true },
    },
  });
  const stopCall = await waitForResponse(6);
  const stopText = ((stopCall.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';
  if (!stopText.includes('"dryRun": true') || !stopText.includes('managedAppServer')) {
    throw new Error(`Unexpected app server stop dry-run result: ${stopText}`);
  }

  send({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} });
  const resources = await waitForResponse(7);
  const resourceUris =
    (resources.result as { resources?: Array<{ uri?: string }> }).resources?.map((resource) => resource.uri) ?? [];
  if (!resourceUris.includes('codex-session-manager://operations')) {
    throw new Error(`Operations resource missing. Saw: ${resourceUris.join(', ')}`);
  }

  const cliHelp = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (
    cliHelp.status !== 0
    || !cliHelp.stdout.includes('codex-agent-session-manager init [options]')
    || !cliHelp.stdout.includes('codex-agent-session-manager app-server <start|status|stop>')
  ) {
    throw new Error(`Unexpected CLI help result: stdout=${cliHelp.stdout} stderr=${cliHelp.stderr}`);
  }

  const cliMcpHelp = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'mcp', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (
    cliMcpHelp.status !== 0
    || !cliMcpHelp.stdout.includes('codex-agent-session-manager mcp add npm <package-spec>')
    || !cliMcpHelp.stdout.includes('codex-agent-session-manager mcp refresh --thread-id <thread-id>')
  ) {
    throw new Error(`Unexpected CLI mcp help result: stdout=${cliMcpHelp.stdout} stderr=${cliMcpHelp.stderr}`);
  }

  const cliStart = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliEntry, 'app-server', 'start', '--dry-run', '--port', '4566'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (cliStart.status !== 0 || !cliStart.stdout.includes('"dryRun": true') || !cliStart.stdout.includes('ws://127.0.0.1:4566')) {
    throw new Error(`Unexpected CLI app-server start result: stdout=${cliStart.stdout} stderr=${cliStart.stderr}`);
  }

  const cliMcpAdd = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliEntry, 'mcp', 'add', 'npm', '@modelcontextprotocol/server-everything', '--dry-run'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (
    cliMcpAdd.status !== 0
    || !cliMcpAdd.stdout.includes('"dryRun": true')
    || !cliMcpAdd.stdout.includes('"serverName": "everything"')
    || !cliMcpAdd.stdout.includes('codex_mcp_refresh')
  ) {
    throw new Error(`Unexpected CLI mcp add npm dry-run result: stdout=${cliMcpAdd.stdout} stderr=${cliMcpAdd.stderr}`);
  }

  const initWorkspace = mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-init-smoke-'));
  try {
    const cliInit = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliEntry, 'init', '--dry-run', '--workspace', initWorkspace],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    if (
      cliInit.status !== 0
      || !cliInit.stdout.includes('codex-agent-session-manager init dry-run')
      || !cliInit.stdout.includes('mcp server: codex_agent_session_manager')
      || !cliInit.stdout.includes('Dry run only; no files were changed.')
    ) {
      throw new Error(`Unexpected CLI init dry-run result: stdout=${cliInit.stdout} stderr=${cliInit.stderr}`);
    }
  } finally {
    rmSync(initWorkspace, { recursive: true, force: true });
  }

  process.stdout.write('smoke ok\n');
} finally {
  child.kill();
  await once(child, 'exit').catch(() => undefined);
}
