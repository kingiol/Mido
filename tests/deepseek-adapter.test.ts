import { buildDeepSeekRequest, normalizeDeepSeekStream } from '@mido/server-sdk';
import { normalizeToolDefinition, type AgentMessage, type ToolDefinition } from '@mido/protocol-core';

const weatherTool: ToolDefinition = {
  name: 'getWeather',
  description: 'Look up a city weather report.',
  executionPolicy: 'server',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string' }
    },
    required: ['city']
  },
  resultSchema: {
    type: 'object'
  }
};

describe('deepseek adapter', () => {
  it('builds DeepSeek request bodies from protocol messages', () => {
    const messages: AgentMessage[] = [
      {
        id: 'msg-system',
        role: 'system',
        createdAt: '2026-04-23T00:00:00.000Z',
        content: [{ type: 'text', text: 'Use tools.' }]
      },
      {
        id: 'msg-user',
        role: 'user',
        createdAt: '2026-04-23T00:00:01.000Z',
        content: [{ type: 'text', text: 'weather in shanghai' }]
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        createdAt: '2026-04-23T00:00:02.000Z',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'getWeather',
            args: { city: 'Shanghai' },
            executionPolicy: 'server'
          },
          {
            type: 'reasoning',
            text: 'Need to call the weather tool.'
          }
        ]
      },
      {
        id: 'msg-tool',
        role: 'tool',
        createdAt: '2026-04-23T00:00:03.000Z',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'getWeather',
            output: { city: 'Shanghai', summary: 'sunny' }
          }
        ]
      }
    ];

    const payload = buildDeepSeekRequest(
      {
        runId: 'run-1',
        messages,
        tools: [weatherTool],
        state: {}
      },
      {
        model: 'deepseek-v4-flash'
      }
    );

    expect(payload.messages).toEqual([
      { role: 'system', content: 'Use tools.' },
      { role: 'user', content: 'weather in shanghai' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'Need to call the weather tool.',
        tool_calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'getWeather',
              arguments: '{"city":"Shanghai"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'tool-1',
        content: '{"city":"Shanghai","summary":"sunny"}'
      }
    ]);
    expect(payload.tools).toHaveLength(1);
  });

  it('passes explicit thinking options through to DeepSeek requests', () => {
    const payload = buildDeepSeekRequest(
      {
        runId: 'run-1',
        messages: [
          {
            id: 'msg-user',
            role: 'user',
            createdAt: '2026-04-23T00:00:01.000Z',
            content: [{ type: 'text', text: 'weather in shanghai' }]
          }
        ],
        tools: [weatherTool],
        state: {}
      },
      {
        model: 'deepseek-v4-flash',
        thinking: {
          type: 'enabled'
        }
      }
    );

    expect(payload.thinking).toEqual({
      type: 'enabled'
    });
  });

  it('uses model names for tools exposed to DeepSeek', () => {
    const serverTool = normalizeToolDefinition({
      ...weatherTool,
      name: 'toolA',
      executionPolicy: 'server'
    });
    const clientTool = normalizeToolDefinition({
      ...weatherTool,
      name: 'toolA',
      executionPolicy: 'client_interactive'
    });

    const payload = buildDeepSeekRequest(
      {
        runId: 'run-1',
        messages: [],
        tools: [serverTool, clientTool],
        state: {}
      },
      {
        model: 'deepseek-v4-flash'
      }
    );

    expect(payload.tools?.map(tool => tool.function.name)).toEqual(['server__toolA', 'client__toolA']);
  });

  it('maps summary messages to assistant messages for DeepSeek requests', () => {
    const payload = buildDeepSeekRequest(
      {
        runId: 'run-1',
        messages: [
          textMessage('summary', 'Summary.', 'summary-1'),
          textMessage('user', 'Recent question.', 'user-1')
        ],
        tools: [],
        state: {}
      },
      {
        model: 'deepseek-v4-flash'
      }
    );

    expect(payload.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Summary.' }),
      expect.objectContaining({ role: 'user', content: 'Recent question.' })
    ]);
  });

  it('normalizes streamed text chunks from DeepSeek SSE', async () => {
    const events = await collect(
      normalizeDeepSeekStream(
        toReadableStream([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        []
      )
    );

    expect(events.map(event => event.type)).toEqual(['text-start', 'text-delta', 'text-delta', 'text-end', 'done']);
    expect(events.at(-2)).toMatchObject({
      type: 'text-end',
      text: 'Hello world'
    });
  });

  it('merges streamed tool call deltas from DeepSeek SSE', async () => {
    const events = await collect(
      normalizeDeepSeekStream(
        toReadableStream([
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'getWeather',
                        arguments: '{"city":"Sh'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: 'anghai"}'
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        [weatherTool]
      )
    );

    expect(events).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'getWeather',
        modelName: 'getWeather',
        args: { city: 'Shanghai' },
        argsText: '{"city":"Shanghai"}'
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        providerMetadata: {
          provider: 'deepseek',
          rawFinishReason: 'tool_calls'
        }
      }
    ]);
  });

  it('normalizes streamed model tool names back to SDK tool identities', async () => {
    const clientTool = normalizeToolDefinition({
      ...weatherTool,
      name: 'toolA',
      executionPolicy: 'client_interactive'
    });

    const events = await collect(
      normalizeDeepSeekStream(
        toReadableStream([
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'client__toolA',
                        arguments: '{"city":"Shanghai"}'
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        [clientTool]
      )
    );

    expect(events).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolId: 'client:toolA',
        toolName: 'toolA',
        modelName: 'client__toolA',
        args: { city: 'Shanghai' },
        argsText: '{"city":"Shanghai"}'
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        providerMetadata: {
          provider: 'deepseek',
          rawFinishReason: 'tool_calls'
        }
      }
    ]);
  });

  it('preserves streamed reasoning content before tool calls', async () => {
    const events = await collect(
      normalizeDeepSeekStream(
        toReadableStream([
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'Need weather data. ',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'getWeather',
                        arguments: '{"city":"Shanghai"}'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'Call the tool.'
                },
                finish_reason: 'tool_calls'
              }
            ]
          })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        [weatherTool]
      )
    );

    expect(events).toEqual([
      {
        type: 'reasoning-delta',
        delta: 'Need weather data. '
      },
      {
        type: 'reasoning-delta',
        delta: 'Call the tool.'
      },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'getWeather',
        modelName: 'getWeather',
        args: { city: 'Shanghai' },
        argsText: '{"city":"Shanghai"}'
      },
      {
        type: 'done',
        finishReason: 'tool_calls',
        providerMetadata: {
          provider: 'deepseek',
          rawFinishReason: 'tool_calls'
        }
      }
    ]);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

function toReadableStream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    }
  });
}

function textMessage(role: AgentMessage['role'], text: string, id: string): AgentMessage {
  return {
    id,
    role,
    createdAt: '2026-05-09T00:00:00.000Z',
    content: [{ type: 'text', text }]
  };
}
