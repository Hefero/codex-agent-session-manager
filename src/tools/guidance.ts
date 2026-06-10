import { z } from 'zod';

import { packageName, packageVersion } from '../version.js';

export const guidanceTopics = ['overview', 'workflows', 'mcp-handling', 'refresh-proof', 'safety', 'shell-hook', 'global-install'] as const;
export type GuidanceTopic = (typeof guidanceTopics)[number];

export const guidanceInputSchema = {
  topic: z.enum(guidanceTopics).optional().describe('Optional guidance topic. Defaults to overview.'),
};

interface GuidanceResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  text: string;
}

function lines(values: readonly string[]): string {
  return `${values.join('\n')}\n`;
}

const overview = lines([
  '# Codex Agent Session Manager',
  '',
  'Use this MCP server to manage Codex App Server sessions and validate MCP callable-catalog changes from agent workflows.',
  '',
  'Core rules:',
  '- Treat App Server MCP status as diagnostic evidence, not callable proof.',
  '- A changed MCP is proven only after the model-callable catalog can call the target tool from the right continuation, replacement, or fresh-session boundary.',
  '- Prefer `codex_mcp_refresh` after adding or changing MCP config because it schedules reload plus a follow-up turn after the target thread is idle.',
  '- Do not wait on a continuation operation from the same active turn that the continuation targets; finish the turn so the target can become idle.',
  '- Use `codex_thread_context` when the target thread id is unknown or multiple threads are loaded.',
  '',
  'Start here:',
  '1. Call `codex_session_manager_help` with `topic: "workflows"` for the common decision tree.',
  '2. Call `codex_session_manager_help` with `topic: "mcp-handling"` before adding or removing a third-party npm MCP.',
  '3. Call `codex_session_manager_help` with `topic: "safety"` before OAuth, PII, write-capable, or destructive MCPs.',
  '4. Call `codex_session_manager_help` with `topic: "global-install"` before editing user-global Codex config.',
]);

const workflows = lines([
  '# Session Manager Workflows',
  '',
  'Add or change an MCP:',
  '1. Use `codex_local_mcp_add_npm` for project-local npm MCPs when possible. It installs locally, disables lifecycle scripts by default, and writes project-scoped config.',
  '2. Use `codex_global_mcp_add_npm` only when the operator explicitly wants a user-global MCP visible outside this project.',
  '3. Use `codex_mcp_refresh` with an explicit `threadId` to schedule reload plus a continuation turn.',
  '4. In the continuation, call the changed MCP tool from the model-callable catalog. Status-only checks do not prove success.',
  '',
  'Remove a managed npm MCP:',
  '1. Use `codex_mcp_cleanup_report` first when you need to inspect managed local/global MCP cleanup state.',
  '2. Use `codex_local_mcp_remove` for project-local MCP blocks created by `codex_local_mcp_add_npm`.',
  '3. Use `codex_global_mcp_remove` for user-global MCP blocks created by `codex_global_mcp_add_npm`.',
  '4. Set `uninstallPackage:true` only when the npm package/runtime should also be removed.',
  '5. Use `codex_mcp_refresh` with an explicit `threadId`, then validate that the removed namespace is absent from the callable catalog.',
  '',
  'Find the current thread:',
  '- Use `codex_thread_context` with a short non-secret marker when the thread id is unclear.',
  '- Use explicit `threadId` for mutating session operations when multiple threads are loaded.',
  '',
  'Manage sessions:',
  '- Use `codex_session_continue` for a follow-up turn after idle.',
  '- Use `codex_session_close` to close stale remote TUI windows by explicit thread id.',
  '- Use `codex_session_replace` as a harder fallback for a remote TUI tied to an App Server.',
  '- Use `codex_session_hard_relaunch` only as an experimental escape hatch from plain Codex sessions.',
]);

