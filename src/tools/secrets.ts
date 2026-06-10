import { z } from 'zod';

import { secretStatus } from '../secrets.js';

const secretNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .describe('Environment variable name to check. Secret values are never returned.');

export const secretStatusInputSchema = {
  names: z.array(secretNameSchema).max(50).optional().describe('Optional env var names to check. When omitted, reports stored names only.'),
  scope: z.enum(['user', 'workspace', 'all']).optional().describe('Secret scope to inspect. Defaults to all.'),
};

type SecretStatusInput = {
  names?: string[] | undefined;
  scope?: 'user' | 'workspace' | 'all' | undefined;
};

export function buildSecretStatusPayload(input: SecretStatusInput = {}): Record<string, unknown> {
  const scope = input.scope ?? 'all';
  const scopes = scope === 'all' ? ['user', 'workspace'] as const : [scope] as const;
  const stores = scopes.map((item) => secretStatus(input.names, { scope: item }));

  return {
    ok: true,
    scope,
    stores: stores.map((store) => ({
      scope: store.scope,
      path: store.path,
      entries: store.entries,
    })),
    warning: 'Secret values are never returned. Use codex-agent-session-manager secret set <NAME> from a terminal to save a missing value.',
    nextAction: 'If a required env var is missing, ask the operator to run codex-agent-session-manager secret set <NAME>, then use session-manager refresh, continuation, replacement, or lifecycle tools yourself before validating MCPs. Do not ask the operator to restart Codex manually.',
  };
}
