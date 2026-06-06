export interface OperationSummary {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  nextAction: string;
}

export class OperationStore {
  private readonly operations = new Map<string, OperationSummary>();

  list(): OperationSummary[] {
    return [...this.operations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  snapshot(): { operations: OperationSummary[]; count: number } {
    const operations = this.list();
    return { operations, count: operations.length };
  }
}

export const operationStore = new OperationStore();

