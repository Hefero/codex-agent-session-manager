import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAppServerUrl } from '../src/app-server/config.js';
import { validateAppServerUrl } from '../src/security/url.js';

test('validateAppServerUrl accepts loopback websocket roots', () => {
  assert.deepEqual(validateAppServerUrl('ws://127.0.0.1:4506'), {
    href: 'ws://127.0.0.1:4506',
    protocol: 'ws:',
    hostname: '127.0.0.1',
    port: 4506,
  });
  assert.equal(validateAppServerUrl('wss://localhost:4506').href, 'wss://localhost:4506');
  assert.equal(validateAppServerUrl('ws://[::1]:4506').hostname, '::1');
});

test('validateAppServerUrl rejects unsafe App Server URLs', () => {
  const cases: Array<[string, string]> = [
    ['http://127.0.0.1:4506', 'must use ws:// or wss://'],
    [['ws://user', ':pass@127.0.0.1:4506'].join(''), 'must not include credentials'],
    ['ws://127.0.0.1', 'must include a port'],
    ['ws://192.168.1.10:4506', 'host must be loopback-only'],
    [['ws://127.0.0.1:4506', '/path'].join(''), 'must not include a path'],
    [['ws://127.0.0.1:4506', '?token=secret'].join(''), 'must not include a path'],
    [['ws://127.0.0.1:4506', '#fragment'].join(''), 'must not include a path'],
  ];

  for (const [url, message] of cases) {
    assert.throws(() => validateAppServerUrl(url), new RegExp(message));
  }
});

test('resolveAppServerUrl prefers explicit input then environment', () => {
  const workspaceWithoutState = mkdtempSync(join(tmpdir(), 'codex-session-manager-empty-'));
  assert.equal(
    resolveAppServerUrl('ws://127.0.0.1:4507', { CODEX_APP_SERVER_URL: 'ws://127.0.0.1:4508' }),
    'ws://127.0.0.1:4507',
  );
  assert.equal(resolveAppServerUrl(undefined, { CODEX_APP_SERVER_URL: 'ws://127.0.0.1:4508' }), 'ws://127.0.0.1:4508');
  try {
    assert.throws(() => resolveAppServerUrl(undefined, {}, workspaceWithoutState), /No App Server URL is configured/);
  } finally {
    rmSync(workspaceWithoutState, { recursive: true, force: true });
  }
});

test('resolveAppServerUrl falls back to workspace launcher state', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-session-manager-'));
  try {
    const legacyStateDir = join(workspace, '.codex-mcp-hot-reloader', 'state');
    mkdirSync(legacyStateDir, { recursive: true });
    writeFileSync(join(legacyStateDir, 'app-server.json'), `${JSON.stringify({ url: 'ws://127.0.0.1:4510' })}\n`);

    assert.equal(resolveAppServerUrl(undefined, {}, workspace), 'ws://127.0.0.1:4510');

    const primaryStateDir = join(workspace, '.codex-agent-session-manager', 'state');
    mkdirSync(primaryStateDir, { recursive: true });
    writeFileSync(join(primaryStateDir, 'app-server.json'), `${JSON.stringify({ url: 'ws://127.0.0.1:4511' })}\n`);

    assert.equal(resolveAppServerUrl(undefined, {}, workspace), 'ws://127.0.0.1:4511');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
