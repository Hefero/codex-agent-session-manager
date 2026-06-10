#!/usr/bin/env node
import { startStdioServer } from './mcp-server.js';
import { deinitUsage, runDeinitCommand } from './deinit.js';
import { formatCliError, userError } from './errors.js';
import { globalUsage, runGlobalCommand } from './global-config.js';
import { initUsage, runInitCommand } from './init.js';
import { publicCliUsage, runPublicCommand } from './public-cli.js';
import { remoteUsage, runRemoteCommand } from './remote.js';
import { runSecretCommand, secretUsage } from './secret-cli.js';
import { shellHookUsage, runShellHookCommand } from './shell-hook.js';
import { runAppServerStopOperationFromArgv } from './tools/app-server-lifecycle.js';
import { runAppServerStartOperationFromArgv } from './tools/app-server-start.js';
import { runMcpRefreshOperationFromArgv } from './tools/mcp-refresh.js';
import { runMcpReloadOperationFromArgv } from './tools/reload.js';
import { runSessionCloseOperationFromArgv } from './tools/session-close.js';
import { runSessionContinueOperationFromArgv } from './tools/session-continue.js';
import { runSessionHardRelaunchOperationFromArgv } from './tools/session-hard-relaunch.js';
import { runSessionLaunchOperationFromArgv } from './tools/session-launch.js';
import { runSessionReplaceOperationFromArgv } from './tools/session-replace.js';
import { packageName, packageVersion } from './version.js';

function printHelp(): void {
  process.stdout.write(`${packageName} ${packageVersion}

Usage:
  codex-agent-session-manager serve
  codex-agent-session-manager init [options]
  codex-agent-session-manager deinit [options]
  codex-agent-session-manager global <install|uninstall|status> [options]
  codex-agent-session-manager secret <set|list|status|unset> [options]
  codex-agent-session-manager remote [options]
  codex-agent-session-manager stop [options]
  codex-agent-session-manager app-server <start|status|stop> [options]
  codex-agent-session-manager mcp <local|global|refresh> [options]
  codex-agent-session-manager operation <read|wait> [options]
  codex-agent-session-manager session <launch|close|replace> [options]
  codex-agent-session-manager shell-hook <install|uninstall|status> [options]
  codex-agent-session-manager --version
  codex-agent-session-manager --help

Commands:
  serve       Start the MCP stdio server.
  init        Initialize a project-scoped Codex session manager setup.
  deinit      Remove the project-scoped session manager scaffold.
  global      Opt-in user-global MCP config and codex shell hook management.
  secret      Store API keys/tokens by env var name without command-line values.
  remote      Start/reuse a workspace App Server and launch Codex remote.
  stop        Alias for app-server stop.
  app-server  Manage the workspace-owned App Server lifecycle.
  mcp         Add/remove local or global npm MCP servers, reload MCPs, and start continuation turns.
  operation   Read or wait for durable session-manager operations.
  session     Launch, close, or replace Codex remote TUI sessions.
  shell-hook  Install an opt-in codex function hook for PowerShell, bash, or zsh.

${publicCliUsage()}
${initUsage()}
${deinitUsage()}
${globalUsage()}
${secretUsage()}
${shellHookUsage()}
`);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'serve';

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  if (command === 'serve' || (command === 'mcp' && argv.length === 1)) {
    await startStdioServer();
    return;
  }

  if (command === 'remote') {
    process.exitCode = await runRemoteCommand(argv.slice(1));
    return;
  }

  if (command === 'init') {
    process.exitCode = await runInitCommand(argv.slice(1));
    return;
  }

  if (command === 'deinit') {
    process.exitCode = await runDeinitCommand(argv.slice(1));
    return;
  }

  if (command === 'global') {
    process.exitCode = await runGlobalCommand(argv.slice(1));
    return;
  }

  if (command === 'secret') {
    process.exitCode = await runSecretCommand(argv.slice(1));
    return;
  }

  if (command === 'shell-hook') {
    process.exitCode = await runShellHookCommand(argv.slice(1));
    return;
  }

  if (command === 'remote-help') {
    process.stdout.write(remoteUsage());
    return;
  }

  if (command === 'stop' || command === 'app-server' || command === 'mcp' || command === 'operation' || command === 'session') {
    process.exitCode = await runPublicCommand(argv);
    return;
  }

  if (command === 'run-mcp-reload-operation') {
    await runMcpReloadOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-mcp-refresh-operation') {
    await runMcpRefreshOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-app-server-start-operation') {
    await runAppServerStartOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-app-server-stop-operation') {
    await runAppServerStopOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-session-continue-operation') {
    await runSessionContinueOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-session-close-operation') {
    await runSessionCloseOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-session-launch-operation') {
    await runSessionLaunchOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-session-hard-relaunch-operation') {
    await runSessionHardRelaunchOperationFromArgv(argv.slice(1));
    return;
  }

  if (command === 'run-session-replace-operation') {
    await runSessionReplaceOperationFromArgv(argv.slice(1));
    return;
  }

  process.stderr.write(`${formatCliError(userError({
    code: 'unknown_command',
    message: `Unknown command: ${command}`,
    command,
    parameter: 'command',
    received: command,
    expected: 'One of: serve, init, deinit, global, secret, remote, stop, app-server, mcp, operation, session, shell-hook, --help, --version.',
    examples: ['codex-agent-session-manager --help'],
    nextAction: 'Choose a supported command or run --help.',
  }))}\n`);
  printHelp();
  process.exitCode = 2;
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 2;
});
