import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import { errorPayload, formatCliError, isUserFacingError, userError } from '../src/errors.js';

test('userError builds redacted structured payloads', () => {
  const sensitiveAssignment = `${['API', 'KEY'].join('_')}=secret-value`;
  const sensitiveKey = ['api', 'Key'].join('');
  const payload = errorPayload(userError({
    code: 'bad_token',
    message: `Token failed: ${sensitiveAssignment}`,
    command: 'mcp local add npm',
    parameter: '--env-var',
    received: { [sensitiveKey]: 'secret-value', path: 'C:\\Users\\Someone\\secret.txt' },
    expected: 'Environment variable names, not secret values.',
    examples: ['codex-agent-session-manager mcp local add npm example --env-var API_KEY --dry-run'],
    nextAction: 'Store the secret in the environment and pass only its variable name.',
  }));

  assert.equal(payload.ok, false);
  const error = payload.error as Record<string, unknown>;
  assert.equal(error.code, 'bad_token');
  assert.equal(error.parameter, '--env-var');
  assert.match(String(error.message), /API_KEY=<redacted>/u);
  assert.deepEqual((error.received as Record<string, unknown>)[sensitiveKey], '<redacted>');
  assert.match(String(payload.nextAction), /variable name/u);
});

test('zod errors become invalid_tool_input payloads', () => {
  const schema = z.object({ threadId: z.string().min(1) });
  let caught: unknown;
  try {
    schema.parse({ threadId: '' });
  } catch (error) {
    caught = error;
  }

  const payload = errorPayload(caught, { tool: 'codex_session_close' });
  assert.equal(payload.ok, false);
  const error = payload.error as Record<string, unknown>;
  assert.equal(error.code, 'invalid_tool_input');
  assert.equal(error.tool, 'codex_session_close');
  assert.equal(error.parameter, 'threadId');
  assert.match(String(error.message), /threadId/u);
  assert.match(String(payload.nextAction), /Fix the invalid input/u);
});

test('formatCliError keeps messages actionable for humans', () => {
  const formatted = formatCliError(userError({
    code: 'missing_required_option',
    message: '--thread-id is required.',
    command: 'session close',
    parameter: '--thread-id',
    expected: 'A Codex thread id.',
    examples: ['codex-agent-session-manager session close --thread-id <thread-id> --dry-run'],
    nextAction: 'Use codex_threads_list to find the target thread id.',
  }));

  assert.match(formatted, /Error \[missing_required_option\]/u);
  assert.match(formatted, /Parameter: --thread-id/u);
  assert.match(formatted, /Examples:/u);
  assert.match(formatted, /codex_threads_list/u);
});

test('isUserFacingError identifies expected command errors', () => {
  const error = userError({ code: 'example', message: 'example' });
  assert.equal(isUserFacingError(error), true);
  assert.equal(isUserFacingError(new Error('plain')), false);
});
