import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveWorkspaceCwd, resolveWorkspaceRoot, workspacePath } from '../src/security/workspace.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolveWorkspaceCwd defaults to workspace root and accepts subdirectories', () => {
  const workspace = tempDir('codex-session-manager-workspace-');
  try {
    mkdirSync(join(workspace, 'nested'), { recursive: true });

    assert.equal(resolveWorkspaceCwd(undefined, workspace), resolve(workspace));
    assert.equal(resolveWorkspaceCwd('nested', workspace), resolve(workspace, 'nested'));
    assert.equal(resolveWorkspaceCwd(join(workspace, 'nested', 'future'), workspace), resolve(workspace, 'nested', 'future'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('resolveWorkspaceCwd rejects lexical workspace escapes', () => {
  const workspace = tempDir('codex-session-manager-workspace-');
  const outside = tempDir('codex-session-manager-outside-');
  try {
    assert.throws(() => resolveWorkspaceCwd('..', workspace), /must stay inside/u);
    assert.throws(() => resolveWorkspaceCwd(outside, workspace), /must stay inside/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveWorkspaceRoot requires an existing workspace', () => {
  const workspace = tempDir('codex-session-manager-workspace-');
  const missing = join(workspace, 'missing');
  try {
    assert.throws(() => resolveWorkspaceRoot(missing), /must exist/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspacePath accepts managed children and rejects lexical escapes', () => {
  const workspace = tempDir('codex-session-manager-workspace-');
  try {
    assert.equal(workspacePath(workspace, '.codex', 'config.toml'), resolve(workspace, '.codex', 'config.toml'));
    assert.throws(() => workspacePath(workspace, '..', 'outside.txt'), /must stay inside/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('resolveWorkspaceCwd rejects symlink or junction workspace escapes', (t) => {
  const workspace = tempDir('codex-session-manager-workspace-');
  const outside = tempDir('codex-session-manager-outside-');
  const link = join(workspace, 'outside-link');
  try {
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink or junction creation is unavailable in this environment');
      return;
    }

    assert.throws(() => resolveWorkspaceCwd(join('outside-link', 'future'), workspace), /symlink or junction/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspacePath rejects symlink or junction managed path escapes', (t) => {
  const workspace = tempDir('codex-session-manager-workspace-');
  const outside = tempDir('codex-session-manager-outside-');
  const link = join(workspace, '.codex');
  try {
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink or junction creation is unavailable in this environment');
      return;
    }

    assert.throws(() => workspacePath(workspace, '.codex', 'config.toml'), /symlink or junction/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
