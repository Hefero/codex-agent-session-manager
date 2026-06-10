import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  appServerRuntimeCompatibility,
  appServerStateFileForWorkspace,
  currentAppServerRuntimeIdentity,
  readAppServerStateFile,
  readWorkspaceAppServerStates,
  writeAppServerState,
  type AppServerRuntimeIdentity,
} from '../src/app-server/state.js';
import { buildAppServerStateReadPayload } from '../src/tools/app-server-state.js';

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codex-session-manager-state-'));
}

function incompatibleRuntime(): AppServerRuntimeIdentity {
  const current = currentAppServerRuntimeIdentity();
  return current.pathFlavor === 'windows'
    ? { platform: 'linux', arch: 'x64', isWsl: true, pathFlavor: 'wsl', wslDistroName: 'Ubuntu-24.04' }
    : { platform: 'win32', arch: 'x64', isWsl: false, pathFlavor: 'windows' };
}

test('app server state helpers read primary and legacy workspace state', () => {
  const workspace = tempWorkspace();
  try {
    const primaryFile = appServerStateFileForWorkspace(workspace, 'primary');
    const legacyFile = appServerStateFileForWorkspace(workspace, 'legacy');
    mkdirSync(join(workspace, '.codex-mcp-hot-reloader', 'state'), { recursive: true });
    writeFileSync(legacyFile, `${JSON.stringify({ url: 'ws://127.0.0.1:4510', owned: true })}\n`);

    assert.equal(writeAppServerState({ url: 'ws://127.0.0.1:4511', pid: 123, owned: true }, workspace), primaryFile);
    const primary = JSON.parse(readFileSync(primaryFile, 'utf8')) as { url?: string; runtime?: unknown };
    assert.equal(primary.url, 'ws://127.0.0.1:4511');
    assert.equal(appServerRuntimeCompatibility(readAppServerStateFile(primaryFile, 'primary').state).matches, true);

    const reads = readWorkspaceAppServerStates(workspace);
    assert.equal(reads.length, 2);
    assert.equal(reads[0]?.source, 'primary');
    assert.equal(reads[0]?.state?.url, 'ws://127.0.0.1:4511');
    assert.equal(reads[1]?.source, 'legacy');
    assert.equal(reads[1]?.state?.url, 'ws://127.0.0.1:4510');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('app server state read reports and skips incompatible runtime state', () => {
  const workspace = tempWorkspace();
  try {
    writeAppServerState({
      url: 'ws://127.0.0.1:4511',
      pid: 123,
      owned: true,
      workspace,
      runtime: incompatibleRuntime(),
    }, workspace);

    const payload = buildAppServerStateReadPayload({}, { env: {}, workspace });
    const states = payload.states as Array<{ runtimeMatches?: boolean; runtimeMismatchReason?: string }>;
    assert.equal(states[0]?.runtimeMatches, false);
    assert.match(states[0]?.runtimeMismatchReason ?? '', /runtime|paths|created on|identity/iu);
    const resolved = payload.resolved as { ok?: boolean; source?: string | null; urlConfigured?: boolean; message?: string };
    assert.equal(resolved.ok, false);
    assert.equal(resolved.source, null);
    assert.equal(resolved.urlConfigured, false);
    assert.match(resolved.message ?? '', /No compatible App Server URL.*Ignored incompatible workspace launcher state/iu);
    assert.deepEqual({
      ok: resolved.ok,
      source: resolved.source,
      urlConfigured: resolved.urlConfigured,
    }, {
      ok: false,
      source: null,
      urlConfigured: false,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('readAppServerStateFile reports corrupt state without throwing', () => {
  const workspace = tempWorkspace();
  try {
    const stateFile = appServerStateFileForWorkspace(workspace, 'primary');
    mkdirSync(join(workspace, '.codex-agent-session-manager', 'state'), { recursive: true });
    writeFileSync(stateFile, '{not json');

    const read = readAppServerStateFile(stateFile, 'primary');
    assert.equal(read.exists, true);
    assert.equal(read.ok, false);
    assert.equal(read.state, null);
    assert.equal(typeof read.error, 'string');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('app server state read payload reports resolution precedence and redacts workspace paths', () => {
  const workspace = tempWorkspace();
  try {
    mkdirSync(join(workspace, '.codex-mcp-hot-reloader', 'state'), { recursive: true });
    writeFileSync(
      appServerStateFileForWorkspace(workspace, 'legacy'),
      `${JSON.stringify({
        url: 'ws://127.0.0.1:4510',
        pid: 456,
        owned: true,
        workspace,
        log: { stdout: join(workspace, 'server.out.log') },
      })}\n`,
    );
    writeAppServerState({ url: 'ws://127.0.0.1:4511', pid: 123, owned: true, workspace }, workspace);

    const fromState = buildAppServerStateReadPayload({}, { env: {}, workspace });
    assert.deepEqual((fromState.resolved as { source?: string; url?: string; ok?: boolean }), {
      ok: true,
      source: 'primary-state',
      urlConfigured: true,
      validUrl: true,
      url: 'ws://127.0.0.1:4511',
    });
    assert.doesNotMatch(JSON.stringify(fromState), new RegExp(escapeRegExp(resolve(workspace)), 'u'));

    const fromEnv = buildAppServerStateReadPayload({}, { env: { CODEX_APP_SERVER_URL: 'ws://127.0.0.1:4512' }, workspace });
    assert.deepEqual((fromEnv.resolved as { source?: string; url?: string; ok?: boolean }), {
      ok: true,
      source: 'env',
      urlConfigured: true,
      validUrl: true,
      url: 'ws://127.0.0.1:4512',
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('app server state read payload can omit legacy state', () => {
  const workspace = tempWorkspace();
  try {
    const payload = buildAppServerStateReadPayload({ includeLegacy: false }, { env: {}, workspace });
    const states = payload.states as Array<{ source?: string }>;
    assert.deepEqual(states.map((state) => state.source), ['primary']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
