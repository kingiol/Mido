import {
  safeValidateSchema,
  stableStringify,
  type AgentMessage,
  type JsonObject,
  type ModelProviderMetadata,
  type ModelUsage,
  type ToolDefinition
} from '@mido/protocol-core';

import type { ModelAdapterCapabilities } from '../capabilities.js';
import type { ModelAdapter, ModelAdapterEvent, ModelAdapterRunInput } from '../runner.js';

type OpenAICompatibleRole = 'system' | 'user' | 'assistant' | 'tool';

interface OpenAICompatibleToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAICompatibleMessage {
  role: OpenAICompatibleRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAICompatibleToolCall[];
}

interface PendingToolCallState {
  id: string;
  name: string;
  argumentsText: string;
}

interface OpenAICompatibleStreamChunk {
  id?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  choices?: Array<{
    index: number;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null | string;
    delta?: {
      role?: 'assistant' | null;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

export interface OpenAICompatibleModelAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  temperature?: number;
  includeUsage?: boolean;
  provider?: string;
  capabilities?: ModelAdapterCapabilities;
}

export function createOpenAICompatibleModelAdapter(options: OpenAICompatibleModelAdapterOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('OpenAI-compatible adapter requires a fetch implementation');
  }

  const provider = options.provider ?? 'openai-compatible';
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  return {
    metadata: {
      provider,
      model: options.model
    },
    capabilities: options.capabilities ?? createOpenAICompatibleCapabilities(provider, options.model),
    async run(input) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers
        },
        signal: input.signal,
        body: JSON.stringify(buildOpenAICompatibleRequest(input, {
          model: options.model,
          temperature: options.temperature,
          includeUsage: options.includeUsage
        }))
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI-compatible request failed with status ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('OpenAI-compatible response body is empty');
      }

      return normalizeOpenAICompatibleStream(response.body, input.tools, {
        provider,
        model: options.model,
        requestId: readOpenAICompatibleRequestId(response)
      });
    }
  };
}

export function createOpenAICompatibleCapabilities(provider: string, model: string): ModelAdapterCapabilities {
  return {
    provider,
    adapterKind: 'openai_compatible',
    models: [model],
    text: {
      streaming: true
    },
    reasoning: {
      streaming: 'unknown',
      resumePreservation: 'unknown'
    },
    tools: {
      calling: 'unknown',
      argumentStreaming: 'unknown',
      parallelCalls: 'unknown',
      strictSchema: 'unknown',
      resumeWithResults: 'unknown'
    },
    structuredOutput: {
      jsonMode: 'unknown',
      schema: 'unknown'
    },
    usage: {
      inputTokens: 'unknown',
      outputTokens: 'unknown',
      totalTokens: 'unknown',
      streamingFinal: 'unknown'
    },
    finishReason: {
      normalized: true
    },
    errors: {
      retryableNormalized: false
    },
    transport: {
      abortSignal: true,
      requestId: 'unknown'
    },
    knownGaps: ['OpenAI-compatible endpoints vary by provider; pass explicit capabilities for production checks']
  };
}

export function buildOpenAICompatibleRequest(
  input: ModelAdapterRunInput,
  options: {
    model: string;
    temperature?: number;
    includeUsage?: boolean;
  }
) {
  return {
    model: options.model,
    stream: true,
    messages: toOpenAICompatibleMessages(input.messages),
    tools: input.tools.length > 0 ? input.tools.map(toOpenAICompatibleTool) : undefined,
    tool_choice: input.tools.length > 0 ? 'auto' : undefined,
    stream_options: options.includeUsage === false ? undefined : {
      include_usage: true
    },
    temperature: options.temperature
  };
}

