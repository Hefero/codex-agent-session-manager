import { resolve } from 'node:path';
import { z } from 'zod';

import { connectAppServerClient } from '../app-server/client.js';
import { resolveAppServerUrl } from '../app-server/config.js';
import type { ThreadListEntry, ThreadReadResult } from '../app-server/protocol.js';
import { redactSensitiveText, redactValue } from '../security/redaction.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STORED_LIMIT = 10;
const MAX_STORED_LIMIT = 100;

const appServerUrlSchema = z
  .string()
  .optional()
  .describe('Optional loopback App Server websocket URL. Defaults to CODEX_APP_SERVER_URL or workspace launcher state.');
const timeoutMsSchema = z.number().int().min(1_000).max(120_000).optional().describe('Request timeout in milliseconds.');

export const threadContextInputSchema = {
  appServerUrl: appServerUrlSchema,
  cwd: z.string().min(1).optional().describe('Workspace cwd used to match loaded and stored threads. Defaults to process cwd.'),
  marker: z.string().max(300).optional().describe('Optional short non-secret marker to find in loaded thread turns.'),
  includeStored: z.boolean().optional().describe('Also query persisted threads with thread/list for the cwd.'),
  searchTerm: z.string().max(300).optional().describe('Optional stored-thread search term. Do not pass secrets.'),
  storedLimit: z.number().int().min(1).max(MAX_STORED_LIMIT).optional().describe('Maximum stored threads to return.'),
  timeoutMs: timeoutMsSchema,
};

const threadContextInputObject = z.object(threadContextInputSchema);

type ThreadContextInput = z.infer<typeof threadContextInputObject>;

export type RecommendationConfidence = 'high' | 'medium' | 'low';

export interface ThreadContextCandidate {
  threadId: string;
  status: string | null;
  activeFlags: string[] | null;
  cwdMatches: boolean;
  cwdPreview: string | null;
  markerMatched: boolean;
  turnCount: number | null;
  turnStatuses: Array<string | null> | null;
  hasInProgressTurn: boolean | null;
  lastAgentMessagePreview: string | null;
  error?: unknown;
}

export interface StoredThreadCandidate {
  threadId: string | null;
  namePreview: string | null;
  preview: string | null;
  status: string | null;
  activeFlags: string[] | null;
  cwdMatches: boolean;
  cwdPreview: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceKind: string | null;
  ephemeral: boolean | null;
}

export interface ThreadContextRecommendation {
  recommendedThreadId: string | null;
  recommendedThreadIdSource: string | null;
  recommendationConfidence: RecommendationConfidence | null;
  ambiguous: boolean;
}

function normalizedPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathsMatch(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || left.length === 0) return false;
  return normalizedPath(left) === normalizedPath(right);
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArrayFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function publicPreview(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return redactValue(value.slice(0, 180)) as string;
}

function publicCwdPreview(value: unknown, requestedCwd: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return pathsMatch(value, requestedCwd) ? '<requested-cwd>' : '<path:redacted>';
}

function publicStatus(status: unknown): { type: string | null; activeFlags: string[] | null } {
  const statusRecord = recordFrom(status);
  return {
    type: typeof statusRecord?.type === 'string' ? statusRecord.type : null,
    activeFlags: stringArrayFrom(statusRecord?.activeFlags),
  };
}

function turnStatus(turn: unknown): string | null {
  const turnRecord = recordFrom(turn);
  if (!turnRecord) return null;
  if (typeof turnRecord.status === 'string') return turnRecord.status;
  const statusRecord = recordFrom(turnRecord.status);
  return typeof statusRecord?.type === 'string' ? statusRecord.type : null;
}

function turnItems(turn: unknown): unknown[] {
  const items = recordFrom(turn)?.items;
  return Array.isArray(items) ? items : [];
}

function jsonIncludes(value: unknown, marker: string): boolean {
  try {
    return JSON.stringify(value)?.includes(marker) ?? false;
  } catch {
    return false;
  }
}

function collectTurnSummary(turns: unknown[] | undefined, marker: string | undefined): Pick<
  ThreadContextCandidate,
  'markerMatched' | 'turnCount' | 'turnStatuses' | 'hasInProgressTurn' | 'lastAgentMessagePreview'
