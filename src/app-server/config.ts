import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { validateAppServerUrl } from '../security/url.js';

const WORKSPACE_STATE_DIR_NAMES = ['.codex-agent-session-manager', '.codex-mcp-hot-reloader'] as const;

function readWorkspaceStateUrl(workspace: string): string | null {
  const workspaceRoot = resolve(workspace);

  for (const stateDirName of WORKSPACE_STATE_DIR_NAMES) {
    const stateFile = join(workspaceRoot, stateDirName, 'state', 'app-server.json');
    if (!existsSync(stateFile)) continue;

    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      const url = (parsed as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) return url;
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveAppServerUrl(
  inputUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  workspace = process.cwd(),
): string {
  if (inputUrl !== undefined) {
    return validateAppServerUrl(inputUrl, 'App Server URL from tool input').href;
  }

  const envUrl = env.CODEX_APP_SERVER_URL;
  if (envUrl !== undefined) {
    return validateAppServerUrl(envUrl, 'App Server URL from CODEX_APP_SERVER_URL').href;
  }

  const stateUrl = readWorkspaceStateUrl(workspace);
  if (stateUrl !== null) {
    return validateAppServerUrl(stateUrl, 'App Server URL from workspace launcher state').href;
  }

  throw new Error('No App Server URL is configured. Provide appServerUrl, set CODEX_APP_SERVER_URL, or start from workspace launcher state.');
}
