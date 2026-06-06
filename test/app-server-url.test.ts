import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    ['ws://user:pass@127.0.0.1:4506', 'must not include credentials'],
    ['ws://127.0.0.1', 'must include a port'],
    ['ws://192.168.1.10:4506', 'host must be loopback-only'],
    ['ws://127.0.0.1:4506/path', 'must not include a path'],
    ['ws://127.0.0.1:4506?token=secret', 'must not include a path'],
    ['ws://127.0.0.1:4506#fragment', 'must not include a path'],
  ];

  for (const [url, message] of cases) {
    assert.throws(() => validateAppServerUrl(url), new RegExp(message));
  }
});

test('resolveAppServerUrl prefers explicit input then environment', () => {
  assert.equal(
    resolveAppServerUrl('ws://127.0.0.1:4507', { CODEX_APP_SERVER_URL: 'ws://127.0.0.1:4508' }),
    'ws://127.0.0.1:4507',
  );
  assert.equal(resolveAppServerUrl(undefined, { CODEX_APP_SERVER_URL: 'ws://127.0.0.1:4508' }), 'ws://127.0.0.1:4508');
  assert.throws(() => resolveAppServerUrl(undefined, {}), /No App Server URL is configured/);
});
