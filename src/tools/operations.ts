import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { assertWorkspacePath, resolveWorkspaceRoot, workspacePath } from '../security/workspace.js';

export const operationStatuses = ['pending', 'running', 'completed', 'failed'] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export interface OperationRecord {
  id: string;
  kind: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: unknown;
  evidence?: unknown;
  nextAction?: string;
}

export interface CreateOperationInput {
  id?: string;
  kind: string;
  status?: Extract<OperationStatus, 'pending' | 'running'>;
  evidence?: unknown;
  nextAction?: string;
}

export interface UpdateOperationInput {
  status?: OperationStatus;
  evidence?: unknown;
  nextAction?: string;
}

export interface OperationWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface OperationWaitResult {
  operation: OperationRecord | null;
  found: boolean;
  completed: boolean;
  timedOut: boolean;
}

export interface OperationStoreOptions {
  workspace?: string;
  stateFile?: string;
  durable?: boolean;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 0;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 100;
const MIN_POLL_MS = 10;
const MAX_POLL_MS = 5_000;
const STATE_DIR_NAME = '.codex-agent-session-manager';

export function operationStateFileForWorkspace(workspace = process.cwd()): string {
  return workspacePath(workspace, STATE_DIR_NAME, 'state', 'operations.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function cloneOperation(operation: OperationRecord): OperationRecord {
  return cloneValue(operation);
}

function isTerminal(status: OperationStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === 'string' && operationStatuses.includes(value as OperationStatus);
}

function cloneOptional(value: unknown): unknown {
  return value === undefined ? undefined : cloneValue(value);
}

function operationFromUnknown(value: unknown): OperationRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.kind !== 'string' || value.kind.length === 0) return null;
  if (!isOperationStatus(value.status)) return null;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;

  const operation: OperationRecord = {
    id: value.id,
    kind: value.kind,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (typeof value.completedAt === 'string') {
    operation.completedAt = value.completedAt;
  }
  if (value.failure !== undefined) {
    operation.failure = cloneOptional(value.failure);
  }
  if (value.evidence !== undefined) {
    operation.evidence = cloneOptional(value.evidence);
  }
  if (typeof value.nextAction === 'string') {
    operation.nextAction = value.nextAction;
  }
  return operation;
}

export class OperationStore {
  private readonly operations = new Map<string, OperationRecord>();
  private readonly stateFile: string | null;
  private readonly workspaceRoot: string | null;

  constructor(options: OperationStoreOptions = {}) {
    if (options.durable === false) {
      this.stateFile = null;
      this.workspaceRoot = null;
    } else if (options.stateFile !== undefined) {
      this.stateFile = resolve(options.stateFile);
      this.workspaceRoot = null;
    } else {
      this.workspaceRoot = resolveWorkspaceRoot(options.workspace);
      this.stateFile = operationStateFileForWorkspace(this.workspaceRoot);
    }
    this.loadFromDisk();
  }

  create(input: CreateOperationInput): OperationRecord {
    this.loadFromDisk();
    const timestamp = nowIso();
    const operation: OperationRecord = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      status: input.status ?? 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (input.evidence !== undefined) {
      operation.evidence = cloneOptional(input.evidence);
    }
    if (input.nextAction !== undefined) {
      operation.nextAction = input.nextAction;
    }
    this.operations.set(operation.id, operation);
    this.saveToDisk();
    return cloneOperation(operation);
  }

  update(operationId: string, input: UpdateOperationInput): OperationRecord | null {
    this.loadFromDisk();
    const current = this.operations.get(operationId);
    if (!current) return null;

    const updated: OperationRecord = {
      ...cloneOperation(current),
      updatedAt: nowIso(),
    };
    if (input.status !== undefined) {
      updated.status = input.status;
      if (isTerminal(input.status)) {
        updated.completedAt = updated.completedAt ?? updated.updatedAt;
      }
    }
    if (input.evidence !== undefined) {
      updated.evidence = cloneOptional(input.evidence);
    }
    if (input.nextAction !== undefined) {
      updated.nextAction = input.nextAction;
    }
    this.operations.set(operationId, updated);
    this.saveToDisk();
    return cloneOperation(updated);
  }

  complete(operationId: string, input: { evidence?: unknown; nextAction?: string } = {}): OperationRecord | null {
    return this.update(operationId, { ...input, status: 'completed' });
  }

