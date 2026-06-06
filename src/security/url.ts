import { isIP } from 'node:net';

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
    throw new Error(`${source} cannot be empty.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${source} must be a valid websocket URL.`);
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`${source} must use ws:// or wss://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${source} must not include credentials.`);
  }
  if (!parsed.port) {
    throw new Error(`${source} must include a port for local App Server access.`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(`${source} host must be loopback-only. Use localhost, 127.0.0.1, or ::1.`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${source} must not include a path, query string, or fragment.`);
  }

  return {
    href: normalizeRootWebSocketUrl(parsed),
    protocol: parsed.protocol,
    hostname: unbracketHost(parsed.hostname),
    port: Number(parsed.port),
  };
}
