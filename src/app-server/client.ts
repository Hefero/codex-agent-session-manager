import { redactJsonRpcError, redactSensitiveText } from '../security/redaction.js';
import { validateAppServerUrl } from '../security/url.js';
import { packageName, packageVersion } from '../version.js';
import type {
  AppServerClientInfo,
  AppServerInitializeParams,
  AppServerMethod,
  AppServerPage,
  AppServerRequestMap,
  JsonRpcErrorObject,
  McpServerStatusDetail,
  McpServerStatusEntry,
  ThreadListEntry,
  ThreadReadResult,
} from './protocol.js';
import { nextCursorFrom } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 100;

export interface AppServerConnection {
  send(payload: string): void;
  close(): void;
}

export interface AppServerConnectionHandlers {
  onMessage(payload: string): void;
  onClose(reason: string): void;
  onError(error: unknown): void;
}

export type AppServerConnectionFactory = (
  url: string,
  handlers: AppServerConnectionHandlers,
  timeoutMs: number,
) => Promise<AppServerConnection>;

export interface AppServerClientOptions {
  url: string;
  requestTimeoutMs?: number;
  clientInfo?: AppServerClientInfo;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerRpcError extends Error {
  readonly method: string;
  readonly errorObject: JsonRpcErrorObject;
  readonly redactedError: unknown;

  constructor(method: string, errorObject: JsonRpcErrorObject) {
    const redactedError = redactJsonRpcError(method, errorObject);
    super(`${method}: ${JSON.stringify(redactedError)}`);
    this.name = 'AppServerRpcError';
    this.method = method;
    this.errorObject = errorObject;
    this.redactedError = redactedError;
  }
}

export class AppServerJsonRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: AppServerClientInfo;
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private initializePromise: Promise<unknown> | null = null;

  constructor(
    private readonly connection: AppServerConnection,
    options: AppServerClientOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientInfo = options.clientInfo ?? { name: packageName, version: packageVersion };
  }

