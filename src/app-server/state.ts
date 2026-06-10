import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { assertWorkspacePath, workspacePath } from '../security/workspace.js';

export const PRIMARY_STATE_DIR_NAME = '.codex-agent-session-manager';
export const LEGACY_STATE_DIR_NAME = '.codex-mcp-hot-reloader';

export type AppServerStateSource = 'primary' | 'legacy';
export type AppServerPathFlavor = 'windows' | 'wsl' | 'posix';

export interface AppServerRuntimeIdentity {
  platform: NodeJS.Platform;
  arch: string;
  isWsl: boolean;
  pathFlavor: AppServerPathFlavor;
  wslDistroName?: string;
}

export interface AppServerState {
  url?: string;
  pid?: number | null;
  owned?: boolean;
  source?: string;
  reusedServer?: boolean;
  status?: string;
  workspace?: string;
  runtime?: AppServerRuntimeIdentity;
  updatedAt?: string;
  log?: {
    stdout?: string;
    stderr?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AppServerRuntimeCompatibility {
  matches: boolean;
  reason: string | null;
  current: AppServerRuntimeIdentity;
  stateRuntime: AppServerRuntimeIdentity | null;
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

function detectWsl(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  if ((env.WSL_DISTRO_NAME ?? '').length > 0 || (env.WSL_INTEROP ?? '').length > 0) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function pathFlavorFor(platform: NodeJS.Platform, isWsl: boolean): AppServerPathFlavor {
  if (platform === 'win32') return 'windows';
  if (isWsl) return 'wsl';
  return 'posix';
}

export function currentAppServerRuntimeIdentity(input: {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
} = {}): AppServerRuntimeIdentity {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const isWsl = detectWsl(env, platform);
  return {
    platform,
    arch: input.arch ?? process.arch,
    isWsl,
    pathFlavor: pathFlavorFor(platform, isWsl),
    ...(isWsl && env.WSL_DISTRO_NAME ? { wslDistroName: env.WSL_DISTRO_NAME } : {}),
  };
}

function runtimeFromUnknown(value: unknown): AppServerRuntimeIdentity | null {
  if (!isRecord(value)) return null;
  const platform = value.platform;
  const arch = value.arch;
  const isWsl = value.isWsl;
  const pathFlavor = value.pathFlavor;
  const wslDistroName = value.wslDistroName;
  if (typeof platform !== 'string' || typeof arch !== 'string' || typeof isWsl !== 'boolean' || typeof pathFlavor !== 'string') {
    return null;
  }
  if (!['windows', 'wsl', 'posix'].includes(pathFlavor)) return null;
  return {
    platform: platform as NodeJS.Platform,
    arch,
    isWsl,
    pathFlavor: pathFlavor as AppServerPathFlavor,
    ...(typeof wslDistroName === 'string' && wslDistroName.length > 0 ? { wslDistroName } : {}),
  };
}

export function appServerRuntimeCompatibility(
  state: AppServerState | null,
  current = currentAppServerRuntimeIdentity(),
): AppServerRuntimeCompatibility {
  const stateRuntime = runtimeFromUnknown(state?.runtime);
  if (stateRuntime === null) {
    return {
      matches: false,
      reason: 'App Server launcher state has no runtime identity; refusing automatic reuse of legacy state.',
      current,
      stateRuntime: null,
    };
  }
  if (stateRuntime.platform !== current.platform) {
    return {
      matches: false,
      reason: `App Server launcher state was created on ${stateRuntime.platform}, current runtime is ${current.platform}.`,
      current,
      stateRuntime,
    };
  }
  if (stateRuntime.pathFlavor !== current.pathFlavor) {
    return {
      matches: false,
      reason: `App Server launcher state uses ${stateRuntime.pathFlavor} paths, current runtime uses ${current.pathFlavor} paths.`,
      current,
      stateRuntime,
    };
  }
  if (stateRuntime.isWsl !== current.isWsl) {
    return {
      matches: false,
      reason: 'App Server launcher state WSL identity does not match the current runtime.',
      current,
      stateRuntime,
    };
  }
  if (stateRuntime.isWsl && current.isWsl && stateRuntime.wslDistroName !== current.wslDistroName) {
    return {
      matches: false,
      reason: `App Server launcher state was created in WSL distro ${stateRuntime.wslDistroName ?? '<unknown>'}, current distro is ${current.wslDistroName ?? '<unknown>'}.`,
      current,
      stateRuntime,
    };
  }
  return {
    matches: true,
    reason: null,
    current,
    stateRuntime,
  };
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
  writeFileSync(tempFile, `${JSON.stringify({
    ...state,
    runtime: runtimeFromUnknown(state.runtime) ?? currentAppServerRuntimeIdentity(),
  }, null, 2)}\n`);
  renameSync(tempFile, stateFile);
  return stateFile;
}
