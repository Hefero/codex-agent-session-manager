import { validateAppServerUrl } from '../security/url.js';
import { appServerRuntimeCompatibility, readWorkspaceAppServerStates } from './state.js';

function readWorkspaceStateUrl(workspace: string): { url: string | null; ignoredReasons: string[] } {
  const ignoredReasons: string[] = [];
  for (const stateRead of readWorkspaceAppServerStates(workspace)) {
    const url = stateRead.state?.url;
    if (typeof url !== 'string' || url.length === 0) continue;

    const runtime = appServerRuntimeCompatibility(stateRead.state);
    if (!runtime.matches) {
      ignoredReasons.push(`${stateRead.source}: ${runtime.reason ?? 'App Server launcher state runtime does not match the current runtime.'}`);
      continue;
    }

    return { url, ignoredReasons };
  }

  return { url: null, ignoredReasons };
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
  if (stateUrl.url !== null) {
    return validateAppServerUrl(stateUrl.url, 'App Server URL from workspace launcher state').href;
  }

  const ignoredSuffix =
    stateUrl.ignoredReasons.length > 0 ? ` Ignored incompatible workspace launcher state: ${stateUrl.ignoredReasons.join(' ')}` : '';
  throw new Error(
    `No compatible App Server URL is configured. Provide appServerUrl, set CODEX_APP_SERVER_URL, or start/reuse a managed App Server from this runtime.${ignoredSuffix}`,
  );
}