  async initialize(): Promise<unknown> {
    if (this.initialized) return null;
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  async listLoadedThreads(): Promise<{ threadIds: string[]; raw: AppServerPage<string> }> {
    const raw = await this.request('thread/loaded/list', {});
    const threadIds = Array.isArray(raw.data) ? raw.data.filter((entry) => typeof entry === 'string') : [];
    return { threadIds, raw };
  }

  async listStoredThreads(input: {
    cwd: string;
    limit: number;
    searchTerm?: string;
  }): Promise<{ threads: ThreadListEntry[]; raw: AppServerPage<ThreadListEntry> }> {
    const params: AppServerRequestMap['thread/list']['params'] = {
      archived: false,
      cwd: input.cwd,
      limit: input.limit,
      sortKey: 'updated_at',
    };
    if (input.searchTerm !== undefined && input.searchTerm.length > 0) {
      params.searchTerm = input.searchTerm;
    }

    const raw = await this.request('thread/list', params);
    const threads = Array.isArray(raw.data) ? raw.data.filter((entry) => entry && typeof entry === 'object') : [];
    return { threads, raw };
  }

  async readThread(input: { threadId: string; includeTurns: boolean }): Promise<ThreadReadResult> {
    return this.request('thread/read', input);
  }

  async reloadMcpServers(): Promise<unknown> {
    return this.request('config/mcpServer/reload', undefined);
  }

  async listMcpServerStatuses(input: {
    threadId: string;
    detail?: McpServerStatusDetail;
    limit?: number;
  }): Promise<{ statuses: McpServerStatusEntry[]; pageCount: number }> {
    const statuses: McpServerStatusEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const params: AppServerRequestMap['mcpServerStatus/list']['params'] = {
        threadId: input.threadId,
        detail: input.detail ?? 'toolsAndAuthOnly',
        limit: input.limit ?? DEFAULT_PAGE_LIMIT,
      };
      if (cursor !== null) {
        params.cursor = cursor;
      }

      const page = await this.request('mcpServerStatus/list', params);
      pageCount += 1;
      if (Array.isArray(page.data)) {
        statuses.push(...page.data.filter((entry) => entry && typeof entry === 'object'));
      }

      const nextCursor = nextCursorFrom(page);
      if (!nextCursor || seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return { statuses, pageCount };
  }

  handleIncomingMessage(payload: string): void {
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'number' && typeof id !== 'string') return;

    const pending = this.pending.get(String(id));
    if (!pending) return;

    this.pending.delete(String(id));
    clearTimeout(pending.timer);

    if (record.error && typeof record.error === 'object') {
      pending.reject(new AppServerRpcError(pending.method, record.error as JsonRpcErrorObject));
      return;
    }

    pending.resolve(record.result);
  }

  handleConnectionClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error(`App Server connection closed: ${redactSensitiveText(reason)}`));
  }

  handleConnectionError(error: unknown): void {
    this.rejectPending(new Error(`App Server connection error: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('App Server client closed.'));
    this.connection.close();
  }

  private async initializeOnce(): Promise<unknown> {
    try {
      const params: AppServerInitializeParams = {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      };
      const result = await this.sendRequest('initialize', params, { allowBeforeInitialize: true });
      this.sendNotification('initialized', {});
      this.initialized = true;
      return result;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  private request<M extends Exclude<AppServerMethod, 'initialize'>>(
    method: M,
    params: AppServerRequestMap[M]['params'],
  ): Promise<AppServerRequestMap[M]['result']> {
    return this.sendRequest(method, params, { allowBeforeInitialize: false }) as Promise<AppServerRequestMap[M]['result']>;
  }

  private sendRequest<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestMap[M]['params'],
    options: { allowBeforeInitialize: boolean },
  ): Promise<AppServerRequestMap[M]['result']> {
    if (this.closed) {
      return Promise.reject(new Error('App Server client is closed.'));
    }
    if (!options.allowBeforeInitialize && !this.initialized) {
      return Promise.reject(new Error('App Server client must be initialized before calling App Server methods.'));
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, params };
    this.connection.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(String(id))) return;
        this.pending.delete(String(id));
        reject(new Error(`${method}: timeout after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(String(id), { method, resolve, reject, timer });
    }) as Promise<AppServerRequestMap[M]['result']>;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error('App Server client is closed.');
    }
    this.connection.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function connectAppServerClient(
  options: AppServerClientOptions,
  connectionFactory: AppServerConnectionFactory = openWebSocketConnection,
): Promise<AppServerJsonRpcClient> {
  const url = validateAppServerUrl(options.url).href;
  let client: AppServerJsonRpcClient | null = null;
  const connection = await connectionFactory(
    url,
    {
      onMessage(payload) {
        client?.handleIncomingMessage(payload);
      },
      onClose(reason) {
        client?.handleConnectionClosed(reason);
      },
      onError(error) {
        client?.handleConnectionError(error);
      },
    },
    options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  client = new AppServerJsonRpcClient(connection, { ...options, url });
  return client;
}

async function openWebSocketConnection(
  url: string,
  handlers: AppServerConnectionHandlers,
  timeoutMs: number,
): Promise<AppServerConnection> {
  if (typeof WebSocket !== 'function') {
    throw new Error('Global WebSocket is unavailable. Use Node 22+.');
  }

  const safeUrl = validateAppServerUrl(url).href;
  const ws = new WebSocket(safeUrl);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket connection timed out after ${timeoutMs}ms for ${safeUrl}`));
    }, timeoutMs);

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed for ${safeUrl}`));
      },
      { once: true },
    );
  });

  ws.addEventListener('message', (event) => {
    handlers.onMessage(String(event.data));
  });
  ws.addEventListener('close', (event) => {
    handlers.onClose(event.reason || `code ${event.code}`);
  });
  ws.addEventListener('error', (event) => {
    handlers.onError(event);
  });

  return {
    send(payload) {
      ws.send(payload);
    },
    close() {
      ws.close();
    },
  };
}