const mcpHandling = lines([
  '# npm MCP Handling',
  '',
  'Project-local path:',
  '- Call `codex_local_mcp_add_npm` instead of raw `npm install` when installing an npm MCP into the current project.',
  '- It uses a workspace-local npm cache, disables lifecycle scripts by default, and writes only project-scoped `.codex/config.toml`.',
  '- Call `codex_local_mcp_remove` to remove a managed project-local MCP block later; set `uninstallPackage:true` only when the npm package should also be removed.',
  '',
  'User-global path:',
  '- Call `codex_global_mcp_add_npm` only after the operator explicitly wants the MCP in user-global Codex config.',
  '- It installs into an isolated runtime under the session-manager global state directory and writes a marked `~/.codex/config.toml` block.',
  '- Call `codex_global_mcp_remove` to remove that managed global block; set `uninstallPackage:true` only when the isolated runtime should also be removed.',
  '',
  'Shared options:',
  '- Use `--env-var` in the CLI or `envVars` in the MCP tool for secret-bearing MCPs. This stores env var names only, never secret values.',
  '- Use `noDefaultStdioArg` only for packages whose entrypoint does not expect the default `stdio` argument.',
  '- Use `allowScripts:true` only after reviewing packages that need lifecycle scripts.',
  '',
  'After add/remove:',
  '1. If new env vars were created after App Server started, restart/relaunch the managed App Server so the MCP process inherits them.',
  '2. Use `codex_mcp_cleanup_report` when you need a read-only summary of managed blocks, package/runtime state, and recent add/remove operations.',
  '3. Run `codex_mcp_refresh` for reload plus continuation.',
  '4. Validate by calling the added MCP tool, or by confirming the removed namespace is absent, from the model-callable catalog.',
  '',
  'Avoid:',
  '- Do not patch files under `node_modules`.',
  '- Do not validate by launching stdio MCP servers directly in a visible terminal; they are long-lived and can leave orphan windows/processes.',
]);

const refreshProof = lines([
  '# MCP Refresh And Callable Proof',
  '',
  'Terminology:',
  '- App Server reload refreshes MCP server processes.',
  '- Callable proof means the current model-callable catalog can actually invoke the new or changed tool.',
  '',
  'Recommended flow:',
  '1. Schedule `codex_mcp_refresh` with explicit `threadId`.',
  '2. End the current turn if the continuation targets this same thread.',
  '3. In the continuation, call the expected MCP tool and inspect the returned payload.',
  '',
  'Common traps:',
  '- Do not treat `codex_mcp_status_list` as final proof.',
  '- Do not call `codex_operation_wait` from the same active turn after scheduling a continuation for that same thread.',
  '- If a rename or schema change remains stale, use a replacement/fresh session as fallback and record evidence.',
]);

const safety = lines([
  '# Safety Guidance',
  '',
  'For OAuth, PII, write-capable, or destructive MCPs:',
  '- Prefer read-only scopes first. Escalate to read/write or delete scopes only after explicit operator approval.',
  '- Keep OAuth client files, tokens, and API keys outside the workspace or under ignored paths such as `.secrets/`.',
  '- Do not print secret values, raw token files, or credential-bearing URLs.',
  '- Prefer project-local config over user-global config.',
  '- Review tool outputs before embedding URLs or acting on external data.',
  '',
  'For process control:',
  '- Use dry-run first for stop, close, replace, hard relaunch, and App Server lifecycle operations.',
  '- Prefer explicit `threadId` over broad workspace/URL matching.',
  '- `codex_app_server_stop` normally stops only workspace-owned App Server state; stopping by explicit App Server URL requires `appServerUrl`, `force:true`, and `confirm:true`.',
  '- Do not stop unknown Codex or MCP processes just because they match a broad name.',
]);

const shellHook = lines([
  '# Shell Hook',
  '',
  '`init --install-shell-hook` is opt-in. It installs a single shell profile hook that delegates plain `codex` only inside initialized projects.',
  '',
  'Behavior:',
  '- Outside initialized projects, `codex` delegates to the real Codex CLI.',
  '- Inside initialized projects, simple `codex` launches route through `codex-agent-session-manager remote`.',
  '- Native Codex commands such as `codex mcp list`, `codex login`, `codex --version`, and `codex --help` still delegate to the real Codex CLI.',
  '- In WSL, pass `--shell-hook-wsl-prefer-linux-path` from `init` or `--wsl-prefer-linux-path` from `shell-hook install` to prefer Linux npm binaries and refuse `/mnt/c` Windows shims for this package.',
  '',
  'Use this when you want plain `codex` to start with a managed App Server without teaching each project-specific agent extra commands.',
]);

