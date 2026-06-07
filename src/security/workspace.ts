import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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
    throw new Error('Workspace root must exist.');
  }
  return root;
}

export function assertWorkspacePath(workspaceRoot: string, targetPath: string, label = 'Workspace path'): void {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const rootReal = realpathSync.native(root);
  const candidate = resolve(targetPath);

  if (!pathInside(candidate, root)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }

  const existingAncestor = deepestExistingAncestor(candidate);
  const ancestorReal = realpathSync.native(existingAncestor);
  if (!pathInside(ancestorReal, rootReal)) {
    throw new Error(`${label} must not escape the workspace through a symlink or junction.`);
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
    throw new Error('Workspace cwd must stay inside the current workspace.');
  }

  const existingAncestor = deepestExistingAncestor(candidate);
  const ancestorReal = realpathSync.native(existingAncestor);
  if (!pathInside(ancestorReal, rootReal)) {
    throw new Error('Workspace cwd must not escape the current workspace through a symlink or junction.');
  }

  return candidate;
}
