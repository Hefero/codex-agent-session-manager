import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serverInstructions } from '../src/mcp-server.js';

test('MCP server instructions front-load npm MCP install workflow', () => {
  const first512 = serverInstructions.slice(0, 512);

  assert.match(first512, /codex_mcp_install_npm/u);
  assert.match(first512, /before any shell\/npm\/codex mcp command/u);
  assert.match(first512, /Never ask the operator to restart/u);
  assert.match(first512, /codex_mcp_refresh/u);
  assert.match(first512, /secret set <NAME>/u);
  assert.match(serverInstructions, /codex_secret_status/u);
});
