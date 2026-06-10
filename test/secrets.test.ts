import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runSecretCommand } from '../src/secret-cli.js';
import { buildManagedProcessEnv, setStoredSecret, unsetStoredSecret } from '../src/secrets.js';
import { buildSecretStatusPayload } from '../src/tools/secrets.js';

function tempDir(prefix = 'codex-agent-session-manager-secrets-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('secret set stores hidden value without printing it', async () => {
  const dir = tempDir();
  const storeFile = join(dir, 'secrets.json');
  const output: string[] = [];
  try {
    const code = await runSecretCommand(['set', 'TAVILY_API_KEY'], {
      storeFile,
      output: (text) => output.push(text),
      readSecret: async () => 'value-one',
    });

    assert.equal(code, 0);
    const text = output.join('\n');
    assert.match(text, /secret set applied/u);
    assert.match(text, /TAVILY_API_KEY/u);
    assert.match(text, /value: <hidden>/u);
    assert.doesNotMatch(text, /value-one/u);

    const stored = JSON.parse(readFileSync(storeFile, 'utf8')) as { secrets?: Record<string, string> };
    assert.equal(stored.secrets?.TAVILY_API_KEY, 'value-one');
    if (process.platform !== 'win32') {
      assert.equal((statSync(storeFile).mode & 0o777).toString(8), '600');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret commands list, status, stdin set, and unset without exposing values', async () => {
  const dir = tempDir();
  const storeFile = join(dir, 'secrets.json');
  try {
    const setOutput: string[] = [];
    await runSecretCommand(['set', 'SEARCH_API_KEY', '--stdin'], {
      storeFile,
      output: (text) => setOutput.push(text),
      readStdin: async () => 'stdin-value\n',
    });
    assert.doesNotMatch(setOutput.join('\n'), /stdin-value/u);

    const listOutput: string[] = [];
    await runSecretCommand(['list'], { storeFile, output: (text) => listOutput.push(text) });
    assert.match(listOutput.join('\n'), /SEARCH_API_KEY/u);

    const statusOutput: string[] = [];
    await runSecretCommand(['status', 'SEARCH_API_KEY'], { storeFile, output: (text) => statusOutput.push(text), env: {} });
    assert.match(statusOutput.join('\n'), /SEARCH_API_KEY: store/u);

    await runSecretCommand(['unset', 'SEARCH_API_KEY'], { storeFile, output: () => undefined });
    const missingOutput: string[] = [];
    await runSecretCommand(['status', 'SEARCH_API_KEY'], { storeFile, output: (text) => missingOutput.push(text), env: {} });
    assert.match(missingOutput.join('\n'), /SEARCH_API_KEY: missing/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret set rejects confirmation mismatches', async () => {
  const dir = tempDir();
  const storeFile = join(dir, 'secrets.json');
  let call = 0;
  try {
    await assert.rejects(
      () => runSecretCommand(['set', 'TAVILY_API_KEY'], {
        storeFile,
        readSecret: async () => {
          call += 1;
          return call === 1 ? 'first-value' : 'second-value';
        },
      }),
      /confirmation did not match/u,
    );
    assert.equal(existsSync(storeFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed process env loads user and workspace secrets while preserving explicit env', () => {
  const dir = tempDir();
  const workspace = join(dir, 'workspace');
  const userStore = join(dir, 'user-secrets.json');
  try {
    mkdirSync(workspace, { recursive: true });
    withEnv({ CODEX_AGENT_SESSION_MANAGER_SECRETS_FILE: userStore }, () => {
      const tavilyName = ['TAVILY', 'API', 'KEY'].join('_');
      setStoredSecret(tavilyName, 'stored-user', { scope: 'user' });
      setStoredSecret('WORKSPACE_API_KEY', 'stored-workspace', { scope: 'workspace', workspace });

      const env = buildManagedProcessEnv({
        workspace,
        appServerUrl: 'ws://127.0.0.1:4555',
        baseEnv: {
          [tavilyName]: 'explicit-env',
          PATH: 'test-path',
        },
      });

      assert.equal(env[tavilyName], 'explicit-env');
      assert.equal(env.WORKSPACE_API_KEY, 'stored-workspace');
      assert.equal(env.CODEX_APP_SERVER_URL, 'ws://127.0.0.1:4555');
      assert.equal(env.PATH, 'test-path');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP secret status reports availability without values', () => {
  const dir = tempDir();
  const userStore = join(dir, 'user-secrets.json');
  try {
    withEnv({ CODEX_AGENT_SESSION_MANAGER_SECRETS_FILE: userStore, TAVILY_API_KEY: undefined }, () => {
      setStoredSecret('TAVILY_API_KEY', 'stored-user', { scope: 'user' });
      const payload = buildSecretStatusPayload({ names: ['TAVILY_API_KEY'], scope: 'user' }) as {
        stores?: Array<{ entries?: Array<{ name?: string; source?: string }> }>;
      };

      const text = JSON.stringify(payload);
      assert.match(text, /TAVILY_API_KEY/u);
      assert.match(text, /store/u);
      assert.doesNotMatch(text, /stored-user/u);
    });
  } finally {
    unsetStoredSecret('TAVILY_API_KEY', { scope: 'user', filePath: userStore });
    rmSync(dir, { recursive: true, force: true });
  }
});
