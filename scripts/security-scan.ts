import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface SensitivePattern {
  name: string;
  regex: RegExp;
}

interface Finding {
  file: string;
  line: number | null;
  pattern: string;
  excerpt: string;
  location: 'path' | 'content';
}

const sensitivePatterns: SensitivePattern[] = [
  {
    name: 'personal-windows-user-path',
    regex: new RegExp(String.raw`[A-Za-z]:[\\/]Users[\\/][^\\/\r\n]+[\\/]`),
  },
  {
    name: 'personal-macos-user-path',
    regex: new RegExp(`(?<![A-Za-z]:)/${['Use', 'rs'].join('')}/[^/\\r\\n]+/`),
  },
  {
    name: 'personal-linux-user-path',
    regex: new RegExp(String.raw`(?<![A-Za-z]:)/${['ho', 'me'].join('')}/[^/\r\n]+/`),
  },
  {
    name: 'source-workspace-path',
    regex: new RegExp(String.raw`Documents[\\/]Claude[\\/]`, 'i'),
  },
  {
    name: 'known-local-user-name',
    regex: new RegExp(['Guil', 'herme'].join(''), 'i'),
  },
  {
    name: 'github-token',
    regex: new RegExp(`${['github', 'pat'].join('_')}_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,}`),
  },
  {
    name: 'openai-key',
    regex: new RegExp(String.raw`sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}`),
  },
  {
    name: 'slack-token',
    regex: new RegExp(String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`),
  },
  {
    name: 'credential-assignment',
    regex: new RegExp(String.raw`["']?(?:api[_-]?key|secret|token|password|bearer)["']?\s*[:=]\s*["']?(?!<)[A-Za-z0-9_./+=:-]{12,}`, 'i'),
  },
  {
    name: 'aws-credential-assignment',
    regex: new RegExp(String.raw`["']?AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)["']?\s*[:=]\s*["']?(?!<)[A-Za-z0-9_./+=:-]{12,}`, 'i'),
  },
  {
    name: 'authorization-bearer',
    regex: new RegExp(String.raw`["']?authorization["']?\s*:\s*["']?bearer\s+(?!<)[A-Za-z0-9_./+=:-]{12,}`, 'i'),
  },
  {
    name: 'app-server-url-credentials',
    regex: new RegExp(String.raw`\bwss?:\/\/[^\/\s"'<>?#]+:[^@\s"'<>?#]+@[^\/\s"'<>?#]+`, 'i'),
  },
  {
    name: 'app-server-url-query-or-fragment',
    regex: new RegExp(String.raw`\bwss?:\/\/[^\/\s"'<>?#]+(?:\/[^\s"'<>?#]*)?[?#][^\s"']*`, 'i'),
  },
  {
    name: 'app-server-url-path',
    regex: new RegExp(String.raw`\bwss?:\/\/[^\/\s"'<>?#]+\/(?![?\s"'#]|$)[^\s"'?#]*`, 'i'),
  },
  {
    name: 'codex-thread-or-app-id',
    regex: new RegExp(String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, 'i'),
  },
];

function globalRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
}

function redactedExcerpt(line: string): string {
  let redacted = line;
  for (const pattern of sensitivePatterns) {
    redacted = redacted.replace(globalRegex(pattern.regex), `<redacted:${pattern.name}>`);
  }
  return redacted.trim().slice(0, 240);
}

function candidateFiles(): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
    windowsHide: true,
  });

  if (git.status !== 0) {
    throw new Error(git.stderr.toString('utf8') || 'git ls-files failed');
  }

  return git.stdout.toString('utf8').split('\0').filter(Boolean);
}

function scanFiles(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const redactedFile = redactedExcerpt(file);
    for (const pattern of sensitivePatterns) {
      if (pattern.regex.test(file)) {
        findings.push({
          file: redactedFile,
          line: null,
          pattern: pattern.name,
          excerpt: redactedFile,
          location: 'path',
        });
      }
    }

    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;

    content.split(/\r?\n/u).forEach((line, index) => {
      for (const pattern of sensitivePatterns) {
        if (pattern.regex.test(line)) {
          findings.push({
            file: redactedFile,
            line: index + 1,
            pattern: pattern.name,
            excerpt: redactedExcerpt(line),
            location: 'content',
          });
        }
      }
    });
  }

  return findings;
}

try {
  const files = candidateFiles();
  const findings = scanFiles(files);

  if (findings.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, scannedFiles: files.length }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
