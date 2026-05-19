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

type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';

interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

interface DeepSeekThinkingOptions {
  type: 'enabled' | 'disabled';
}

interface DeepSeekStreamChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  choices?: Array<{
    index: number;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource' | null;
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

interface PendingToolCallState {
  id: string;
  name: string;
  argumentsText: string;
}

type DeepSeekModelLimits = NonNullable<ModelAdapterCapabilities['limits']>;

const DEEPSEEK_MODEL_LIMITS: Record<string, DeepSeekModelLimits> = {
  'deepseek-v4-flash': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000
  },
  'deepseek-v4-pro': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000
  }
};

export interface DeepSeekModelAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  temperature?: number;
  thinking?: DeepSeekThinkingOptions;
  includeUsage?: boolean;
  capabilities?: ModelAdapterCapabilities;
}

export function createDeepSeekModelAdapter(options: DeepSeekModelAdapterOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('DeepSeek adapter requires a fetch implementation');
  }

  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = options.model ?? 'deepseek-v4-flash';

  return {
    metadata: {
      provider: 'deepseek',
      model
    },
    capabilities: options.capabilities ?? createDeepSeekModelCapabilities(model, options.thinking),
    async run(input) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`
        },
        signal: input.signal,
        body: JSON.stringify(buildDeepSeekRequest(input, {
          model,
          temperature: options.temperature,
          thinking: options.thinking,
          includeUsage: options.includeUsage
        }))
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`DeepSeek request failed with status ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('DeepSeek response body is empty');
      }

      return normalizeDeepSeekStream(response.body, input.tools, {
        provider: 'deepseek',
        model,
        requestId: readDeepSeekRequestId(response)
      });
    }
  };
}

export function createDeepSeekModelCapabilities(
  model: string,
  thinking?: DeepSeekThinkingOptions
): ModelAdapterCapabilities {
  const reasoningEnabled = thinking?.type === 'enabled';
  const limits = DEEPSEEK_MODEL_LIMITS[model];

  return {
    provider: 'deepseek',
    adapterKind: 'native',
    models: [model],
    text: {
      streaming: true
    },
    reasoning: {
      streaming: reasoningEnabled,
      resumePreservation: reasoningEnabled ? 'required_but_missing' : false
    },
    tools: {
      calling: true,
      argumentStreaming: true,
      parallelCalls: true,
      strictSchema: false,
      resumeWithResults: reasoningEnabled ? false : true
    },
    structuredOutput: {
      jsonMode: 'unknown',
      schema: false
    },
    usage: {
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      streamingFinal: true
    },
    finishReason: {
      normalized: true
    },
    errors: {
      retryableNormalized: false
    },
    transport: {
      abortSignal: true,
      requestId: true
    },
    ...(limits ? { limits: { ...limits } } : {}),
    knownGaps: reasoningEnabled
      ? ['deepseek reasoning tool resume is blocked until reasoning preservation is fully supported']
      : undefined
  };
}

export function buildDeepSeekRequest(
  input: ModelAdapterRunInput,
  options: {
    model: string;
    temperature?: number;
    thinking?: DeepSeekThinkingOptions;
    includeUsage?: boolean;
  }
) {
  return {
    model: options.model,
    stream: true,
    messages: toDeepSeekMessages(input.messages),
    tools: input.tools.length > 0 ? input.tools.map(toDeepSeekTool) : undefined,
    tool_choice: input.tools.length > 0 ? 'auto' : undefined,
    stream_options: options.includeUsage === false ? undefined : {
      include_usage: true
    },
    temperature: options.temperature,
    thinking: options.thinking
  };
}

export async function* normalizeDeepSeekStream(
  stream: ReadableStream<Uint8Array>,
  tools: ToolDefinition[],
  providerMetadata: ModelProviderMetadata = {
    provider: 'deepseek'
  }
): AsyncIterable<ModelAdapterEvent> {
  const pendingToolCalls = new Map<number, PendingToolCallState>();
  let textBuffer = '';
  let textId: string | undefined;
  let sawText = false;
  let usage: ModelUsage | undefined;

  for await (const payload of parseDeepSeekSseStream(stream)) {
    const chunk = payload as DeepSeekStreamChunk;
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
        textId = `deepseek-text-${crypto.randomUUID()}`;
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
            throw new Error(`DeepSeek returned invalid arguments for tool "${tool.name}": ${validation.errors}`);
          }
        }

        yield {
          type: 'tool-call',
          toolCallId: current.id || `deepseek-tool-${crypto.randomUUID()}`,
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
        providerMetadata: withDeepSeekFinishMetadata(providerMetadata, 'tool_calls', usage)
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
        providerMetadata: withDeepSeekFinishMetadata(providerMetadata, 'stop', usage)
      };
      return;
    }

    if (choice.finish_reason && choice.finish_reason !== 'length') {
      yield {
        type: 'error',
        code: `deepseek_${choice.finish_reason}`,
        message: `DeepSeek stopped with finish reason "${choice.finish_reason}"`,
        providerMetadata: withDeepSeekFinishMetadata(providerMetadata, choice.finish_reason, usage)
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

function withDeepSeekFinishMetadata(
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

function readDeepSeekRequestId(response: Response): string | undefined {
  return (
    response.headers.get('x-ds-request-id') ??
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    undefined
  );
}

export async function* parseDeepSeekSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
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

function toDeepSeekTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.modelName ?? tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function toDeepSeekMessages(messages: AgentMessage[]): DeepSeekMessage[] {
  return messages.flatMap<DeepSeekMessage>(message => {
    const textContent = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim();
    const reasoningContent = message.content
      .filter(part => part.type === 'reasoning')
      .map(part => part.text)
      .join('');

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
          reasoning_content: reasoningContent || undefined,
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
    throw new Error('DeepSeek tool arguments must be a JSON object');
  }

  return parsed as JsonObject;
}
