import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { userError } from '../errors.js';

function pathInside(candidate: string, root: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function deepestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function resolveWorkspaceRoot(workspaceRoot = process.cwd()): string {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    throw userError({
      code: 'workspace_root_missing',
      message: 'Workspace root must exist.',
      parameter: 'workspace',
      received: workspaceRoot,
      expected: 'An existing workspace directory.',
      examples: ['codex-agent-session-manager init --workspace .'],
      nextAction: 'Create the workspace directory first, or pass an existing directory through --workspace.',
    });
  }
  return root;
}

export function assertWorkspacePath(workspaceRoot: string, targetPath: string, label = 'Workspace path'): void {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const rootReal = realpathSync.native(root);
  const candidate = resolve(targetPath);

  if (!pathInside(candidate, root)) {
    throw userError({
      code: 'workspace_path_escape',
      message: `${label} must stay inside the workspace.`,
      parameter: label,
      received: targetPath,
      expected: 'A path inside the initialized workspace. Prefer "." or a workspace-relative path.',
      examples: ['.', 'prompt.txt', '.codex/config.toml'],
      nextAction: 'Omit the path parameter or pass a path that resolves inside the current workspace.',
    });
  }

  const existingAncestor = deepestExistingAncestor(candidate);
  const ancestorReal = realpathSync.native(existingAncestor);
  if (!pathInside(ancestorReal, rootReal)) {
    throw userError({
      code: 'workspace_path_symlink_escape',
      message: `${label} must not escape the workspace through a symlink or junction.`,
      parameter: label,
      received: targetPath,
      expected: 'A real path whose existing ancestor remains inside the workspace.',
      examples: ['prompt.txt', 'subdir/prompt.txt'],
      nextAction: 'Use a real workspace-local file or directory instead of a symlink/junction that points outside the workspace.',
    });
  }
}

export function workspacePath(workspaceRoot: string, ...segments: string[]): string {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const candidate = resolve(root, ...segments);
  assertWorkspacePath(root, candidate);
  return candidate;
}

export function resolveWorkspaceCwd(inputCwd: string | undefined, workspaceRoot = process.cwd()): string {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const rootReal = realpathSync.native(root);
  const candidate = inputCwd === undefined ? root : resolve(root, inputCwd);

  if (!pathInside(candidate, root)) {
    throw userError({
      code: 'workspace_cwd_escape',
      message: 'Workspace cwd must stay inside the current workspace.',
      parameter: 'cwd',
      received: inputCwd,
      expected: 'A cwd inside the initialized workspace.',
      examples: ['.', 'subdir'],
      nextAction: 'Pass a workspace-relative cwd or omit cwd to use the workspace root.',
    });
  }

  const existingAncestor = deepestExistingAncestor(candidate);
  const ancestorReal = realpathSync.native(existingAncestor);
  if (!pathInside(ancestorReal, rootReal)) {
    throw userError({
      code: 'workspace_cwd_symlink_escape',
      message: 'Workspace cwd must not escape the current workspace through a symlink or junction.',
      parameter: 'cwd',
      received: inputCwd,
      expected: 'A real cwd whose existing ancestor remains inside the workspace.',
      examples: ['.', 'subdir'],
      nextAction: 'Use a real workspace-local directory instead of a symlink/junction that points outside the workspace.',
    });
  }

  return candidate;
}
