import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProbePayload } from '../src/tools/probe.js';

test('buildProbePayload returns stable marker and echo', () => {
  const result = buildProbePayload({ echo: 'unit' });

  assert.equal(result.ok, true);
  assert.equal(result.echo, 'unit');
  assert.equal(result.marker, 'codex-agent-session-manager:probe:v1');
});

