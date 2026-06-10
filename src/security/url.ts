import { isIP } from 'node:net';

import { userError } from '../errors.js';

export interface ValidatedAppServerUrl {
  href: string;
  protocol: 'ws:' | 'wss:';
  hostname: string;
  port: number;
}

function unbracketHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
}

function isLoopbackIpv4(host: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return false;
  const octets = host.split('.').map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = unbracketHost(host);
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return isIP(normalized) === 6 && normalized === '::1';
}

function normalizeRootWebSocketUrl(parsed: URL): string {
  const serialized = parsed.toString();
  return serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
}

export function validateAppServerUrl(rawUrl: string, source = 'App Server URL'): ValidatedAppServerUrl {
  if (rawUrl.length === 0) {
    throw userError({
      code: 'empty_app_server_url',
      message: `${source} cannot be empty.`,
      parameter: source,
      expected: 'A loopback websocket URL with an explicit port.',
      examples: ['ws://127.0.0.1:54321', 'ws://localhost:54321'],
      nextAction: 'Pass --url/appServerUrl explicitly, set CODEX_APP_SERVER_URL, or start/reuse a managed App Server first.',
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw userError({
      code: 'invalid_app_server_url',
      message: `${source} must be a valid websocket URL.`,
      parameter: source,
      received: rawUrl,
      expected: 'A URL like ws://127.0.0.1:<port> with protocol, host, and port.',
      examples: ['ws://127.0.0.1:54321', 'ws://localhost:54321'],
      nextAction: 'Add the ws:// protocol and explicit port. Do not pass a bare host:port value.',
    });
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw userError({
      code: 'invalid_app_server_url_protocol',
      message: `${source} must use ws:// or wss://.`,
      parameter: source,
      received: parsed.protocol,
      expected: 'ws:// for local Codex App Server access.',
      examples: ['ws://127.0.0.1:54321'],
      nextAction: 'Replace the URL protocol with ws:// unless you intentionally use a loopback TLS websocket endpoint.',
    });
  }
  if (parsed.username || parsed.password) {
    throw userError({
      code: 'app_server_url_credentials_forbidden',
      message: `${source} must not include credentials.`,
      parameter: source,
      received: rawUrl,
      expected: 'A loopback App Server URL without username or password.',
      examples: ['ws://127.0.0.1:54321'],
      nextAction: 'Remove credentials from the URL. App Server loopback control must not be exposed through credential-bearing URLs.',
    });
  }
  if (!parsed.port) {
    throw userError({
      code: 'app_server_url_missing_port',
      message: `${source} must include a port for local App Server access.`,
      parameter: source,
      received: rawUrl,
      expected: 'A loopback websocket URL with the App Server port.',
      examples: ['ws://127.0.0.1:54321', 'ws://localhost:54321'],
      nextAction: 'Use the port printed by codex-agent-session-manager remote or read it from app-server state/status.',
    });
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw userError({
      code: 'app_server_url_non_loopback',
      message: `${source} host must be loopback-only. Use localhost, 127.0.0.1, or ::1.`,
      parameter: source,
      received: parsed.hostname,
      expected: 'localhost, 127.0.0.1, another 127.x.x.x address, or ::1.',
      examples: ['ws://127.0.0.1:54321', 'ws://[::1]:54321'],
      nextAction: 'Use a loopback App Server URL. Remote network App Server control is intentionally rejected.',
    });
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw userError({
      code: 'app_server_url_must_be_origin_only',
      message: `${source} must not include a path, query string, or fragment.`,
      parameter: source,
      received: rawUrl,
      expected: 'Only the websocket origin: ws://host:port.',
      examples: ['ws://127.0.0.1:54321'],
      nextAction: 'Remove any path, query string, or hash fragment from the App Server URL.',
    });
  }

  return {
    href: normalizeRootWebSocketUrl(parsed),
    protocol: parsed.protocol,
    hostname: unbracketHost(parsed.hostname),
    port: Number(parsed.port),
  };
}
