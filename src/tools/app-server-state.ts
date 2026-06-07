import { z } from 'zod';

import { readWorkspaceAppServerStates, type AppServerStateRead } from '../app-server/state.js';
import { pathsMatch } from '../processes.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';
import { validateAppServerUrl } from '../security/url.js';
import { resolveWorkspaceRoot } from '../security/workspace.js';

export const appServerStateReadInputSchema = {
  includeLegacy: z.boolean().optional().describe('Defaults true. Include legacy .codex-mcp-hot-reloader launcher state as bootstrap compatibility.'),
};

const appServerStateReadInputObject = z.object(appServerStateReadInputSchema);
type AppServerStateReadInput = z.infer<typeof appServerStateReadInputObject>;

function publicError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function validatePublicUrl(rawUrl: unknown, source: string): Record<string, unknown> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return {
      urlConfigured: false,
    };
  }
  try {
    return {
      urlConfigured: true,
      validUrl: true,
      url: validateAppServerUrl(rawUrl, source).href,
    };
  } catch (error) {
    return {
      urlConfigured: true,
      validUrl: false,
      url: redactSensitiveText(rawUrl),
      urlError: publicError(error),
    };
  }
}

function publicStateRead(read: AppServerStateRead, workspace: string): Record<string, unknown> {
  const state = read.state;
  const summary: Record<string, unknown> = {
    source: read.source,
    exists: read.exists,
    ok: read.ok,
    stateFilePreview: redactSensitiveText(read.stateFile.replace(resolveWorkspaceRoot(workspace), '<workspace>')),
  };
  if (read.error !== undefined) {
    summary.error = publicError(read.error);
  }
  if (state === null) {
    return summary;
  }

  Object.assign(summary, validatePublicUrl(state.url, `App Server URL from ${read.source} launcher state`));
  if (Number.isSafeInteger(state.pid)) summary.pid = state.pid;
  if (typeof state.owned === 'boolean') summary.owned = state.owned;
  if (typeof state.reusedServer === 'boolean') summary.reusedServer = state.reusedServer;
  if (typeof state.status === 'string') summary.status = state.status;
  if (typeof state.source === 'string') summary.launchSource = state.source;
  if (typeof state.updatedAt === 'string') summary.updatedAt = state.updatedAt;
  if (typeof state.workspace === 'string') {
    summary.workspaceMatches = pathsMatch(state.workspace, workspace);
    summary.workspacePreview = pathsMatch(state.workspace, workspace) ? '<workspace>' : '<path:redacted>';
  }
  if (state.log && typeof state.log === 'object') {
    summary.log = redactValue(state.log, { workspace });
  }
  return summary;
}

function envSummary(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return validatePublicUrl(env.CODEX_APP_SERVER_URL, 'App Server URL from CODEX_APP_SERVER_URL');
}

function resolvedSummary(env: NodeJS.ProcessEnv, reads: readonly AppServerStateRead[]): Record<string, unknown> {
  const envUrl = env.CODEX_APP_SERVER_URL;
  if (envUrl !== undefined) {
    const validated = validatePublicUrl(envUrl, 'App Server URL from CODEX_APP_SERVER_URL');
    return {
      ok: validated.validUrl === true,
      source: 'env',
      ...validated,
    };
  }

  for (const read of reads) {
    const url = read.state?.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const validated = validatePublicUrl(url, `App Server URL from ${read.source} launcher state`);
    return {
      ok: validated.validUrl === true,
      source: `${read.source}-state`,
      ...validated,
    };
  }

  return {
    ok: false,
    source: null,
    urlConfigured: false,
    message: 'No App Server URL is configured. Provide appServerUrl, set CODEX_APP_SERVER_URL, or start from workspace launcher state.',
  };
}

export function buildAppServerStateReadPayload(
  input: AppServerStateReadInput,
  deps: {
    env?: NodeJS.ProcessEnv;
    workspace?: string;
  } = {},
): Record<string, unknown> {
  const env = deps.env ?? process.env;
  const workspace = resolveWorkspaceRoot(deps.workspace);
  const reads = readWorkspaceAppServerStates(workspace, { includeLegacy: input.includeLegacy ?? true });

  return {
    ok: true,
    workspacePreview: '<workspace>',
    env: envSummary(env),
    states: reads.map((read) => publicStateRead(read, workspace)),
    resolved: resolvedSummary(env, reads),
    notes: [
      'This reads launcher state only; it does not probe whether the App Server process is alive.',
      'Explicit appServerUrl tool inputs still take precedence in tools that accept them.',
    ],
  };
}
