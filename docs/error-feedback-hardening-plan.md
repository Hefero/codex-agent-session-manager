# Error Feedback Hardening Plan

## Design Plan

The error surface is a shared product contract for humans and agents. Failures
should identify what happened, which parameter or command failed, what shape was
expected, safe examples, and the next action. Error payloads must not expose
secrets, raw prompts, credentials, or local user paths.

The layers are not conflicting:

- CLI parsing should produce human-readable errors with examples and corrective
  commands.
- MCP tools should return `ok:false` structured payloads for expected validation
  and workflow failures instead of surfacing opaque handler exceptions.
- Shared security validators should keep rejecting unsafe URLs and workspace
  escapes, while adding examples that point to safe loopback URLs and
  workspace-relative paths.
- Cleanup and MCP lifecycle tools should include discovery-oriented next
  actions, especially when a server name is wrong or a managed block is absent.

## Implementation Plan

- [x] Add a common `UserFacingError` contract with redacted structured payloads.
- [x] Wrap MCP tool handlers so runtime validation failures become `ok:false`
  `structuredContent` with a clear `error` object.
- [x] Improve public CLI parser errors for missing values, unknown flags,
  wrong subcommands, prompt conflicts, and MCP package/server arguments.
- [x] Improve shared URL and workspace validation messages with safe examples.
- [x] Improve MCP add/remove warnings and next actions for package-spec and
  cleanup traps.
- [x] Add focused tests for formatting, redaction, MCP wrapper behavior, and
  important CLI traps.
- [x] Run the standard fast validation set and update this checklist.

Validation run:

- `npm run check`
- `npm test`
- `npm run smoke`
- `npm run build`
- `git diff --check` returned only existing LF/CRLF warnings, with no
  whitespace errors.
