#!/usr/bin/env node
import { startStdioServer } from './mcp-server.js';
import { deinitUsage, runDeinitCommand } from './deinit.js';
import { initUsage, runInitCommand } from './init.js';
import { publicCliUsage, runPublicCommand } from './public-cli.js';
import { remoteUsage, runRemoteCommand } from './remote.js';
import { runAppServerStopOperationFromArgv } from './tools/app-server-lifecycle.js';
import { runAppServerStartOperationFromArgv } from './tools/app-server-start.js';
import { runMcpRefreshOperationFromArgv } from './tools/mcp-refresh.js';
import { runMcpReloadOperationFromArgv } from './tools/reload.js';
import { runSessionCloseOperationFromArgv } from './tools/session-close.js';
import { runSessionContinueOperationFromArgv } from './tools/session-continue.js';
import { runSessionLaunchOperationFromArgv } from './tools/session-launch.js';
import { runSessionReplaceOperationFromArgv } from './tools/session-replace.js';
import { packageName, packageVersion } from './version.js';

function printHelp(): void {
  process.stdout.write(`${packageName} ${packageVersion}

Usage:
  codex-agent-session-manager serve
  codex-agent-session-manager init [options]
  codex-agent-session-manager deinit [options]
  codex-agent-session-manager remote [options]
  codex-agent-session-manager app-server <start|status|stop> [options]
  codex-agent-session-manager mcp <add|refresh> [options]
  codex-agent-session-manager session <launch|close|replace> [options]
  codex-agent-session-manager --version
  codex-agent-session-manager --help

Commands:
  serve       Start the MCP stdio server.
  init        Initialize a project-scoped Codex session manager setup.
  deinit      Remove the project-scoped session manager scaffold.
  remote      Start/reuse a workspace App Server and launch Codex remote.
  app-server  Manage the workspace-owned App Server lifecycle.
  mcp         Add npm MCP servers, reload MCPs, and start continuation turns.
  session     Launch, close, or replace Codex remote TUI sessions.

${publicCliUsage()}
${initUsage()}
${deinitUsage()}
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

  if (command === 'remote-help') {
    process.stdout.write(remoteUsage());
    return;
  }

  if (command === 'app-server' || command === 'mcp' || command === 'session') {
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

  if (command === 'run-session-replace-operation') {
    await runSessionReplaceOperationFromArgv(argv.slice(1));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  process.exitCode = 2;
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
