import { z } from 'zod';

import { runNpm, type NpmRunResult } from '../npm.js';
import { redactSensitiveText } from '../security/redaction.js';

const MAX_PACKAGE_SPEC_CHARS = 200;
const MAX_README_CHARS = 160_000;
const MAX_SNIPPETS_PER_ENV = 3;
const MAX_AUTH_HINTS = 12;

const FALSE_POSITIVE_ENV_NAMES = new Set([
  'APPDATA',
  'CI',
  'DEBUG',
  'HOME',
  'HOST',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOG_LEVEL',
  'NODE_ENV',
  'NO_PROXY',
  'PATH',
  'PORT',
  'PWD',
  'TEMP',
  'TMP',
  'USER',
  'USERNAME',
]);

const envVarPattern = /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_ID|CLIENT_SECRET|CREDENTIALS|PASSWORD|SECRET|TOKEN)\b/gu;
const authPhrasePattern = /\b(?:api\s*key|access\s*token|auth(?:entication|orization)?|bearer\s+token|client\s+secret|credentials?|oauth|secret\s+key|token)\b/giu;

export const npmPackageInspectInputSchema = {
  packageSpec: z
    .string()
    .min(1)
    .max(MAX_PACKAGE_SPEC_CHARS)
    .refine((value) => parseRegistryPackageName(value) !== null, {
      message: 'Only npm registry package specs are supported, for example @scope/name or name@version.',
    })
    .describe('npm registry package spec to inspect before installing an MCP package.'),
};

const npmPackageInspectInputObject = z.object(npmPackageInspectInputSchema);
type NpmPackageInspectInput = z.infer<typeof npmPackageInspectInputObject>;

export type NpmViewRunner = (args: readonly string[], options: { cwd: string }) => NpmRunResult;

export interface EnvVarCandidate {
  name: string;
  confidence: 'high' | 'medium';
  evidence: string[];
}

export interface PackageInspectionSummary {
  ok: boolean;
  packageSpec: string;
  packageName: string | null;
  version: string | null;
  requiresSecretsLikely: boolean;
  candidateEnvVars: EnvVarCandidate[];
  authHints: string[];
  warning?: string;
  nextAction: string;
}

function validPackageVersionPart(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9._+~^*-]+$/u.test(value);
}

export function parseRegistryPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed !== spec || trimmed.length === 0 || /[\s:\\]/u.test(trimmed)) return null;

  if (trimmed.startsWith('@')) {
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex < 0) return null;
    const versionIndex = trimmed.indexOf('@', slashIndex + 1);
    const name = versionIndex >= 0 ? trimmed.slice(0, versionIndex) : trimmed;
    const versionPart = versionIndex >= 0 ? trimmed.slice(versionIndex + 1) : null;
    if (versionPart !== null && !validPackageVersionPart(versionPart)) return null;
    return /^@[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(name) ? name : null;
  }

  const versionIndex = trimmed.indexOf('@');
  const name = versionIndex >= 0 ? trimmed.slice(0, versionIndex) : trimmed;
  const versionPart = versionIndex >= 0 ? trimmed.slice(versionIndex + 1) : null;
  if (versionPart !== null && !validPackageVersionPart(versionPart)) return null;
  return /^[a-z0-9._-]+$/u.test(name) ? name : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function arrayTextField(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').join(' ') : '';
}

function repositoryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return [value.type, value.url, value.directory].filter((entry): entry is string => typeof entry === 'string').join(' ');
}

function binText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .flatMap(([name, target]) => [name, target])
    .join(' ');
}

function normalizedSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 90);
  const end = Math.min(text.length, index + length + 90);
  return redactSensitiveText(text.slice(start, end).replace(/\s+/gu, ' ').trim());
}

function pushUnique(values: string[], value: string, max: number): void {
  if (values.length >= max) return;
  if (!values.includes(value)) values.push(value);
}

function collectAuthHints(text: string): string[] {
  const hints: string[] = [];
  for (const match of text.matchAll(authPhrasePattern)) {
    pushUnique(hints, normalizedSnippet(text, match.index ?? 0, match[0].length), MAX_AUTH_HINTS);
  }
  return hints;
}

function collectEnvCandidates(text: string, authHints: readonly string[]): EnvVarCandidate[] {
  const snippetsByName = new Map<string, string[]>();
  for (const match of text.matchAll(envVarPattern)) {
    const name = match[0];
    if (FALSE_POSITIVE_ENV_NAMES.has(name)) continue;
    const snippets = snippetsByName.get(name) ?? [];
    pushUnique(snippets, normalizedSnippet(text, match.index ?? 0, name.length), MAX_SNIPPETS_PER_ENV);
    snippetsByName.set(name, snippets);
  }

  return [...snippetsByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, evidence]) => ({
      name,
      confidence: evidence.length > 0 || authHints.length > 0 ? 'high' : 'medium',
      evidence,
    }));
}

