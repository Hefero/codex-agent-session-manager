import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNpmCommand } from '../src/npm.js';

test('resolveNpmCommand uses npm binary directly on non-Windows platforms', () => {
  const command = resolveNpmCommand(['--version'], { platform: 'linux' });

  assert.equal(command.command, 'npm');
  assert.deepEqual(command.args, ['--version']);
  assert.deepEqual(command.displayCommand, ['npm', '--version']);
  assert.equal(command.strategy, 'npm-bin');
});

test('resolveNpmCommand uses node plus npm-cli.js on Windows when available', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const command = resolveNpmCommand(['--version'], {
    platform: 'win32',
    execPath,
    pathExists: (path) => path.endsWith('\\node_modules\\npm\\bin\\npm-cli.js'),
  });

  assert.equal(command.command, execPath);
  assert.deepEqual(command.args, [
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    '--version',
  ]);
  assert.deepEqual(command.displayCommand, ['npm', '--version']);
  assert.equal(command.strategy, 'node-npm-cli');
});

test('resolveNpmCommand falls back to cmd npm shim on Windows when npm-cli.js is unavailable', () => {
  const command = resolveNpmCommand(['install', 'example'], {
    platform: 'win32',
    execPath: 'C:\\Tools\\node.exe',
    pathExists: () => false,
  });

  assert.equal(command.command, 'cmd.exe');
  assert.deepEqual(command.args, ['/d', '/c', 'npm.cmd', 'install', 'example']);
  assert.deepEqual(command.displayCommand, ['npm', 'install', 'example']);
  assert.equal(command.strategy, 'cmd-npm-shim');
});
