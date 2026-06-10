import { secretStatus } from '../secrets.js';

type EnvVarSource = 'environment' | 'user-store' | 'workspace-store';

export interface EnvVarStatusEntry {
  name: string;
  available: boolean;
  sources: EnvVarSource[];
  recommendedSetCommand: string;
}

export interface EnvVarStatusReport {
  allAvailable: boolean;
  missing: string[];
  entries: EnvVarStatusEntry[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hasEnvironmentSource(source: string): boolean {
  return source === 'environment' || source === 'both';
}

function hasStoreSource(source: string): boolean {
  return source === 'store' || source === 'both';
}

export function buildEnvVarStatusReport(input: {
  names: readonly string[];
  workspace?: string | undefined;
  includeWorkspaceStore: boolean;
  recommendedScope?: 'user' | 'workspace' | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): EnvVarStatusReport {
  const names = uniqueSorted(input.names);
  if (names.length === 0) {
    return {
      allAvailable: true,
      missing: [],
      entries: [],
    };
  }

  const env = input.env ?? process.env;
  const user = secretStatus(names, { scope: 'user' }, env).entries;
  const workspace = input.includeWorkspaceStore
    ? secretStatus(names, input.workspace === undefined
      ? { scope: 'workspace' }
      : { scope: 'workspace', workspace: input.workspace }, env).entries
    : [];
  const scopeFlag = input.recommendedScope === 'workspace' ? ' --scope workspace' : '';

  const entries = names.map((name) => {
    const userEntry = user.find((entry) => entry.name === name);
    const workspaceEntry = workspace.find((entry) => entry.name === name);
    const sources: EnvVarSource[] = [];

    if (hasEnvironmentSource(userEntry?.source ?? 'missing') || hasEnvironmentSource(workspaceEntry?.source ?? 'missing')) {
      sources.push('environment');
    }
    if (hasStoreSource(userEntry?.source ?? 'missing')) {
      sources.push('user-store');
    }
    if (hasStoreSource(workspaceEntry?.source ?? 'missing')) {
      sources.push('workspace-store');
    }

    return {
      name,
      available: sources.length > 0,
      sources,
      recommendedSetCommand: `codex-agent-session-manager secret set ${name}${scopeFlag}`,
    };
  });

  const missing = entries.filter((entry) => !entry.available).map((entry) => entry.name);
  return {
    allAvailable: missing.length === 0,
    missing,
    entries,
  };
}

export function envVarWarnings(report: EnvVarStatusReport): string[] {
  if (report.entries.length === 0) return [];
  if (report.allAvailable) {
    return ['Configured env_vars are available from the current environment or codex-agent-session-manager secret store. Secret values were not inspected or returned.'];
  }
  return [
    `Missing configured env_vars: ${report.missing.join(', ')}. Do not report the MCP as fully validated until these names are available to the managed App Server process.`,
    ...report.entries
      .filter((entry) => !entry.available)
      .map((entry) => `Ask the operator to run "${entry.recommendedSetCommand}" outside chat, then use session-manager refresh, continuation, replacement, or lifecycle tools yourself before MCP validation. Do not ask the operator to restart Codex manually.`),
  ];
}

export function envVarNextAction(report: EnvVarStatusReport): string {
  if (report.entries.length === 0 || report.allAvailable) return '';
  const commands = report.entries
    .filter((entry) => !entry.available)
    .map((entry) => entry.recommendedSetCommand)
    .join('; ');
  return `Configured env vars are missing: ${report.missing.join(', ')}. Ask the operator to run ${commands} outside chat, then use session-manager refresh, continuation, replacement, or lifecycle tools yourself before refreshing or validating the MCP. Do not ask the operator to restart Codex manually. Do not treat keyless or fallback behavior as proof that the configured secret-bearing MCP is ready.`;
}
