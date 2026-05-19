// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';

import { createAgentClient, type AgentTransport } from '@mido/client-core';
import { createBrowserSseTransport, usePendingInteractiveTools } from '@mido/client-web';
import type { CoreEvent, RunResumeRequest, RunStartRequest } from '@mido/protocol-core';

const approvalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' }
  },
  required: ['approved']
} as const;

describe('client-web', () => {
  it('exposes pending interactive tools through hooks', async () => {
    const resumeRequests: RunResumeRequest[] = [];
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:confirm',
            toolName: 'confirm',
            modelName: 'client__confirm',
            toolRuntime: 'client',
            executionPolicy: 'client_interactive',
            args: { approved: false }
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request: RunResumeRequest) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('TOOL_RESULT', {
            toolCallId: 'tool-1',
            toolName: 'confirm',
            output: request.toolResult.output
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'confirm',
      description: 'User confirmation',
      executionPolicy: 'client_interactive',
      inputSchema: approvalSchema,
      resultSchema: approvalSchema,
      execute: async () => ({ approved: true })
    });

    const { result } = renderHook(() => usePendingInteractiveTools(client));

    await act(async () => {
      await client.startRun({ messages: [] });
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    await act(async () => {
      await client.approveToolCall('tool-1');
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(0);
    });
    expect(resumeRequests).toHaveLength(1);
  });

  it('parses SSE event streams over fetch transport', async () => {
    const transport = createBrowserSseTransport({
      runUrl: '/run',
      resumeUrl: '/resume',
      fetch: async () =>
        new Response(
          toReadableStream(
            [
              `data: ${JSON.stringify(createEvent('RUN_STARTED', {}))}\n\n`,
              `data: ${JSON.stringify(createEvent('RUN_FINISHED', { finishReason: 'completed' }))}\n\n`
            ].join('')
          ),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          }
        )
    });

    const events = await collect(await transport.startRun({ messages: [] }));
    expect(events.map(event => event.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });
});

function createEvent<T extends CoreEvent['type']>(type: T, payload: Omit<Extract<CoreEvent, { type: T }>, 'type' | 'eventId' | 'runId' | 'messageId' | 'sequence' | 'timestamp'>): CoreEvent {
  return {
    type,
    eventId: `evt-${Math.random()}`,
    runId: 'run-1',
    messageId: 'msg-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    ...payload
  } as CoreEvent;
}

function streamOf(events: CoreEvent[]): AsyncIterable<CoreEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

function toReadableStream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
