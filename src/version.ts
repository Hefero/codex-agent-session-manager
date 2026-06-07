import { readFileSync } from 'node:fs';

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

function readPackageMetadata(): PackageMetadata {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata;
  } catch {
    return {};
  }
}

const metadata = readPackageMetadata();

export const packageName = typeof metadata.name === 'string' ? metadata.name : 'codex-agent-session-manager';
export const packageVersion = typeof metadata.version === 'string' ? metadata.version : '0.0.0';
