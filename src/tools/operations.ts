import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 0;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 100;
const MIN_POLL_MS = 10;
const MAX_POLL_MS = 5_000;

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

export class OperationStore {
  private readonly operations = new Map<string, OperationRecord>();

  create(input: CreateOperationInput): OperationRecord {
    const timestamp = nowIso();
    const operation: OperationRecord = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      status: input.status ?? 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (input.evidence !== undefined) {
      operation.evidence = input.evidence;
    }
    if (input.nextAction !== undefined) {
      operation.nextAction = input.nextAction;
    }
    this.operations.set(operation.id, operation);
    return cloneOperation(operation);
  }

  update(operationId: string, input: UpdateOperationInput): OperationRecord | null {
    const current = this.operations.get(operationId);
    if (!current) return null;

    const updated: OperationRecord = {
      ...current,
      updatedAt: nowIso(),
    };
    if (input.status !== undefined) {
      updated.status = input.status;
      if (isTerminal(input.status)) {
        updated.completedAt = updated.completedAt ?? updated.updatedAt;
      }
    }
    if (input.evidence !== undefined) {
      updated.evidence = input.evidence;
    }
    if (input.nextAction !== undefined) {
      updated.nextAction = input.nextAction;
    }
    this.operations.set(operationId, updated);
    return cloneOperation(updated);
  }

  complete(operationId: string, input: { evidence?: unknown; nextAction?: string } = {}): OperationRecord | null {
    return this.update(operationId, { ...input, status: 'completed' });
  }

  fail(operationId: string, input: { failure: unknown; evidence?: unknown; nextAction?: string }): OperationRecord | null {
    const current = this.operations.get(operationId);
    if (!current) return null;

    const timestamp = nowIso();
    const failed: OperationRecord = {
      ...current,
      status: 'failed',
      updatedAt: timestamp,
      completedAt: timestamp,
      failure: input.failure,
    };
    if (input.evidence !== undefined) {
      failed.evidence = input.evidence;
    }
    if (input.nextAction !== undefined) {
      failed.nextAction = input.nextAction;
    }
    this.operations.set(operationId, failed);
    return cloneOperation(failed);
  }

  read(operationId: string): OperationRecord | null {
    const operation = this.operations.get(operationId);
    return operation ? cloneOperation(operation) : null;
  }

  list(): OperationRecord[] {
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
