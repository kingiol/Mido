import {
  safeValidateSchema,
  stableStringify,
  type AgentMessage,
  type JsonObject,
  type JsonValue,
  type ModelProviderMetadata,
  type ModelUsage,
  type ToolDefinition
} from '@mido-agent/protocol-core';

import type { ModelAdapterCapabilities } from '../capabilities.js';
import type { ModelAdapter, ModelAdapterEvent, ModelAdapterRunInput } from '../runner.js';

interface PendingResponseToolCallState {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
}

interface OpenAIResponsesStreamEvent {
  type?: string;
  item_id?: string;
  output_index?: number;
  delta?: string;
  text?: string;
  arguments?: string;
  call_id?: string;
  name?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    error?: {
      code?: string;
      message?: string;
    };
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface OpenAIResponsesModelAdapterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  temperature?: number;
  store?: boolean;
  previousResponseId?: string;
  capabilities?: ModelAdapterCapabilities;
}

export function createOpenAIResponsesModelAdapter(options: OpenAIResponsesModelAdapterOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('OpenAI Responses adapter requires a fetch implementation');
  }

  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  return {
    metadata: {
      provider: 'openai',
      model: options.model
    },
    capabilities: options.capabilities ?? createOpenAIResponsesCapabilities(options.model),
    async run(input) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
          ...options.headers
        },
        signal: input.signal,
        body: JSON.stringify(buildOpenAIResponsesRequest(input, {
          model: options.model,
          temperature: options.temperature,
          store: options.store,
          previousResponseId: options.previousResponseId
        }))
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI Responses request failed with status ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('OpenAI Responses response body is empty');
      }

      return normalizeOpenAIResponsesStream(response.body, input.tools, {
        provider: 'openai',
        model: options.model,
        requestId: readOpenAIResponseRequestId(response)
      });
    }
  };
}

export function createOpenAIResponsesCapabilities(model: string): ModelAdapterCapabilities {
  return {
    provider: 'openai',
    adapterKind: 'native',
    models: [model],
    text: {
      streaming: true
    },
    reasoning: {
      streaming: true,
      resumePreservation: true
    },
    tools: {
      calling: true,
      argumentStreaming: true,
      parallelCalls: true,
      strictSchema: true,
      resumeWithResults: true
    },
    structuredOutput: {
      jsonMode: true,
      schema: true
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
    }
  };
}

export function buildOpenAIResponsesRequest(
  input: ModelAdapterRunInput,
  options: {
    model: string;
    temperature?: number;
    store?: boolean;
    previousResponseId?: string;
  }
) {
  return {
    model: options.model,
    stream: true,
    input: toOpenAIResponsesInput(input.messages),
    tools: input.tools.length > 0 ? input.tools.map(toOpenAIResponsesTool) : undefined,
    temperature: options.temperature,
    store: options.store,
    previous_response_id: options.previousResponseId
  };
}