  fail(operationId: string, input: { failure: unknown; evidence?: unknown; nextAction?: string }): OperationRecord | null {
    this.loadFromDisk();
    const current = this.operations.get(operationId);
    if (!current) return null;

    const timestamp = nowIso();
    const failed: OperationRecord = {
      ...cloneOperation(current),
      status: 'failed',
      updatedAt: timestamp,
      completedAt: timestamp,
      failure: cloneOptional(input.failure),
    };
    if (input.evidence !== undefined) {
      failed.evidence = cloneOptional(input.evidence);
    }
    if (input.nextAction !== undefined) {
      failed.nextAction = input.nextAction;
    }
    this.operations.set(operationId, failed);
    this.saveToDisk();
    return cloneOperation(failed);
  }

  read(operationId: string): OperationRecord | null {
    this.loadFromDisk();
    const operation = this.operations.get(operationId);
    return operation ? cloneOperation(operation) : null;
  }

  list(): OperationRecord[] {
    this.loadFromDisk();
    return [...this.operations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(cloneOperation);
  }

  snapshot(): { operations: OperationRecord[]; count: number } {
    const operations = this.list();
    return { operations, count: operations.length };
  }

  async waitForOperation(operationId: string, options: OperationWaitOptions = {}): Promise<OperationWaitResult> {
    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
    const pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const operation = this.read(operationId);
      if (!operation) {
        return {
          operation: null,
          found: false,
          completed: false,
          timedOut: false,
        };
      }
      if (isTerminal(operation.status)) {
        return {
          operation,
          found: true,
          completed: operation.status === 'completed',
          timedOut: false,
        };
      }
      if (Date.now() >= deadline) {
        return {
          operation,
          found: true,
          completed: false,
          timedOut: true,
        };
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  private loadFromDisk(): void {
    if (!this.stateFile) return;
    if (!existsSync(this.stateFile)) {
      this.operations.clear();
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as unknown;
      const rawOperations = isRecord(parsed) && Array.isArray(parsed.operations) ? parsed.operations : [];
      this.operations.clear();
      for (const rawOperation of rawOperations) {
        const operation = operationFromUnknown(rawOperation);
        if (operation) {
          this.operations.set(operation.id, operation);
        }
      }
    } catch {
      this.operations.clear();
    }
  }

  private saveToDisk(): void {
    if (!this.stateFile) return;
    if (this.workspaceRoot !== null) assertWorkspacePath(this.workspaceRoot, this.stateFile);

    const operations = [...this.operations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(cloneOperation);
    const payload = {
      operations,
      count: operations.length,
      updatedAt: nowIso(),
    };
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tempFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tempFile, this.stateFile);
  }
}

export const operationReadInputSchema = {
  operationId: z.string().min(1).describe('Operation id to read.'),
};

export const operationWaitInputSchema = {
  operationId: z.string().min(1).describe('Operation id to wait for.'),
  timeoutMs: z.number().int().min(MIN_WAIT_TIMEOUT_MS).max(MAX_WAIT_TIMEOUT_MS).optional().describe('Maximum wait time in milliseconds.'),
  pollMs: z.number().int().min(MIN_POLL_MS).max(MAX_POLL_MS).optional().describe('Polling interval in milliseconds.'),
};

const operationReadInputObject = z.object(operationReadInputSchema);
const operationWaitInputObject = z.object(operationWaitInputSchema);

type OperationReadInput = z.infer<typeof operationReadInputObject>;
type OperationWaitInput = z.infer<typeof operationWaitInputObject>;

export function buildOperationReadPayload(input: OperationReadInput, store: OperationStore = operationStore): Record<string, unknown> {
  const operation = store.read(input.operationId);
  return {
    ok: true,
    operation,
    found: operation !== null,
    count: store.snapshot().count,
  };
}

export async function buildOperationWaitPayload(input: OperationWaitInput, store: OperationStore = operationStore): Promise<Record<string, unknown>> {
  const waitOptions: OperationWaitOptions = {};
  if (input.timeoutMs !== undefined) {
    waitOptions.timeoutMs = input.timeoutMs;
  }
  if (input.pollMs !== undefined) {
    waitOptions.pollMs = input.pollMs;
  }
  const result = await store.waitForOperation(input.operationId, waitOptions);
  return {
    ok: true,
    operation: result.operation,
    completed: result.completed,
    timedOut: result.timedOut,
    found: result.found,
  };
}

export const operationStore = new OperationStore();
