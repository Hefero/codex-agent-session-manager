import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectThreadContextRecommendation,
  summarizeLoadedThreadRead,
  summarizeStoredThread,
  type StoredThreadCandidate,
  type ThreadContextCandidate,
} from '../src/tools/thread-context.js';

const requestedCwd = 'C:\\Users\\Alice\\repo';

function candidate(input: Partial<ThreadContextCandidate> & { threadId: string }): ThreadContextCandidate {
  return {
    status: null,
    activeFlags: null,
    cwdMatches: false,
    cwdPreview: null,
    markerMatched: false,
    turnCount: null,
    turnStatuses: null,
    hasInProgressTurn: null,
    lastAgentMessagePreview: null,
    ...input,
  };
}

function stored(input: Partial<StoredThreadCandidate> & { threadId: string }): StoredThreadCandidate {
  return {
    namePreview: null,
    preview: null,
    status: null,
    activeFlags: null,
    cwdMatches: false,
    cwdPreview: null,
    createdAt: null,
    updatedAt: null,
    sourceKind: null,
    ephemeral: null,
    ...input,
  };
}

test('summarizeLoadedThreadRead reports redacted cwd, marker, turns, and message preview', () => {
  const summary = summarizeLoadedThreadRead({
    threadId: 'thread-marker',
    requestedCwd,
    marker: 'unique-marker',
    readResult: {
      thread: {
        cwd: requestedCwd,
        status: { type: 'active', activeFlags: ['busy'] },
        turns: [
          {
            status: 'completed',
            items: [{ type: 'userMessage', text: 'contains unique-marker' }],
          },
          {
            status: 'inProgress',
            items: [{ type: 'agentMessage', text: 'token=secret C:\\Users\\Alice\\repo\\file.ts' }],
          },
        ],
      },
    },
  });

  assert.equal(summary.threadId, 'thread-marker');
  assert.equal(summary.status, 'active');
  assert.deepEqual(summary.activeFlags, ['busy']);
  assert.equal(summary.cwdMatches, true);
  assert.equal(summary.cwdPreview, '<requested-cwd>');
  assert.equal(summary.markerMatched, true);
  assert.equal(summary.turnCount, 2);
  assert.deepEqual(summary.turnStatuses, ['completed', 'inProgress']);
  assert.equal(summary.hasInProgressTurn, true);
  assert.equal(summary.lastAgentMessagePreview, 'token=<redacted> <path:redacted>');
});

test('summarizeStoredThread redacts previews and marks cwd matches', () => {
  const summary = summarizeStoredThread(
    {
      id: 'stored-a',
      name: 'secret=hidden',
      preview: 'C:\\Users\\Alice\\repo\\notes token=hidden',
      cwd: requestedCwd,
      status: { type: 'archived', activeFlags: ['paused'] },
      createdAt: '2026-06-05T00:00:00Z',
      updatedAt: '2026-06-06T00:00:00Z',
      sourceKind: 'local',
      ephemeral: false,
    },
    requestedCwd,
  );

  assert.equal(summary.threadId, 'stored-a');
  assert.equal(summary.namePreview, 'secret=<redacted>');
  assert.equal(summary.preview, '<path:redacted> token=<redacted>');
  assert.equal(summary.cwdMatches, true);
  assert.equal(summary.cwdPreview, '<requested-cwd>');
});

test('marker match outranks active cwd heuristic', () => {
  const result = selectThreadContextRecommendation([
    candidate({ threadId: 'active-thread', status: 'active', cwdMatches: true }),
    candidate({ threadId: 'marker-thread', status: 'completed', cwdMatches: false, markerMatched: true }),
  ]);

  assert.deepEqual(result, {
    recommendedThreadId: 'marker-thread',
    recommendedThreadIdSource: 'loaded-marker-match',
    recommendationConfidence: 'high',
    ambiguous: false,
  });
});

test('stored candidate is a low-confidence recovery hint after loaded heuristics fail', () => {
  const result = selectThreadContextRecommendation(
    [
      candidate({ threadId: 'loaded-a', status: 'completed', cwdMatches: false }),
      candidate({ threadId: 'loaded-b', status: 'completed', cwdMatches: false }),
    ],
    [stored({ threadId: 'stored-a', status: 'completed', cwdMatches: true })],
  );

  assert.deepEqual(result, {
    recommendedThreadId: 'stored-a',
    recommendedThreadIdSource: 'stored-thread-list',
    recommendationConfidence: 'low',
    ambiguous: false,
  });
});

test('multiple marker matches are ambiguous', () => {
  const result = selectThreadContextRecommendation([
    candidate({ threadId: 'marker-a', markerMatched: true }),
    candidate({ threadId: 'marker-b', markerMatched: true }),
  ]);

  assert.deepEqual(result, {
    recommendedThreadId: null,
    recommendedThreadIdSource: null,
    recommendationConfidence: null,
    ambiguous: true,
  });
});
