import type { JsonObject, ModelProviderMetadata, ModelUsage, ToolDefinition } from '@mido-agent/protocol-core';

import type { ModelAdapterCapabilities } from '../capabilities.js';
import type { ModelAdapter, ModelAdapterEvent, ModelAdapterRunInput } from '../runner.js';

export interface VercelAiStreamResult {
  fullStream: AsyncIterable<Record<string, unknown>>;
}

export interface VercelAiAdapterOptions {
  stream: (input: ModelAdapterRunInput & { tools: ToolDefinition[] }) => Promise<VercelAiStreamResult> | VercelAiStreamResult;
  providerMetadata?: ModelProviderMetadata;
  capabilities?: ModelAdapterCapabilities;
}

export function createVercelAiModelAdapter(options: VercelAiAdapterOptions): ModelAdapter {
  return {
    metadata: options.providerMetadata,
    capabilities: options.capabilities,
    async run(input) {
      const result = await options.stream({
        ...input,
        tools: input.tools
      });

      return normalizeVercelAiStream(result.fullStream, options.providerMetadata);
    }
  };
}

export async function* normalizeVercelAiStream(
  stream: AsyncIterable<Record<string, unknown>>,
  providerMetadata?: ModelProviderMetadata
): AsyncIterable<ModelAdapterEvent> {
  const seenToolCalls = new Set<string>();
  const toolArgsText = new Map<string, string>();

  for await (const part of stream) {
    switch (part.type) {
      case 'text-start':
        yield {
          type: 'text-start',
          textId: readOptionalString(part, 'id') ?? readOptionalString(part, 'textId')
        };
        break;
      case 'text-delta':
        yield {
          type: 'text-delta',
          textId: readOptionalString(part, 'id') ?? readOptionalString(part, 'textId'),
          delta: readOptionalString(part, 'textDelta') ?? readOptionalString(part, 'delta') ?? ''
        };
        break;
      case 'text-end':
        yield {
          type: 'text-end',
          textId: readOptionalString(part, 'id') ?? readOptionalString(part, 'textId'),
          text: readOptionalString(part, 'text')
        };
        break;
      case 'tool-input-delta': {
        const toolCallId = readRequiredString(part, 'toolCallId');
        const delta = readOptionalString(part, 'inputTextDelta') ?? readOptionalString(part, 'delta') ?? '';
        toolArgsText.set(toolCallId, `${toolArgsText.get(toolCallId) ?? ''}${delta}`);
        break;
      }
      case 'tool-input-available':
      case 'tool-call': {
        const toolCallId = readOptionalString(part, 'toolCallId') ?? readRequiredString(part, 'id');
        if (seenToolCalls.has(toolCallId)) {
          break;
        }

        seenToolCalls.add(toolCallId);
        yield {
          type: 'tool-call',
          toolCallId,
          toolName: readOptionalString(part, 'toolName') ?? readRequiredString(part, 'name'),
          modelName: readOptionalString(part, 'toolName') ?? readOptionalString(part, 'name'),
          args: readObject(part.input ?? part.args ?? {}),
          argsText: toolArgsText.get(toolCallId)
        };
        break;
      }
      case 'finish':
        yield {
          type: 'done',
          finishReason: 'completed',
          providerMetadata: mergeProviderMetadata(providerMetadata, {
            requestId: readOptionalString(part, 'requestId') ?? readOptionalString(part, 'providerRequestId'),
            usage: readUsage(part.usage),
            rawFinishReason: readOptionalString(part, 'finishReason')
          })
        };
        break;
      case 'error':
        yield {
          type: 'error',
          code: 'provider_error',
          message: readOptionalString(part, 'errorText') ?? readErrorMessage(part.error),
          providerMetadata: mergeProviderMetadata(providerMetadata, {
            requestId: readOptionalString(part, 'requestId') ?? readOptionalString(part, 'providerRequestId')
          })
        };
        break;
      default:
        break;
    }
  }
}

function mergeProviderMetadata(
  base: ModelProviderMetadata | undefined,
  override: ModelProviderMetadata
): ModelProviderMetadata {
  const usage = {
    ...base?.usage,
    ...override.usage
  };

  return {
    ...base,
    ...override,
    ...(Object.keys(usage).length > 0 ? { usage } : {})
  };
}

function readUsage(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = readOptionalNumber(usage, 'inputTokens') ?? readOptionalNumber(usage, 'promptTokens');
  const outputTokens = readOptionalNumber(usage, 'outputTokens') ?? readOptionalNumber(usage, 'completionTokens');
  const totalTokens = readOptionalNumber(usage, 'totalTokens');
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function readRequiredString(part: Record<string, unknown>, key: string): string {
  const value = part[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected "${key}" to be a string in Vercel AI stream part`);
  }

  return value;
}

function readOptionalString(part: Record<string, unknown>, key: string): string | undefined {
  const value = part[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(part: Record<string, unknown>, key: string): number | undefined {
  const value = part[key];
  return typeof value === 'number' ? value : undefined;
}

function readObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function readErrorMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message;
  }

  return 'Unknown provider error';
}