function summarizeInspection(input: {
  packageSpec: string;
  metadata: Record<string, unknown>;
}): PackageInspectionSummary {
  const readme = textField(input.metadata.readme).slice(0, MAX_README_CHARS);
  const searchableText = [
    textField(input.metadata.name),
    textField(input.metadata.version),
    textField(input.metadata.description),
    arrayTextField(input.metadata.keywords),
    textField(input.metadata.homepage),
    repositoryText(input.metadata.repository),
    binText(input.metadata.bin),
    readme,
  ].join('\n');
  const authHints = collectAuthHints(searchableText);
  const candidateEnvVars = collectEnvCandidates(searchableText, authHints);
  const requiresSecretsLikely = candidateEnvVars.length > 0 || authHints.length > 0;
  const envNames = candidateEnvVars.map((entry) => entry.name);
  const nextAction = candidateEnvVars.length > 0
    ? `Ask the operator to run ${envNames.map((name) => `codex-agent-session-manager secret set ${name}`).join('; ')} outside chat, then install with envVars:[${envNames.map((name) => `"${name}"`).join(', ')}].`
    : requiresSecretsLikely
      ? 'This package appears to mention auth/credentials but no env var name was extracted. Inspect the README/repository, ask the operator which credential names are required, then install with envVars. Do not validate in keyless/fallback mode.'
      : 'No obvious auth/env-var requirement was detected from npm metadata. Continue with a dry-run install, but still inspect package docs if the MCP fails or asks for credentials.';

  return {
    ok: true,
    packageSpec: input.packageSpec,
    packageName: textField(input.metadata.name) || parseRegistryPackageName(input.packageSpec),
    version: textField(input.metadata.version) || null,
    requiresSecretsLikely,
    candidateEnvVars,
    authHints,
    nextAction,
  };
}

export function inspectNpmMetadataForMcpPackage(input: {
  packageSpec: string;
  metadata: Record<string, unknown>;
}): PackageInspectionSummary {
  return summarizeInspection(input);
}

export function emptyPackageInspection(packageSpec: string): PackageInspectionSummary {
  return {
    ok: true,
    packageSpec,
    packageName: parseRegistryPackageName(packageSpec),
    version: null,
    requiresSecretsLikely: false,
    candidateEnvVars: [],
    authHints: [],
    nextAction: 'Package inspection was not run. Continue only if the package docs were inspected elsewhere.',
  };
}

export function inspectNpmPackageForMcp(input: NpmPackageInspectInput, deps: {
  npmRunner?: NpmViewRunner;
  cwd?: string;
} = {}): PackageInspectionSummary {
  const parsed = npmPackageInspectInputObject.parse(input);
  const packageName = parseRegistryPackageName(parsed.packageSpec);
  if (packageName === null) throw new Error(`Unsupported npm package spec: ${parsed.packageSpec}`);
  const runner = deps.npmRunner ?? runNpm;
  const result = runner([
    'view',
    parsed.packageSpec,
    'name',
    'version',
    'description',
    'keywords',
    'readme',
    'homepage',
    'repository',
    'bin',
    '--json',
  ], { cwd: deps.cwd ?? process.cwd() });
  if (result.error !== undefined || result.status !== 0) {
    const reason = (result.error?.message ?? result.stderr.trim()) || 'unknown error';
    return {
      ok: false,
      packageSpec: parsed.packageSpec,
      packageName,
      version: null,
      requiresSecretsLikely: false,
      candidateEnvVars: [],
      authHints: [],
      warning: `npm view failed for ${parsed.packageSpec}: ${redactSensitiveText(reason)}`,
      nextAction: 'Inspect the package README/repository manually before installing. If it requires credentials, use codex-agent-session-manager secret set <NAME> and install with envVars.',
    };
  }

  try {
    const metadata = JSON.parse(result.stdout) as unknown;
    return summarizeInspection({
      packageSpec: parsed.packageSpec,
      metadata: isRecord(metadata) ? metadata : {},
    });
  } catch (error) {
    return {
      ok: false,
      packageSpec: parsed.packageSpec,
      packageName,
      version: null,
      requiresSecretsLikely: false,
      candidateEnvVars: [],
      authHints: [],
      warning: `npm view returned invalid JSON for ${parsed.packageSpec}: ${error instanceof Error ? error.message : String(error)}`,
      nextAction: 'Inspect the package README/repository manually before installing. If it requires credentials, use codex-agent-session-manager secret set <NAME> and install with envVars.',
    };
  }
}

export function buildNpmPackageInspectPayload(input: NpmPackageInspectInput, deps: {
  npmRunner?: NpmViewRunner;
  cwd?: string;
} = {}): Record<string, unknown> {
  return { ...inspectNpmPackageForMcp(input, deps) };
}
