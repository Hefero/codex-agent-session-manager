import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNpmPackageInspectPayload, inspectNpmMetadataForMcpPackage } from '../src/tools/npm-package-inspect.js';

test('npm package inspection extracts credential env vars from generic README text', () => {
  const payload = inspectNpmMetadataForMcpPackage({
    packageSpec: 'example-search-mcp',
    metadata: {
      name: 'example-search-mcp',
      version: '1.2.3',
      description: 'Search MCP server',
      readme: [
        '# Example Search MCP',
        'Create an API key in the provider console.',
        'Set EXAMPLE_SEARCH_API_KEY in your environment before starting the MCP server.',
      ].join('\n'),
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.requiresSecretsLikely, true);
  assert.deepEqual(payload.candidateEnvVars.map((entry) => entry.name), ['EXAMPLE_SEARCH_API_KEY']);
  assert.match(payload.nextAction, /secret set EXAMPLE_SEARCH_API_KEY/u);
  assert.match(payload.nextAction, /envVars:\["EXAMPLE_SEARCH_API_KEY"\]/u);
});

test('npm package inspection reports auth hints when env var names are absent', () => {
  const payload = inspectNpmMetadataForMcpPackage({
    packageSpec: 'opaque-auth-mcp',
    metadata: {
      name: 'opaque-auth-mcp',
      version: '1.0.0',
      readme: 'This server requires OAuth credentials from the provider dashboard.',
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.requiresSecretsLikely, true);
  assert.deepEqual(payload.candidateEnvVars, []);
  assert.ok(payload.authHints.length > 0);
  assert.match(payload.nextAction, /Inspect the README\/repository/u);
});

test('npm package inspection handles npm view failures without leaking stderr', () => {
  const sensitiveStderr = `npm error ${['token', 'secret-value'].join('=')} registry failure`;
  const payload = buildNpmPackageInspectPayload(
    { packageSpec: 'missing-mcp' },
    {
      npmRunner: () => ({
        status: 1,
        stdout: '',
        stderr: sensitiveStderr,
      }),
    },
  );

  assert.equal(payload.ok, false);
  assert.match(String(payload.warning), /npm view failed/u);
  assert.doesNotMatch(JSON.stringify(payload), /secret-value/u);
  assert.match(String(payload.nextAction), /Inspect the package README\/repository manually/u);
});
