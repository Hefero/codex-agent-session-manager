import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGuidancePayload, guidanceResources } from '../src/tools/guidance.js';

test('buildGuidancePayload returns default overview and discoverable resources', () => {
  const result = buildGuidancePayload({});

  assert.equal(result.ok, true);
  assert.equal(result.topic, 'overview');
  assert.match(result.guidance, /App Server MCP status as diagnostic evidence/u);
  assert.ok(result.resources.some((resource) => resource.uri === 'codex-session-manager://guide'));
  assert.ok(guidanceResources.some((resource) => resource.uri === 'codex-session-manager://workflows/mcp-handling'));
  assert.ok(guidanceResources.some((resource) => resource.uri === 'codex-session-manager://global-install'));
});

test('buildGuidancePayload returns focused npm MCP workflow guidance', () => {
  const result = buildGuidancePayload({ topic: 'mcp-handling' });

  assert.equal(result.topic, 'mcp-handling');
  assert.match(result.guidance, /codex_local_mcp_add_npm/u);
  assert.match(result.guidance, /codex_local_mcp_remove/u);
  assert.match(result.guidance, /codex_global_mcp_add_npm/u);
  assert.match(result.guidance, /codex_global_mcp_remove/u);
  assert.match(result.guidance, /codex_mcp_refresh/u);
  assert.match(result.guidance, /Do not patch files under `node_modules`/u);
});

test('buildGuidancePayload returns focused global install guidance', () => {
  const result = buildGuidancePayload({ topic: 'global-install' });

  assert.equal(result.topic, 'global-install');
  assert.match(result.guidance, /global install/u);
  assert.match(result.guidance, /--mcp-only/u);
  assert.match(result.guidance, /hidden stdio launcher/u);
});
