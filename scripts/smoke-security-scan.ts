import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactJsonRpcError, redactSensitiveText } from '../src/security/redaction.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const scanScript = join(repoRoot, 'scripts', 'security-scan.ts');
const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const workspace = mkdtempSync(join(tmpdir(), 'codex-agent-session-manager-security-'));

function run(command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runScan() {
  return run(process.execPath, ['--import', pathToFileURL(tsxLoader).href, scanScript]);
}

try {
  const gitInit = run('git', ['init']);
  assert.equal(gitInit.status, 0, `git init failed\n${gitInit.stderr}`);

  const userInfoUrl = ['ws://user', ':password-sentinel@127.0.0.1', ':4506'].join('');
  for (const punctuation of [',', '.', ')', ']', ';', '!', ':', '>', '<', '{', '(', '[']) {
    const redacted = redactSensitiveText(`url=${userInfoUrl}${punctuation}`);
    assert.ok(!redacted.includes('password-sentinel'), `URL redaction should hide userinfo: ${redacted}`);
    assert.ok(redacted.endsWith(punctuation), `URL redaction should preserve punctuation: ${redacted}`);
  }

  const promptSentinel = 'turn-start-prompt-sentinel';
  const turnStartError = redactJsonRpcError('turn/start', {
    code: -32602,
    message: `Rejected input text: ${promptSentinel}`,
    data: { params: { input: [{ type: 'text', text: promptSentinel }] } },
  });
  const turnStartErrorJson = JSON.stringify(turnStartError);
  assert.ok(!turnStartErrorJson.includes(promptSentinel), `turn/start redaction should hide prompt text: ${turnStartErrorJson}`);

  writeFileSync(join(workspace, 'clean.txt'), 'no secrets here\n');
  let result = runScan();
  assert.equal(result.status, 0, `clean scan should pass\n${result.stdout}${result.stderr}`);

  const token = ['abcdefgh', 'ijklmnop'].join('');
  const bearer = ['abcdefghi', 'jklmnopq'].join('');
  const githubToken = `ghp_${['abcdefghijkl', 'mnopqrstuvwx'].join('')}`;
  const openaiKey = `sk-proj-${['ABCDEFGHIJKLMNOP', 'QRSTUVWX'].join('')}`;
  const slackToken = `xoxb-${['1234567890', 'abcdef'].join('')}`;
  const uuid = ['019e907f', '377b', '7a92', '8e2a', '952aa330d208'].join('-');
  const linuxPath = ['', ['ho', 'me'].join(''), 'alice', 'private', 'project'].join('/');
  const macPath = ['', ['Use', 'rs'].join(''), 'Alice', 'private', 'project'].join('/');
  const sourcePath = ['Documents', 'Claude', 'private'].join('/');
  const knownUser = ['Guil', 'herme'].join('');
  const rawPath = ['C:', 'Users', 'Alice', 'repo'].join('/');
  const appServerUserInfoUrl = ['ws://user', ':pass-sentinel@127.0.0.1', ':4506'].join('');
  const appServerQueryUrl = ['ws://127.0.0.1', ':4506/', '?marker=query-sentinel'].join('');
  const appServerFragmentUrl = ['ws://127.0.0.1', ':4506/', '#fragment-sentinel'].join('');
  const appServerPathUrl = ['ws://127.0.0.1', ':4506', '/app-server-path-sentinel'].join('');
  const awsAccessKey = `AKIA${['ABCDEFGHIJKLMNOP'].join('')}`;
  const awsSecret = ['abcdefghijklmnopqrst', 'uvwxyzABCDEF1234567890+/'].join('');

  writeFileSync(join(workspace, `${githubToken}.txt`), 'sensitive filename fixture\n');
  writeFileSync(
    join(workspace, 'leak.json'),
    JSON.stringify(
      {
        token,
        Authorization: `Bearer ${bearer}`,
        path: rawPath,
        githubToken,
        openaiKey,
        slackToken,
        uuid,
        linuxPath,
        macPath,
        sourcePath,
        knownUser,
        appServerUserInfoUrl,
        appServerQueryUrl,
        appServerFragmentUrl,
        appServerPathUrl,
        [['AWS', 'ACCESS', 'KEY', 'ID'].join('_')]: awsAccessKey,
        [['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')]: awsSecret,
      },
      null,
      2,
    ),
  );

  result = runScan();
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, 'leaky scan should fail');
  for (const expected of [
    'credential-assignment',
    'authorization-bearer',
    'app-server-url-credentials',
    'app-server-url-query-or-fragment',
    'app-server-url-path',
    'personal-windows-user-path',
    'personal-linux-user-path',
    'personal-macos-user-path',
    'source-workspace-path',
    'known-local-user-name',
    'github-token',
    'openai-key',
    'slack-token',
    'codex-thread-or-app-id',
    'aws-credential-assignment',
  ]) {
    assert.ok(output.includes(expected), `expected scan output to include ${expected}`);
  }
  for (const raw of [
    token,
    bearer,
    rawPath,
    githubToken,
    openaiKey,
    slackToken,
    uuid,
    linuxPath,
    macPath,
    sourcePath,
    knownUser,
    awsAccessKey,
    awsSecret,
    appServerUserInfoUrl,
    appServerQueryUrl,
    appServerFragmentUrl,
    appServerPathUrl,
  ]) {
    assert.ok(!output.includes(raw), `scan output should not print raw sensitive fixture: ${raw}`);
  }
  assert.ok(output.includes('<redacted:'), 'scan output should include redacted excerpts');

  process.stdout.write(`${JSON.stringify({ ok: true, workspaceRemoved: true }, null, 2)}\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
