import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CoreEvent } from '@mido-agent/protocol-core';
import { evaluateEventStore } from '@mido-agent/evaluator';

describe('evaluator store scanner', () => {
  it('evaluates real event store JSONL files without treating run errors as structural failures', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'mido-store-eval-'));
    await writeEvents(rootDir, ['threads', 'thread-ok', 'runs', 'run-ok', 'events.jsonl'], createCompletedEvents());
    await writeEvents(
      rootDir,
      ['scopes', 'scp-1', 'threads', 'thread-error', 'runs', 'run-error', 'events.jsonl'],
      createErrorEvents()
    );

    const result = await evaluateEventStore({
      rootDir,
      suiteId: 'store-real',
      createdAt: '2026-05-28T00:00:00.000Z'
    });

    expect(result.report).toMatchObject({
      suiteId: 'store-real',
      totalCases: 2,
      passedCases: 2,
      failedCaseCount: 0,
      successRate: 1
    });
    expect(result.report.aggregate.robustness.providerErrorCount).toBe(1);
    expect(result.report.aggregate.safety.policyDeniedCount).toBe(1);
    expect(result.runs.map(run => run.runId).sort()).toEqual(['run-error', 'run-ok']);
    expect(result.runs[0]?.events).toBeUndefined();
    expect(result.markdown).toContain('# Eval Suite: store-real');
  });

  it('can include raw events when explicitly requested', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'mido-store-eval-'));
    await writeEvents(rootDir, ['threads', 'thread-ok', 'runs', 'run-ok', 'events.jsonl'], createCompletedEvents());

    const result = await evaluateEventStore({
      rootDir,
      includeEvents: true
    });

    expect(result.runs[0]?.events).toHaveLength(3);
  });
});

function toJsonl(events: CoreEvent[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

async function writeEvents(rootDir: string, segments: string[], events: CoreEvent[]): Promise<void> {
  const filePath = path.join(rootDir, ...segments);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, toJsonl(events));
}

function createCompletedEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-1',
      runId: 'run-ok',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z',
      threadId: 'thread-ok'
    },
    {
      type: 'MODEL_CALL_END',
      eventId: 'evt-2',
      runId: 'run-ok',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      modelCallId: 'model-1',
      status: 'completed',
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5
      }
    },
    {
      type: 'RUN_FINISHED',
      eventId: 'evt-3',
      runId: 'run-ok',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      finishReason: 'completed'
    }
  ];
}

function createErrorEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-e1',
      runId: 'run-error',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z',
      threadId: 'thread-error'
    },
    {
      type: 'MODEL_CALL_END',
      eventId: 'evt-e2',
      runId: 'run-error',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      modelCallId: 'model-1',
      status: 'error'
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-e3',
      runId: 'run-error',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      trace: {
        traceId: 'run-error',
        spanId: 'msg-2',
        name: 'RUN_ERROR',
        kind: 'run',
        attributes: {
          source: 'provider'
        }
      },
      error: {
        code: 'tool_policy_denied',
        message: 'Tool policy denied destructive action'
      }
    }
  ];
}
