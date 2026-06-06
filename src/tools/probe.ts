import { z } from 'zod';

import { packageName, packageVersion } from '../version.js';

export const probeInputSchema = {
  echo: z.string().optional().describe('Optional non-secret value to echo.'),
};

export interface ProbePayload extends Record<string, unknown> {
  ok: true;
  packageName: string;
  version: string;
  echo: string | null;
  marker: string;
}

export function buildProbePayload(input: { echo?: string | undefined }): ProbePayload {
  return {
    ok: true,
    packageName,
    version: packageVersion,
    echo: input.echo ?? null,
    marker: 'codex-agent-session-manager:probe:v1',
  };
}