export async function* normalizeOpenAICompatibleStream(
  stream: ReadableStream<Uint8Array>,
  tools: ToolDefinition[],
  providerMetadata: ModelProviderMetadata = {
    provider: 'openai-compatible'
  }
): AsyncIterable<ModelAdapterEvent> {
  const pendingToolCalls = new Map<number, PendingToolCallState>();
  let textBuffer = '';
  let textId: string | undefined;
  let sawText = false;
  let usage: ModelUsage | undefined;

  for await (const payload of parseOpenAICompatibleSseStream(stream)) {
    const chunk = payload as OpenAICompatibleStreamChunk;
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    const delta = choice.delta;

    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      yield {
        type: 'reasoning-delta',
        delta: delta.reasoning_content
      };
    }

    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (!textId) {
        textId = `openai-compatible-text-${crypto.randomUUID()}`;
        yield {
          type: 'text-start',
          textId
        };
      }

      sawText = true;
      textBuffer += delta.content;
      yield {
        type: 'text-delta',
        textId,
        delta: delta.content
      };
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;
        const current = pendingToolCalls.get(index) ?? {
          id: '',
          name: '',
          argumentsText: ''
        };

        if (typeof toolCallDelta.id === 'string') {
          current.id = toolCallDelta.id;
        }

        if (typeof toolCallDelta.function?.name === 'string') {
          current.name += toolCallDelta.function.name;
        }

        if (typeof toolCallDelta.function?.arguments === 'string') {
          current.argumentsText += toolCallDelta.function.arguments;
        }

        pendingToolCalls.set(index, current);
      }
    }

    if (choice.finish_reason === 'tool_calls') {
      if (sawText && textId) {
        yield {
          type: 'text-end',
          textId,
          text: textBuffer
        };
      }

      for (const [, current] of [...pendingToolCalls.entries()].sort((left, right) => left[0] - right[0])) {
        const tool = tools.find(candidate => (candidate.modelName ?? candidate.name) === current.name);
        const parsedArgs = safeJsonParse(current.argumentsText);
        if (tool) {
          const validation = safeValidateSchema<JsonObject>(tool.inputSchema, parsedArgs);
          if (!validation.success) {
            throw new Error(`OpenAI-compatible provider returned invalid arguments for tool "${tool.name}": ${validation.errors}`);
          }
        }

        yield {
          type: 'tool-call',
          toolCallId: current.id || `openai-compatible-tool-${crypto.randomUUID()}`,
          ...(tool?.toolId ? { toolId: tool.toolId } : {}),
          toolName: tool?.name ?? current.name,
          modelName: current.name,
          args: parsedArgs,
          argsText: current.argumentsText
        };
      }

      yield {
        type: 'done',
        finishReason: 'tool_calls',
        providerMetadata: withOpenAICompatibleFinishMetadata(providerMetadata, 'tool_calls', usage)
      };
      return;
    }

    if (choice.finish_reason === 'stop') {
      if (sawText && textId) {
        yield {
          type: 'text-end',
          textId,
          text: textBuffer
        };
      }

      yield {
        type: 'done',
        finishReason: 'completed',
        providerMetadata: withOpenAICompatibleFinishMetadata(providerMetadata, 'stop', usage)
      };
      return;
    }

    if (choice.finish_reason) {
      yield {
        type: 'error',
        code: `openai_compatible_${choice.finish_reason}`,
        message: `OpenAI-compatible provider stopped with finish reason "${choice.finish_reason}"`,
        providerMetadata: withOpenAICompatibleFinishMetadata(providerMetadata, choice.finish_reason, usage)
      };
      return;
    }
  }

  if (sawText && textId) {
    yield {
      type: 'text-end',
      textId,
      text: textBuffer
    };
  }
}

export async function* parseOpenAICompatibleSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const data = chunk
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');

      if (!data || data === '[DONE]') {
        continue;
      }

      yield JSON.parse(data);
    }
  }

  if (buffer.trim()) {
    const data = buffer
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n');

    if (data && data !== '[DONE]') {
      yield JSON.parse(data);
    }
  }
}

function withOpenAICompatibleFinishMetadata(
  metadata: ModelProviderMetadata,
  rawFinishReason: string,
  usage: ModelUsage | undefined
): ModelProviderMetadata {
  return {
    ...metadata,
    rawFinishReason,
    ...(usage ? { usage } : {})
  };
}

function readOpenAICompatibleRequestId(response: Response): string | undefined {
  return (
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    response.headers.get('x-ratelimit-request-id') ??
    undefined
  );
}

function toOpenAICompatibleTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.modelName ?? tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function toOpenAICompatibleMessages(messages: AgentMessage[]): OpenAICompatibleMessage[] {
  return messages.flatMap<OpenAICompatibleMessage>(message => {
    const textContent = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (message.role === 'tool') {
      return message.content
        .filter(part => part.type === 'tool-result')
        .map(part => ({
          role: 'tool' as const,
          tool_call_id: part.toolCallId,
          content: typeof part.output === 'string' ? part.output : stableStringify(part.output)
        }));
    }

    if (message.role === 'assistant' || message.role === 'summary') {
      const toolCalls = message.content
        .filter(part => part.type === 'tool-call')
        .map(part => ({
          id: part.toolCallId,
          type: 'function' as const,
          function: {
            name: part.modelName ?? part.toolName,
            arguments: stableStringify(part.args)
          }
        }));

      return [
        {
          role: 'assistant' as const,
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        }
      ];
    }

    return [
      {
        role: message.role,
        content: textContent || ''
      }
    ];
  });
}

function safeJsonParse(value: string): JsonObject {
  if (!value.trim()) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI-compatible tool arguments must be a JSON object');
  }

  return parsed as JsonObject;
}
