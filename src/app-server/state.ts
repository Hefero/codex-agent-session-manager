import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { assertWorkspacePath, workspacePath } from '../security/workspace.js';

export const PRIMARY_STATE_DIR_NAME = '.codex-agent-session-manager';
export const LEGACY_STATE_DIR_NAME = '.codex-mcp-hot-reloader';

export type AppServerStateSource = 'primary' | 'legacy';

export interface AppServerState {
  url?: string;
  pid?: number | null;
  owned?: boolean;
  source?: string;
  reusedServer?: boolean;
  status?: string;
  workspace?: string;
  updatedAt?: string;
  log?: {
    stdout?: string;
    stderr?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AppServerStateRead {
  source: AppServerStateSource;
  stateFile: string;
  exists: boolean;
  ok: boolean;
  state: AppServerState | null;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stateFromUnknown(value: unknown): AppServerState | null {
  if (!isRecord(value)) return null;
  const state: AppServerState = {};
  for (const [key, entry] of Object.entries(value)) {
    state[key] = entry;
  }
  return state;
}

function stateDirName(source: AppServerStateSource): string {
  return source === 'primary' ? PRIMARY_STATE_DIR_NAME : LEGACY_STATE_DIR_NAME;
}

export function appServerStateFileForWorkspace(workspace = process.cwd(), source: AppServerStateSource = 'primary'): string {
  return workspacePath(workspace, stateDirName(source), 'state', 'app-server.json');
}

export function readAppServerStateFile(stateFile: string, source: AppServerStateSource): AppServerStateRead {
  const resolvedStateFile = resolve(stateFile);
  if (!existsSync(resolvedStateFile)) {
    return {
      source,
      stateFile: resolvedStateFile,
      exists: false,
      ok: true,
      state: null,
    };
  }

  try {
    const state = stateFromUnknown(JSON.parse(readFileSync(resolvedStateFile, 'utf8')) as unknown);
    if (state === null) {
      return {
        source,
        stateFile: resolvedStateFile,
        exists: true,
        ok: false,
        state: null,
        error: 'App Server state file must contain a JSON object.',
      };
    }
    return {
      source,
      stateFile: resolvedStateFile,
      exists: true,
      ok: true,
      state,
    };
  } catch (error) {
    return {
      source,
      stateFile: resolvedStateFile,
      exists: true,
      ok: false,
      state: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readWorkspaceAppServerStates(
  workspace = process.cwd(),
  options: { includeLegacy?: boolean } = {},
): AppServerStateRead[] {
  const reads = [readAppServerStateFile(appServerStateFileForWorkspace(workspace, 'primary'), 'primary')];
  if (options.includeLegacy ?? true) {
    reads.push(readAppServerStateFile(appServerStateFileForWorkspace(workspace, 'legacy'), 'legacy'));
  }
  return reads;
}

export function writeAppServerState(state: AppServerState, workspace = process.cwd()): string {
  const stateFile = appServerStateFileForWorkspace(workspace, 'primary');
  assertWorkspacePath(workspace, stateFile);
  mkdirSync(dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempFile, stateFile);
  return stateFile;
}
