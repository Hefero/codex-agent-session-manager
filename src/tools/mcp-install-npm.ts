import { z } from 'zod';

import { userError } from '../errors.js';
import { buildGlobalMcpAddNpmPayload, type GlobalMcpNpmRunner, type GlobalPackageInspector } from './global-mcp-npm.js';
import { buildLocalMcpAddNpmPayload, type NpmRunner, type PackageInspector } from './mcp-add-npm.js';

const MAX_PACKAGE_SPEC_CHARS = 200;
const MAX_ENTRYPOINT_CHARS = 300;
const MAX_EXTRA_ARGS = 20;
const MAX_ENV_VARS = 20;

const packageSpecSchema = z
  .string()
  .min(1)
  .max(MAX_PACKAGE_SPEC_CHARS)
  .describe('npm registry package spec for the MCP package to install.');

const serverNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .optional()
  .describe('Codex MCP server name. Defaults to a normalized name inferred from the package.');

const envVarNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .describe('Environment variable name to forward to the MCP stdio server without storing its value in config.');

export const mcpInstallNpmInputSchema = {
  packageSpec: packageSpecSchema,
  scope: z
    .enum(['local', 'global'])
    .optional()
    .describe('Install scope. Defaults to local project config. Use global only after the operator explicitly asks for a user-global MCP.'),
  serverName: serverNameSchema,
  entrypoint: z
    .string()
    .min(1)
    .max(MAX_ENTRYPOINT_CHARS)
    .optional()
    .describe('Package-relative JavaScript entrypoint. Defaults to the first package.json bin target after install.'),
  extraArgs: z
    .array(z.string().max(200))
    .max(MAX_EXTRA_ARGS)
    .optional()
    .describe('Extra args passed after the package entrypoint. Defaults to ["stdio"].'),
  envVars: z
    .array(envVarNameSchema)
    .max(MAX_ENV_VARS)
    .optional()
    .describe('Environment variable names to forward through config env_vars without storing secret values.'),
  allowScripts: z
    .boolean()
    .optional()
    .describe('Defaults false. When false, npm install uses --ignore-scripts so package lifecycle scripts do not run during install.'),
  allowNoEnvVars: z
    .boolean()
    .optional()
    .describe('Defaults false. If package inspection finds credential env vars and envVars is empty, real install is refused unless this explicit opt-out is true.'),
  configPath: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Advanced/testing override for global scope only. Defaults to ~/.codex/config.toml.'),
  stateDir: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Advanced/testing override for global scope only. Defaults to the user-global session-manager state directory.'),
  dryRun: z.boolean().optional().describe('Defaults true. Preview install and config changes without changing files.'),
  confirm: z.boolean().optional().describe('Required true when dryRun is false.'),
};

const mcpInstallNpmInputObject = z.object(mcpInstallNpmInputSchema);
type McpInstallNpmInput = z.infer<typeof mcpInstallNpmInputObject>;

type SharedInput = {
  packageSpec: string;
  serverName?: string;
  entrypoint?: string;
  extraArgs?: string[];
  envVars?: string[];
  allowScripts?: boolean;
  allowNoEnvVars?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
};

function addOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function sharedInput(parsed: McpInstallNpmInput): SharedInput {
  const input: Record<string, unknown> = { packageSpec: parsed.packageSpec };
  addOptional(input, 'serverName', parsed.serverName);
  addOptional(input, 'entrypoint', parsed.entrypoint);
  addOptional(input, 'extraArgs', parsed.extraArgs);
  addOptional(input, 'envVars', parsed.envVars);
  addOptional(input, 'allowScripts', parsed.allowScripts);
  addOptional(input, 'allowNoEnvVars', parsed.allowNoEnvVars);
  addOptional(input, 'dryRun', parsed.dryRun);
  addOptional(input, 'confirm', parsed.confirm);
  return input as SharedInput;
}

function assertNoLocalGlobalOverrides(parsed: McpInstallNpmInput): void {
  if (parsed.configPath !== undefined || parsed.stateDir !== undefined) {
    throw userError({
      code: 'global_options_require_global_scope',
      message: 'configPath/stateDir are only valid with scope:"global".',
      parameter: parsed.configPath !== undefined ? 'configPath' : 'stateDir',
      expected: 'Use scope:"global", or remove configPath/stateDir for project-local install.',
      examples: ['codex_mcp_install_npm with { "packageSpec": "example-mcp", "scope": "global", "configPath": "..." }'],
      nextAction: 'Remove the global-only path override or explicitly select global scope.',
    });
  }
}

export function buildMcpInstallNpmPayload(input: McpInstallNpmInput, deps: {
  localNpmRunner?: NpmRunner;
  globalNpmRunner?: GlobalMcpNpmRunner;
  packageInspector?: PackageInspector & GlobalPackageInspector;
  prepareWindowsHiddenLauncher?: (directory: string, dryRun: boolean) => string | null;
} = {}): Record<string, unknown> {
  const parsed = mcpInstallNpmInputObject.parse(input);
  const scope = parsed.scope ?? 'local';
  const base = sharedInput(parsed);

  if (scope === 'local') {
    assertNoLocalGlobalOverrides(parsed);
    const payload = buildLocalMcpAddNpmPayload(base, {
      ...(deps.localNpmRunner !== undefined ? { npmRunner: deps.localNpmRunner } : {}),
      ...(deps.packageInspector !== undefined ? { packageInspector: deps.packageInspector } : {}),
    });
    return {
      ...payload,
      installTool: 'codex_mcp_install_npm',
      scope: 'local',
      nextAction: `${String(payload.nextAction ?? '')} Preferred entrypoint for future npm MCP installs is codex_mcp_install_npm; avoid raw npm install, raw codex mcp add, and manual config edits for managed MCP setup.`.trim(),
    };
  }

  const globalInput: Record<string, unknown> = { ...base };
  addOptional(globalInput, 'configPath', parsed.configPath);
  addOptional(globalInput, 'stateDir', parsed.stateDir);
  const payload = buildGlobalMcpAddNpmPayload(globalInput as Parameters<typeof buildGlobalMcpAddNpmPayload>[0], {
    ...(deps.globalNpmRunner !== undefined ? { npmRunner: deps.globalNpmRunner } : {}),
    ...(deps.packageInspector !== undefined ? { packageInspector: deps.packageInspector } : {}),
    ...(deps.prepareWindowsHiddenLauncher !== undefined ? { prepareWindowsHiddenLauncher: deps.prepareWindowsHiddenLauncher } : {}),
  });
  return {
    ...payload,
    installTool: 'codex_mcp_install_npm',
    scope: 'global',
    nextAction: `${String(payload.nextAction ?? '')} Preferred entrypoint for future npm MCP installs is codex_mcp_install_npm; avoid raw npm install, raw codex mcp add, and manual config edits for managed MCP setup.`.trim(),
  };
}
