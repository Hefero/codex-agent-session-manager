import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packageName, packageVersion } from '../src/version.js';

test('package metadata matches package.json', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };

  assert.equal(packageName, packageJson.name);
  assert.equal(packageVersion, packageJson.version);
});
