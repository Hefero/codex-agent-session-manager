const SENSITIVE_OPTION_NAMES = new Set([
  '--access-token',
  '--api-key',
  '--api_key',
  '--apikey',
  '--aws-secret-access-key',
  '--auth-token',
  '--authorization',
  '--client-secret',
  '--continue-prompt',
  '--marker',
  '--password',
  '--prompt',
  '--refresh-token',
  '--search-term',
  '--secret',
  '--token',
]);

const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|password|passwd|prompt|pwd|refresh[_-]?token|secret|secret[_-]?access[_-]?key|token)/iu;

function isSensitiveOptionName(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (!lowerName.startsWith('--')) return false;
  return SENSITIVE_OPTION_NAMES.has(lowerName) || SENSITIVE_KEY_PATTERN.test(lowerName.slice(2));
}

function redactUrl(raw: string): string {
  let candidate = raw;
  let trailing = '';
  while (candidate.length > 0 && /[.,;:!?()[\]{}<>]/u.test(candidate.at(-1) ?? '')) {
    trailing = `${candidate.at(-1)}${trailing}`;
    candidate = candidate.slice(0, -1);
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.username) parsed.username = '<redacted>';
    if (parsed.password) parsed.password = '<redacted>';
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, SENSITIVE_KEY_PATTERN.test(key) ? '<redacted>' : '<value>');
    }
    const serialized = parsed.toString();
    const rawHadPath = /^(?:wss?|https?):\/\/[^/\s?#]+[/?#]/iu.test(candidate);
    const redacted = !rawHadPath && serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
    return `${redacted}${trailing}`;
  } catch {
    return raw;
  }
}

export function redactSensitiveText(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 <redacted>')
    .replace(/\b(Authorization\s*[:=]\s*)[^\s"']+/giu, '$1<redacted>')
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY_ID|ACCESS_TOKEN|SECRET_ACCESS_KEY)\s*=\s*)[^\s"']+/gu,
      '$1<redacted>',
    )
    .replace(
      /\b((?:api[_-]?key|auth[_-]?token|client[_-]?secret|password|refresh[_-]?token|secret|token)\s*[:=]\s*)[^\s"']+/giu,
      '$1<redacted>',
    )
    .replace(
      /(--[A-Za-z0-9][A-Za-z0-9_-]*(?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|password|passwd|prompt|pwd|refresh[_-]?token|secret|secret[_-]?access[_-]?key|token)[A-Za-z0-9_-]*)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/giu,
      '$1$2<redacted>',
    )
    .replace(/\b(?:wss?|https?):\/\/[^\s"']+/giu, (match) => redactUrl(match))
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/gu, '<path:redacted>')
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/gu, '<path:redacted>');
}

export function redactArgv(
  args: readonly string[],
  options: {
    workspace?: string;
    workspaceLabel?: string;
    scriptRoot?: string;
    scriptRootLabel?: string;
  } = {},
): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      result.push('<redacted>');
      redactNext = false;
      continue;
    }

    const [rawName, inlineValue] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg];
    const name = rawName ?? arg;
    if (isSensitiveOptionName(name)) {
      if (inlineValue !== undefined) {
        result.push(`${name}=<redacted>`);
      } else {
        result.push(arg);
        redactNext = true;
      }
      continue;
    }

    let redacted = arg;
    if (options.workspace) {
      redacted = redacted.replaceAll(options.workspace, options.workspaceLabel ?? '<workspace>');
    }
    if (options.scriptRoot) {
      redacted = redacted.replaceAll(options.scriptRoot, options.scriptRootLabel ?? '<scripts>');
    }
    result.push(redactSensitiveText(redacted));
  }
  return result;
}

export function redactValue(
  value: unknown,
  options: {
    workspace?: string;
    workspaceLabel?: string;
    scriptRoot?: string;
    scriptRootLabel?: string;
  } = {},
): unknown {
  if (typeof value === 'string') {
    let text = value;
    if (options.workspace) {
      text = text.replaceAll(options.workspace, options.workspaceLabel ?? '<workspace>');
    }
    if (options.scriptRoot) {
      text = text.replaceAll(options.scriptRoot, options.scriptRootLabel ?? '<scripts>');
    }
    return redactSensitiveText(text);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, options));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '<redacted>' : redactValue(entry, options),
      ]),
    );
  }
  return value;
}

function publicTurnStartError(error: unknown, options: Parameters<typeof redactValue>[1] = {}): unknown {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return '<redacted:turn-start-error>';
  }

  const record = error as Record<string, unknown>;
  const safe: Record<string, unknown> = { redacted: true };
  for (const key of ['code', 'type', 'status', 'param', 'name']) {
    const value = record[key];
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      safe[key] = redactValue(value, options);
    }
  }
  if (typeof record.message === 'string') {
    safe.message = '<redacted:turn-start-error-message>';
  }
  return safe;
}

export function redactJsonRpcError(method: string, error: unknown, options: Parameters<typeof redactValue>[1] = {}): unknown {
  if (method === 'turn/start') {
    return publicTurnStartError(error, options);
  }
  return redactValue(error, options);
}