> {
  if (!turns) {
    return {
      markerMatched: false,
      turnCount: null,
      turnStatuses: null,
      hasInProgressTurn: null,
      lastAgentMessagePreview: null,
    };
  }

  const turnStatuses = turns.map((turn) => turnStatus(turn));
  const markerMatched = marker !== undefined && marker.length > 0 && turns.some((turn) => turnItems(turn).some((item) => jsonIncludes(item, marker)));
  const finalMessages = turns
    .flatMap((turn) => turnItems(turn))
    .filter((item) => {
      const itemRecord = recordFrom(item);
      return itemRecord?.type === 'agentMessage' && typeof itemRecord.text === 'string';
    });
  const lastMessage = finalMessages.at(-1);
  const lastMessageText = recordFrom(lastMessage)?.text;

  return {
    markerMatched,
    turnCount: turns.length,
    turnStatuses,
    hasInProgressTurn: turnStatuses.includes('inProgress'),
    lastAgentMessagePreview: publicPreview(lastMessageText),
  };
}

export function summarizeLoadedThreadRead(input: {
  threadId: string;
  readResult: ThreadReadResult;
  requestedCwd: string;
  marker?: string;
}): ThreadContextCandidate {
  const thread = input.readResult.thread;
  const status = publicStatus(thread?.status);
  const turns = Array.isArray(thread?.turns) ? thread.turns : undefined;

  return {
    threadId: input.threadId,
    status: status.type,
    activeFlags: status.activeFlags,
    cwdMatches: pathsMatch(thread?.cwd, input.requestedCwd),
    cwdPreview: publicCwdPreview(thread?.cwd, input.requestedCwd),
    ...collectTurnSummary(turns, input.marker),
  };
}

export function summarizeStoredThread(entry: ThreadListEntry, requestedCwd: string): StoredThreadCandidate {
  const status = publicStatus(entry.status);
  return {
    threadId: typeof entry.id === 'string' ? entry.id : null,
    namePreview: publicPreview(entry.name),
    preview: publicPreview(entry.preview),
    status: status.type,
    activeFlags: status.activeFlags,
    cwdMatches: pathsMatch(entry.cwd, requestedCwd),
    cwdPreview: publicCwdPreview(entry.cwd, requestedCwd),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    sourceKind: typeof entry.sourceKind === 'string' ? entry.sourceKind : typeof entry.source_kind === 'string' ? entry.source_kind : null,
    ephemeral: typeof entry.ephemeral === 'boolean' ? entry.ephemeral : null,
  };
}

function selection(threadId: string, source: string, confidence: RecommendationConfidence): ThreadContextRecommendation {
  return {
    recommendedThreadId: threadId,
    recommendedThreadIdSource: source,
    recommendationConfidence: confidence,
    ambiguous: false,
  };
}

function noSelection(ambiguous: boolean): ThreadContextRecommendation {
  return {
    recommendedThreadId: null,
    recommendedThreadIdSource: null,
    recommendationConfidence: null,
    ambiguous,
  };
}

function isNotWaitingOnApproval(candidate: ThreadContextCandidate): boolean {
  return !candidate.activeFlags?.includes('waitingOnApproval');
}

