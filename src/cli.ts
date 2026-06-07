#!/usr/bin/env node
import { startStdioServer } from './mcp-server.js';
import { runMcpReloadOperationFromArgv } from './tools/reload.js';
import { packageName, packageVersion } from './version.js';

function printHelp(): void {
  process.stdout.write(`${packageName} ${packageVersion}

Usage:
  codex-agent-session-manager serve
  codex-agent-session-manager --version
  codex-agent-session-manager --help

Commands:
  serve    Start the MCP stdio server.
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

  if (command === 'serve' || command === 'mcp') {
    await startStdioServer();
    return;
  }

  if (command === 'run-mcp-reload-operation') {
    await runMcpReloadOperationFromArgv(argv.slice(1));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  process.exitCode = 2;
}

await main(process.argv.slice(2));
