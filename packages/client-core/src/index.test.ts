import { describe, expect, it } from 'vitest';

import { createAgentClient, type AgentClientSnapshot, type AgentTransport } from './index.js';
import type { CoreEvent } from '@mido/protocol-core';

const runId = 'run_test';
const messageId = 'msg_assistant';
const textId = 'text_assistant';
const timestamp = '2026-04-28T00:00:00.000Z';

describe('AgentClientRuntime text streaming', () => {
  it('updates textTranscript from TEXT_DELTA events before the run finishes', async () => {
    const snapshots: AgentClientSnapshot[] = [];
    const client = createAgentClient({
      transport: createStaticTransport([
        {
          ...baseEvent(1),
          type: 'RUN_STARTED',
          threadId: 'thread_test'
        },
        {
          ...baseEvent(2),
          type: 'TEXT_START',
          textId,
          role: 'assistant'
        },
        {
          ...baseEvent(3),
          type: 'TEXT_DELTA',
          textId,
          delta: 'Hello'
        },
        {
          ...baseEvent(4),
          type: 'TEXT_DELTA',
          textId,
          delta: ' world'
        },
        {
          ...baseEvent(5),
          type: 'TEXT_END',
          textId,
          text: 'Hello world'
        },
        {
          ...baseEvent(6),
          type: 'RUN_FINISHED',
          finishReason: 'completed'
        }
      ])
    });

    client.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    await client.sendMessage('Say hello');

    expect(snapshots.some((snapshot) => snapshot.textTranscript === 'Hello')).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.textTranscript === 'Hello world')).toBe(true);
    expect(client.getSnapshot().textTranscript).toBe('Hello world');
    expect(client.getSnapshot().conversationMessages.at(-1)?.content).toEqual([
      {
        type: 'text',
        text: 'Hello world'
      }
    ]);
  });

  it('keeps TEXT_END as a fallback when no deltas were received', async () => {
    const client = createAgentClient({
      transport: createStaticTransport([
        {
          ...baseEvent(1),
          type: 'RUN_STARTED',
          threadId: 'thread_test'
        },
        {
          ...baseEvent(2),
          type: 'TEXT_END',
          textId,
          text: 'Final text'
        },
        {
          ...baseEvent(3),
          type: 'RUN_FINISHED',
          finishReason: 'completed'
        }
      ])
    });

    await client.sendMessage('Say hello');

    expect(client.getSnapshot().textTranscript).toBe('Final text');
    expect(client.getSnapshot().conversationMessages.at(-1)?.content).toEqual([
      {
        type: 'text',
        text: 'Final text'
      }
    ]);
  });
});

function baseEvent(sequence: number) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    runId,
    messageId,
    timestamp
  };
}

function createStaticTransport(events: CoreEvent[]): AgentTransport {
  return {
    startRun: () => streamEvents(events),
    resume: () => streamEvents([])
  };
}

async function* streamEvents(events: CoreEvent[]): AsyncIterable<CoreEvent> {
  for (const event of events) {
    yield event;
  }
}