export function selectThreadContextRecommendation(
  candidates: readonly ThreadContextCandidate[],
  storedCandidates: readonly StoredThreadCandidate[] = [],
): ThreadContextRecommendation {
  const markerMatches = candidates.filter((candidate) => candidate.markerMatched);
  if (markerMatches.length === 1) {
    return selection(markerMatches[0]!.threadId, 'loaded-marker-match', 'high');
  }
  if (markerMatches.length > 1) {
    return noSelection(true);
  }

  if (candidates.length === 1) {
    return selection(candidates[0]!.threadId, 'sole-loaded-thread', 'high');
  }

  const activeCwdNotWaiting = candidates.filter(
    (candidate) => candidate.status === 'active' && candidate.cwdMatches && isNotWaitingOnApproval(candidate),
  );
  if (activeCwdNotWaiting.length === 1) {
    return selection(activeCwdNotWaiting[0]!.threadId, 'heuristic-active-loaded-cwd-not-waiting-on-approval', 'medium');
  }

  const cwdMatches = candidates.filter((candidate) => candidate.cwdMatches);
  if (cwdMatches.length === 1) {
    return selection(cwdMatches[0]!.threadId, 'heuristic-loaded-cwd', 'low');
  }

  const activeNotWaiting = candidates.filter((candidate) => candidate.status === 'active' && isNotWaitingOnApproval(candidate));
  if (activeNotWaiting.length === 1) {
    return selection(activeNotWaiting[0]!.threadId, 'heuristic-active-loaded', 'low');
  }

  const storedMatches = storedCandidates.filter(
    (candidate) => typeof candidate.threadId === 'string' && candidate.cwdMatches && candidate.status !== 'active',
  );
  const storedMatch = storedMatches[0];
  if (storedMatches.length === 1 && typeof storedMatch?.threadId === 'string') {
    return selection(storedMatch.threadId, 'stored-thread-list', 'low');
  }

  return noSelection(candidates.length > 1 || storedCandidates.length > 1 || storedMatches.length > 1);
}

export async function buildThreadContextPayload(input: ThreadContextInput): Promise<Record<string, unknown>> {
  const url = resolveAppServerUrl(input.appServerUrl);
  const cwd = resolve(input.cwd ?? process.cwd());
  const marker = input.marker && input.marker.length > 0 ? input.marker : undefined;
  const includeStored = input.includeStored ?? false;
  const client = await connectAppServerClient({ url, requestTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  try {
    await client.initialize();
    const loaded = await client.listLoadedThreads();
    const candidates: ThreadContextCandidate[] = [];

    for (const threadId of loaded.threadIds) {
      try {
        const readResult = await client.readThread({ threadId, includeTurns: marker !== undefined });
        const summaryInput: {
          threadId: string;
          readResult: ThreadReadResult;
          requestedCwd: string;
          marker?: string;
        } = { threadId, readResult, requestedCwd: cwd };
        if (marker !== undefined) {
          summaryInput.marker = marker;
        }
        candidates.push(summarizeLoadedThreadRead(summaryInput));
      } catch (error) {
        candidates.push({
          threadId,
          status: null,
          activeFlags: null,
          cwdMatches: false,
          cwdPreview: null,
          markerMatched: false,
          turnCount: null,
          turnStatuses: null,
          hasInProgressTurn: null,
          lastAgentMessagePreview: null,
          error: redactValue(error instanceof Error ? error.message : String(error), { workspace: cwd }),
        });
      }
    }

    let storedCandidates: StoredThreadCandidate[] | undefined;
    if (includeStored) {
      const storedInput: {
        cwd: string;
        limit: number;
        searchTerm?: string;
      } = {
        cwd,
        limit: input.storedLimit ?? DEFAULT_STORED_LIMIT,
      };
      if (input.searchTerm !== undefined) {
        storedInput.searchTerm = input.searchTerm;
      }
      const stored = await client.listStoredThreads(storedInput);
      storedCandidates = stored.threads.map((entry) => summarizeStoredThread(entry, cwd));
    }

    const recommendation = selectThreadContextRecommendation(candidates, storedCandidates ?? []);
    const payload: Record<string, unknown> = {
      ok: true,
      appServerUrl: redactSensitiveText(url),
      recommendedThreadId: recommendation.recommendedThreadId,
      recommendedThreadIdSource: recommendation.recommendedThreadIdSource,
      recommendationConfidence: recommendation.recommendationConfidence,
      ambiguous: recommendation.ambiguous,
      loadedThreadIds: loaded.threadIds,
      candidates,
      notes: [
        'Use recommendedThreadId as diagnostic guidance; pass an explicit threadId before mutating a session.',
        'A unique marker match in loaded turns outranks active-only heuristics.',
        'Threads waitingOnApproval are deprioritized for active-thread heuristics.',
        'Stored-thread matches are low-confidence recovery hints; prefer loaded marker matches.',
      ],
    };
    if (storedCandidates !== undefined) {
      payload.storedCandidates = storedCandidates;
    }
    return payload;
  } finally {
    client.close();
  }
}