const globalInstall = lines([
  '# Global Install',
  '',
  '`codex-agent-session-manager global install` is the stronger operator opt-in. It edits user-global Codex config and/or shell profile only after `--confirm`.',
  '',
  'Behavior:',
  '- Default `global install --confirm` installs both the user-global MCP block and the global shell hook.',
  '- `--mcp-only` installs only the marked `~/.codex/config.toml` MCP block.',
  '- `--shell-hook-only` installs only the marked shell profile hook.',
  '- With the global shell hook, initialized projects use their local supervisor; other directories route plain Codex-shaped launches through `codex-agent-session-manager remote --workspace <cwd>`.',
  '- Native Codex commands such as `codex mcp list`, `codex login`, `codex --version`, and flag-heavy invocations still delegate to the real Codex CLI.',
  '- `global uninstall --confirm` removes only marked blocks created by this package.',
  '- Unmanaged global `codex_agent_session_manager` sections are not overwritten.',
  '',
  'Windows:',
  '- The global MCP block uses a hidden stdio launcher under `~/.codex-agent-session-manager/` to avoid helper console popups.',
  '- The package command must be available on PATH, for example through a global npm install or `npm link`.',
  '',
  'WSL:',
  '- Pass `--shell-hook-wsl-prefer-linux-path` with `global install` when PATH contains Windows npm shims before Linux npm binaries. The hook will prefer Linux locations and refuse `/mnt/c` manager shims instead of failing later with npm shim errors.',
  '',
  'Use project-scoped `init` when you want a self-contained project. Use global install when the operator explicitly wants the session-manager MCP visible across projects.',
]);

export const guidanceResources: GuidanceResource[] = [
  {
    uri: 'codex-session-manager://guide',
    name: 'guide',
    title: 'Codex Session Manager Guide',
    description: 'Operational guide for using codex-agent-session-manager from MCP clients.',
    text: overview,
  },
  {
    uri: 'codex-session-manager://workflows',
    name: 'workflows',
    title: 'Session Manager Workflows',
    description: 'Common workflow decision tree for sessions, reloads, and MCP validation.',
    text: workflows,
  },
  {
    uri: 'codex-session-manager://workflows/mcp-handling',
    name: 'mcp-handling',
    title: 'npm MCP Handling Workflow',
    description: 'Guidance for adding, removing, and validating third-party npm MCP packages safely.',
    text: mcpHandling,
  },
  {
    uri: 'codex-session-manager://safety',
    name: 'safety',
    title: 'Session Manager Safety Guide',
    description: 'Safety guidance for secrets, OAuth, destructive MCPs, and process control.',
    text: safety,
  },
  {
    uri: 'codex-session-manager://global-install',
    name: 'global-install',
    title: 'Global Install Guide',
    description: 'Guidance for the explicit user-global MCP config and shell-hook opt-in.',
    text: globalInstall,
  },
];

const topicText: Record<GuidanceTopic, string> = {
  overview,
  workflows,
  'mcp-handling': mcpHandling,
  'refresh-proof': refreshProof,
  safety,
  'shell-hook': shellHook,
  'global-install': globalInstall,
};

export interface GuidancePayload extends Record<string, unknown> {
  ok: true;
  packageName: string;
  version: string;
  topic: GuidanceTopic;
  guidance: string;
  resources: Array<Pick<GuidanceResource, 'uri' | 'title' | 'description'>>;
}

export function buildGuidancePayload(input: { topic?: GuidanceTopic | undefined }): GuidancePayload {
  const topic = input.topic ?? 'overview';
  return {
    ok: true,
    packageName,
    version: packageVersion,
    topic,
    guidance: topicText[topic],
    resources: guidanceResources.map(({ uri, title, description }) => ({ uri, title, description })),
  };
}
