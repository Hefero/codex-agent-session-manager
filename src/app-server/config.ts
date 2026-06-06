import { validateAppServerUrl } from '../security/url.js';

export function resolveAppServerUrl(inputUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (inputUrl !== undefined) {
    return validateAppServerUrl(inputUrl, 'App Server URL from tool input').href;
  }

  const envUrl = env.CODEX_APP_SERVER_URL;
  if (envUrl !== undefined) {
    return validateAppServerUrl(envUrl, 'App Server URL from CODEX_APP_SERVER_URL').href;
  }

  throw new Error('No App Server URL is configured. Provide appServerUrl or set CODEX_APP_SERVER_URL.');
}
