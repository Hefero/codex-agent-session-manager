# Alpha 3 Hardening Review

Date: 2026-06-07

This review focuses on public-alpha hardening after the first npm release. The
goal is not to remove all sharp edges, but to make project-scoped filesystem
operations and agent-triggered package installation match the safety contract
advertised by the tool.

## Fixed Findings

### H-001: Workspace filesystem boundary was not centralized

Status: fixed in working tree for alpha.3.

Affected surfaces:

- `init`
- `deinit`
- App Server launcher state
- durable operation state
- remote App Server logs
- Windows hidden launcher runtime files
- `mcp add npm` package/config writes

Before this pass, most managed paths were constructed under `workspace` with
`join`/`resolve`, but not all callers checked the real path of existing
ancestors. A workspace-local symlink or Windows junction such as
`.codex -> <outside>` could cause reads/writes/deletes to escape the selected
workspace.

The fix adds `resolveWorkspaceRoot`, `workspacePath`, and
`assertWorkspacePath`. Managed paths now must:

- be lexical children of the selected workspace;
- have their deepest existing ancestor resolve inside the workspace realpath;
- reject symlink/junction escapes before managed writes/deletes/state/log
  operations.

Tests now cover normal managed child paths, lexical escapes, symlink/junction
escapes, `init`, `deinit`, and `mcp add npm` `node_modules` escape handling.

### H-002: `mcp add npm` installed packages by default

Status: fixed in working tree for alpha.3.

Before this pass, `codex_mcp_add_npm` and the CLI `mcp add npm` path installed
the requested package and wrote project config unless `dryRun:true` was passed.
For an agent-facing tool, that made real package installation too easy to do
accidentally.

The fix aligns this tool with other guarded operations:

- default is `dryRun:true`;
- real execution requires `dryRun:false` plus `confirm:true`;
- CLI real execution uses `--confirm`;
- refusal happens before writing files or running npm;
- docs and generated AGENTS guidance now show dry-run and confirm flows.

### H-003: npm package spec parser accepted path-like version suffixes

Status: fixed in working tree for alpha.3.

The registry package-name parser rejected `file:`, URL, whitespace, colon, and
backslash inputs, but it extracted the package name without validating the
version suffix. Inputs like `left-pad@../outside` could pass the local
registry-name check even though they are not intended registry specs.

The fix validates optional version/tag suffixes with a conservative character
allowlist suitable for common versions and dist-tags, while rejecting path-like
suffixes containing `/`.

## Accepted / Deferred Risks

### D-001: npm lifecycle scripts still run after explicit confirmation

`mcp add npm --confirm` uses standard `npm install --save-dev`. That can run
npm lifecycle scripts from the selected package. This is acceptable for the
current alpha because the operation now requires explicit confirmation and MCP
servers are executable code anyway.

Possible future hardening:

- add `ignoreScripts:true` / `--ignore-scripts` default;
- add an `allowScripts:true` opt-in for packages that need install scripts;
- report when the package has lifecycle scripts after install.

### D-002: CLI `--prompt-file` reads an operator-selected local file

The public CLI supports `--prompt-file` for launch/replace/refresh prompts.
This is an explicit operator path, not exposed as an MCP file-read tool. It is
kept as-is for now.

Possible future hardening:

- document that prompt files are operator text and should not contain secrets;
- optionally restrict prompt files to the workspace for CLI commands that run
  in project context.

### D-003: custom `OperationStore({ stateFile })` is intentionally unbounded

The default operation store path is workspace-bounded. A custom `stateFile`
option remains unbounded for tests and internal diagnostics. It is not exposed
as a public MCP input.

## Validation

Current working-tree validation:

- `npm run check`
- `npm test`

Full alpha.3 release validation should also run:

- `npm run smoke`
- `npm run security:smoke`
- `npm run security:scan`
- `npm run audit:prod`
- `npm run pack:dry-run`
- `npm run pack:smoke`
- `npm publish --dry-run --tag alpha`
