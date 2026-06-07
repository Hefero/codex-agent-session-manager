export interface JsonRpcErrorObject {
  code?: number;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface AppServerClientInfo {
  name: string;
  version: string;
}

export interface AppServerInitializeParams {
  clientInfo: AppServerClientInfo;
  capabilities: {
    experimentalApi: true;
    [key: string]: unknown;
  };
}

export interface AppServerPage<T> {
  data?: T[];
  nextCursor?: string | null;
  next_cursor?: string | null;
  pagination?: {
    nextCursor?: string | null;
    next_cursor?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ThreadListEntry {
  id?: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  status?: {
    type?: string;
    activeFlags?: string[];
    [key: string]: unknown;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  sourceKind?: string | null;
  source_kind?: string | null;
  ephemeral?: boolean | null;
  [key: string]: unknown;
}

export interface ThreadListParams {
  archived: boolean;
  cwd: string;
  limit: number;
  sortKey: 'updated_at';
  cursor?: string;
  searchTerm?: string;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface ThreadReadResult {
  thread?: {
    id?: string;
    cwd?: string | null;
    status?: {
      type?: string;
      activeFlags?: string[];
      [key: string]: unknown;
    } | null;
    turns?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type McpServerStatusDetail = 'toolsAndAuthOnly' | 'full';

export interface McpServerStatusListParams {
  threadId: string;
  detail: McpServerStatusDetail;
  limit: number;
  cursor?: string;
}

export interface McpServerStatusEntry {
  name?: string;
  serverInfo?: {
    name?: string;
    version?: string;
    [key: string]: unknown;
  } | null;
  tools?: Record<string, unknown> | unknown[];
  resources?: Record<string, unknown> | unknown[];
  resourceTemplates?: Record<string, unknown> | unknown[];
  authStatus?: unknown;
  [key: string]: unknown;
}

export interface AppServerRequestMap {
  initialize: {
    params: AppServerInitializeParams;
    result: unknown;
  };
  'config/mcpServer/reload': {
    params: undefined;
    result: unknown;
  };
  'thread/loaded/list': {
    params: Record<string, never>;
    result: AppServerPage<string>;
  };
  'thread/list': {
    params: ThreadListParams;
    result: AppServerPage<ThreadListEntry>;
  };
  'thread/read': {
    params: ThreadReadParams;
    result: ThreadReadResult;
  };
  'mcpServerStatus/list': {
    params: McpServerStatusListParams;
    result: AppServerPage<McpServerStatusEntry>;
  };
}

export type AppServerMethod = keyof AppServerRequestMap;

export function nextCursorFrom(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const direct = record.nextCursor ?? record.next_cursor;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const pagination = record.pagination;
  if (!pagination || typeof pagination !== 'object') return null;
  const paginationRecord = pagination as Record<string, unknown>;
  const nested = paginationRecord.nextCursor ?? paginationRecord.next_cursor;
  return typeof nested === 'string' && nested.length > 0 ? nested : null;
}