export async function* normalizeOpenAIResponsesStream(
  stream: ReadableStream<Uint8Array>,
  tools: ToolDefinition[],
  providerMetadata: ModelProviderMetadata = {
    provider: 'openai'
  }
): AsyncIterable<ModelAdapterEvent> {
  const pendingToolCalls = new Map<string, PendingResponseToolCallState>();
  let textBuffer = '';
  let textId: string | undefined;
  let sawText = false;
  let usage: ModelUsage | undefined;

  for await (const payload of parseOpenAIResponsesSseStream(stream)) {
    const event = payload as OpenAIResponsesStreamEvent;
    const eventType = event.type;

    if (eventType === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (!textId) {
        textId = `openai-response-text-${crypto.randomUUID()}`;
        yield {
          type: 'text-start',
          textId
        };
      }

      sawText = true;
      textBuffer += event.delta;
      yield {
        type: 'text-delta',
        textId,
        delta: event.delta
      };
      continue;
    }

    if (eventType === 'response.output_text.done' && typeof event.text === 'string') {
      textBuffer = event.text;
      continue;
    }

    if (isReasoningDeltaEvent(eventType) && typeof event.delta === 'string') {
      yield {
        type: 'reasoning-delta',
        delta: event.delta
      };
      continue;
    }

    if (eventType === 'response.function_call_arguments.delta') {
      const key = getResponseToolKey(event);
      const current = pendingToolCalls.get(key) ?? {
        id: key,
        callId: event.call_id ?? key,
        name: event.name ?? '',
        argumentsText: ''
      };
      if (typeof event.delta === 'string') {
        current.argumentsText += event.delta;
      }
      if (typeof event.call_id === 'string') {
        current.callId = event.call_id;
      }
      if (typeof event.name === 'string') {
        current.name = event.name;
      }
      pendingToolCalls.set(key, current);
      continue;
    }

    if (eventType === 'response.output_item.done' && event.item?.type === 'function_call') {
      const key = event.item.id ?? event.item.call_id ?? getResponseToolKey(event);
      const current = pendingToolCalls.get(key) ?? {
        id: key,
        callId: event.item.call_id ?? key,
        name: '',
        argumentsText: ''
      };
      current.callId = event.item.call_id ?? current.callId;
      current.name = event.item.name ?? current.name;
      current.argumentsText = event.item.arguments ?? current.argumentsText;
      pendingToolCalls.set(key, current);
      continue;
    }

    if (eventType === 'response.completed') {
      if (event.response?.usage) {
        usage = {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          totalTokens: event.response.usage.total_tokens
        };
      }

      if (sawText && textId) {
        yield {
          type: 'text-end',
          textId,
          text: textBuffer
        };
      }

      for (const current of pendingToolCalls.values()) {
        yield createToolCallEvent(current, tools);
      }

      yield {
        type: 'done',
        finishReason: pendingToolCalls.size > 0 ? 'tool_calls' : 'completed',
        providerMetadata: {
          ...providerMetadata,
          requestId: event.response?.id ?? providerMetadata.requestId,
          rawFinishReason: 'completed',
          ...(usage ? { usage } : {})
        }
      };
      return;
    }

    if (eventType === 'response.failed') {
      yield {
        type: 'error',
        code: event.response?.error?.code ?? event.error?.code ?? 'openai_response_failed',
        message: event.response?.error?.message ?? event.error?.message ?? 'OpenAI Responses request failed',
        providerMetadata
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

export async function* parseOpenAIResponsesSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
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

function createToolCallEvent(current: PendingResponseToolCallState, tools: ToolDefinition[]): ModelAdapterEvent {
  const tool = tools.find(candidate => (candidate.modelName ?? candidate.name) === current.name);
  const parsedArgs = safeJsonParse(current.argumentsText);
  if (tool) {
    const validation = safeValidateSchema<JsonObject>(tool.inputSchema, parsedArgs);
    if (!validation.success) {
      throw new Error(`OpenAI Responses returned invalid arguments for tool "${tool.name}": ${validation.errors}`);
    }
  }

  return {
    type: 'tool-call',
    toolCallId: current.callId || `openai-response-tool-${crypto.randomUUID()}`,
    ...(tool?.toolId ? { toolId: tool.toolId } : {}),
    toolName: tool?.name ?? current.name,
    modelName: current.name,
    args: parsedArgs,
    argsText: current.argumentsText
  };
}

function toOpenAIResponsesInput(messages: AgentMessage[]): JsonValue[] {
  return messages.flatMap<JsonValue>(message => {
    const textContent = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (message.role === 'tool') {
      return message.content
        .filter(part => part.type === 'tool-result')
        .map(part => ({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: typeof part.output === 'string' ? part.output : stableStringify(part.output)
        }));
    }

    if (message.role === 'assistant' || message.role === 'summary') {
      const items: JsonValue[] = [];
      if (textContent) {
        items.push({
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: textContent
            }
          ]
        });
      }

      for (const part of message.content) {
        if (part.type === 'tool-call') {
          items.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.modelName ?? part.toolName,
            arguments: stableStringify(part.args)
          });
        }
      }

      return items;
    }

    return [
      {
        role: message.role,
        content: [
          {
            type: 'input_text',
            text: textContent
          }
        ]
      }
    ];
  });
}

function toOpenAIResponsesTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    name: tool.modelName ?? tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true
  };
}

function isReasoningDeltaEvent(eventType: string | undefined): boolean {
  return (
    eventType === 'response.reasoning_text.delta' ||
    eventType === 'response.reasoning_summary_text.delta' ||
    eventType === 'response.reasoning.delta'
  );
}

function getResponseToolKey(event: OpenAIResponsesStreamEvent): string {
  if (event.item_id) {
    return event.item_id;
  }

  if (typeof event.output_index === 'number') {
    return `output-${event.output_index}`;
  }

  return event.call_id ?? 'tool-call';
}

function readOpenAIResponseRequestId(response: Response): string | undefined {
  return (
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    undefined
  );
}

function safeJsonParse(value: string): JsonObject {
  if (!value.trim()) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI Responses tool arguments must be a JSON object');
  }

  return parsed as JsonObject;
}
