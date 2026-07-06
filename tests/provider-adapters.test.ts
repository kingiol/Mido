import {
  buildOpenAICompatibleRequest,
  buildOpenAIResponsesRequest,
  createDeepSeekModelAdapter,
  createOpenAICompatibleCapabilities,
  createOpenAICompatibleModelAdapter,
  createOpenAIResponsesCapabilities,
  createOpenAIResponsesModelAdapter,
  createVercelAiModelAdapter,
  normalizeOpenAICompatibleStream,
  normalizeOpenAIResponsesStream
} from '@mido-agent/server-sdk';
import { normalizeToolDefinition, type AgentMessage, type ToolDefinition } from '@mido-agent/protocol-core';

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

const messages: AgentMessage[] = [
  {
    id: 'msg-user',
    role: 'user',
    createdAt: '2026-04-23T00:00:01.000Z',
    content: [{ type: 'text', text: 'weather in shanghai' }]
  }
];

describe('provider adapters', () => {
  it('lets Vercel AI adapter receive caller-provided capabilities', () => {
    const adapter = createVercelAiModelAdapter({
      stream: () => ({ fullStream: toAsyncIterable([{ type: 'finish' }]) }),
      providerMetadata: {
        provider: 'vercel-ai',
        model: 'test-model'
      },
      capabilities: {
        provider: 'vercel-ai',
        adapterKind: 'framework_adapter',
        models: ['test-model'],
        tools: {
          calling: true
        }
      }
    });

    expect(adapter.capabilities).toMatchObject({
      provider: 'vercel-ai',
      adapterKind: 'framework_adapter',
      tools: {
        calling: true
      }
    });
  });

  it('declares different DeepSeek capabilities based on V4 thinking mode', () => {
    const flash = createDeepSeekModelAdapter({
      apiKey: 'test',
      model: 'deepseek-v4-flash',
      fetch: createUnusedFetch()
    });
    const thinking = createDeepSeekModelAdapter({
      apiKey: 'test',
      model: 'deepseek-v4-pro',
      thinking: {
        type: 'enabled'
      },
      fetch: createUnusedFetch()
    });

    expect(flash.capabilities).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-v4-flash'],
      limits: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000
      },
      tools: {
        resumeWithResults: true
      },
      reasoning: {
        resumePreservation: false
      }
    });
    expect(thinking.capabilities).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-v4-pro'],
      limits: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000
      },
      tools: {
        resumeWithResults: false
      },
      reasoning: {
        resumePreservation: 'required_but_missing'
      }
    });
  });

  it('builds OpenAI-compatible Chat Completions requests with model tool names', () => {
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

    const payload = buildOpenAICompatibleRequest(
      {
        runId: 'run-1',
        messages,
        tools: [serverTool, clientTool],
        state: {}
      },
      {
        model: 'gpt-compatible'
      }
    );

    expect(payload).toMatchObject({
      model: 'gpt-compatible',
      stream: true,
      tool_choice: 'auto'
    });
    expect(payload.tools?.map(tool => tool.function.name)).toEqual(['server__toolA', 'client__toolA']);
  });

  it('maps summary messages to assistant messages for OpenAI-compatible requests', () => {
    const payload = buildOpenAICompatibleRequest(
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
        model: 'gpt-compatible'
      }
    );

    expect(payload.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Summary.' }),
      expect.objectContaining({ role: 'user', content: 'Recent question.' })
    ]);
  });

  it('normalizes OpenAI-compatible streamed tool calls', async () => {
    const events = await collect(
      normalizeOpenAICompatibleStream(
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
          provider: 'openai-compatible',
          rawFinishReason: 'tool_calls'
        }
      }
    ]);
  });

  it('keeps OpenAI-compatible default capabilities conservative', () => {
    const capabilities = createOpenAICompatibleCapabilities('litellm', 'gpt-4.1');
    const adapter = createOpenAICompatibleModelAdapter({
      provider: 'litellm',
      model: 'gpt-4.1',
      baseUrl: 'http://localhost:4000/v1',
      fetch: createUnusedFetch()
    });

    expect(capabilities.tools?.calling).toBe('unknown');
    expect(adapter.capabilities).toMatchObject({
      provider: 'litellm',
      adapterKind: 'openai_compatible',
      tools: {
        calling: 'unknown'
      }
    });
  });

  it('builds OpenAI Responses requests with typed tool result items', () => {
    const payload = buildOpenAIResponsesRequest(
      {
        runId: 'run-1',
        messages: [
          ...messages,
          {
            id: 'msg-assistant',
            role: 'assistant',
            createdAt: '2026-04-23T00:00:02.000Z',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'getWeather',
                modelName: 'getWeather',
                args: { city: 'Shanghai' },
                executionPolicy: 'server'
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
        ],
        tools: [weatherTool],
        state: {}
      },
      {
        model: 'gpt-5.1'
      }
    );

    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'getWeather',
        description: 'Look up a city weather report.',
        parameters: weatherTool.inputSchema,
        strict: true
      }
    ]);
    expect(payload.input).toContainEqual({
      type: 'function_call',
      call_id: 'tool-1',
      name: 'getWeather',
      arguments: '{"city":"Shanghai"}'
    });
    expect(payload.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'tool-1',
      output: '{"city":"Shanghai","summary":"sunny"}'
    });
  });

  it('maps summary messages to assistant input items for OpenAI Responses requests', () => {
    const payload = buildOpenAIResponsesRequest(
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
        model: 'gpt-5.1'
      }
    );

    expect(payload.input).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Summary.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Recent question.'
          }
        ]
      }
    ]);
  });

  it('normalizes OpenAI Responses streamed text, reasoning, and function calls', async () => {
    const events = await collect(
      normalizeOpenAIResponsesStream(
        toReadableStream([
          `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'Need weather data.' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Checking' })}\n\n`,
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              id: 'item-1',
              type: 'function_call',
              call_id: 'call-1',
              name: 'getWeather',
              arguments: '{"city":"Shanghai"}'
            }
          })}\n\n`,
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-1',
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15
              }
            }
          })}\n\n`,
          'data: [DONE]\n\n'
        ]),
        [weatherTool]
      )
    );

    expect(events).toEqual([
      {
        type: 'reasoning-delta',
        delta: 'Need weather data.'
      },
      expect.objectContaining({
        type: 'text-start'
      }),
      expect.objectContaining({
        type: 'text-delta',
        delta: 'Checking'
      }),
      expect.objectContaining({
        type: 'text-end',
        text: 'Checking'
      }),
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
          provider: 'openai',
          requestId: 'resp-1',
          rawFinishReason: 'completed',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        }
      }
    ]);
  });

  it('declares OpenAI Responses as a native high-capability adapter', () => {
    const capabilities = createOpenAIResponsesCapabilities('gpt-5.1');
    const adapter = createOpenAIResponsesModelAdapter({
      apiKey: 'test',
      model: 'gpt-5.1',
      fetch: createUnusedFetch()
    });

    expect(capabilities).toMatchObject({
      provider: 'openai',
      adapterKind: 'native',
      tools: {
        calling: true,
        resumeWithResults: true
      },
      reasoning: {
        resumePreservation: true
      }
    });
    expect(adapter.capabilities).toMatchObject(capabilities);
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

function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

function createUnusedFetch(): typeof fetch {
  return (() => {
    throw new Error('fetch should not be called in this test');
  }) as typeof fetch;
}

function textMessage(role: AgentMessage['role'], text: string, id: string): AgentMessage {
  return {
    id,
    role,
    createdAt: '2026-05-09T00:00:00.000Z',
    content: [{ type: 'text', text }]
  };
}
