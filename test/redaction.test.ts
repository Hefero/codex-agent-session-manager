import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactArgv, redactJsonRpcError, redactSensitiveText, redactValue } from '../src/security/redaction.js';

test('redactSensitiveText hides credentials, tokens, and user paths', () => {
  const credentialUrl = ['ws://user', ':pass@127.0.0.1:4506', '?api_key=secret&debug=true'].join('');
  const userPath = ['C:', 'Users', 'Alice', 'repo'].join('\\');
  const text = redactSensitiveText(
    `Authorization: Bearer abc123 TOKEN=secret ${credentialUrl} ${userPath}`,
  );

  assert.doesNotMatch(text, /abc123|TOKEN=secret|user:pass|api_key=secret|Alice/u);
  assert.match(text, /Authorization: <redacted>/u);
  assert.match(text, /TOKEN=<redacted>/u);
  assert.match(text, /api_key=%3Credacted%3E/u);
  assert.match(text, /<path:redacted>/u);
});

test('redactArgv redacts sensitive option values', () => {
  assert.deepEqual(redactArgv(['--prompt', 'secret prompt', '--cwd', 'C:\\work']), [
    '--prompt',
    '<redacted>',
    '--cwd',
    'C:\\work',
  ]);
  assert.deepEqual(redactArgv(['--api-key=secret']), ['--api-key=<redacted>']);
});

test('redactValue redacts sensitive keys recursively', () => {
  assert.deepEqual(redactValue({ nested: { token: 'secret', ok: 'visible' } }), {
    nested: { token: '<redacted>', ok: 'visible' },
  });
});

test('redactJsonRpcError hides turn/start prompt-bearing messages', () => {
  const redacted = redactJsonRpcError('turn/start', {
    code: -32602,
    message: 'prompt contained secret',
    data: { prompt: 'secret' },
  });

  assert.deepEqual(redacted, {
    redacted: true,
    code: -32602,
    message: '<redacted:turn-start-error-message>',
  });
});
