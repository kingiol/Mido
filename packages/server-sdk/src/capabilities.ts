import type { JsonObject, JsonValue, ToolDefinition } from '@mido-agent/protocol-core';

import type { ModelAdapterRunInput } from './runner.js';

export type ModelAdapterKind =
  | 'native'
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'cloud_gateway'
  | 'router_gateway'
  | 'local_runtime'
  | 'framework_adapter';

export type CapabilitySupport = boolean | 'unknown';
export type ReasoningResumePreservation = boolean | 'unknown' | 'required' | 'required_but_missing';

export interface ModelAdapterCapabilities {
  provider: string;
  adapterKind: ModelAdapterKind;
  models?: string[];
  text?: {
    streaming?: CapabilitySupport;
  };
  reasoning?: {
    streaming?: CapabilitySupport;
    resumePreservation?: ReasoningResumePreservation;
  };
  tools?: {
    calling?: CapabilitySupport;
    argumentStreaming?: CapabilitySupport;
    parallelCalls?: CapabilitySupport;
    strictSchema?: CapabilitySupport;
    resumeWithResults?: CapabilitySupport;
  };
  structuredOutput?: {
    jsonMode?: CapabilitySupport;
    schema?: CapabilitySupport;
  };
  usage?: {
    inputTokens?: CapabilitySupport;
    outputTokens?: CapabilitySupport;
    totalTokens?: CapabilitySupport;
    streamingFinal?: CapabilitySupport;
  };
  finishReason?: {
    normalized?: CapabilitySupport;
  };
  errors?: {
    retryableNormalized?: CapabilitySupport;
  };
  transport?: {
    abortSignal?: CapabilitySupport;
    requestId?: CapabilitySupport;
  };
  limits?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    maxTools?: number;
    maxToolNameLength?: number;
    maxRequestBytes?: number;
  };
  knownGaps?: string[];
  metadata?: JsonObject;
}

export interface CapabilityCheckFailure {
  code: string;
  message: string;
  details?: JsonObject;
}

export function checkModelAdapterCapabilities(
  capabilities: ModelAdapterCapabilities | undefined,
  input: Pick<ModelAdapterRunInput, 'messages' | 'tools'>
): CapabilityCheckFailure | undefined {
  if (!capabilities) {
    return undefined;
  }

  const toolCount = input.tools.length;
  if (toolCount > 0 && capabilities.tools?.calling === false) {
    return createFailure(capabilities, 'provider_tools_unsupported', 'does not support tool calling', {
      requiredCapability: 'tools.calling',
      toolCount
    });
  }

  if (toolCount > 0 && capabilities.tools?.resumeWithResults === false) {
    return createFailure(capabilities, 'provider_tool_resume_unsupported', 'does not support resuming after tool results', {
      requiredCapability: 'tools.resumeWithResults',
      toolCount
    });
  }

  const maxTools = capabilities.limits?.maxTools;
  if (typeof maxTools === 'number' && toolCount > maxTools) {
    return createFailure(capabilities, 'provider_tool_limit_exceeded', `supports at most ${maxTools} tools`, {
      requiredCapability: 'limits.maxTools',
      maxTools,
      toolCount
    });
  }

  const maxToolNameLength = capabilities.limits?.maxToolNameLength;
  if (typeof maxToolNameLength === 'number') {
    const tooLong = input.tools.find(tool => getModelToolName(tool).length > maxToolNameLength);
    if (tooLong) {
      return createFailure(capabilities, 'provider_tool_name_limit_exceeded', `supports tool names up to ${maxToolNameLength} characters`, {
        requiredCapability: 'limits.maxToolNameLength',
        toolName: getModelToolName(tooLong),
        maxToolNameLength
      });
    }
  }

  if (
    capabilities.reasoning?.resumePreservation === 'required_but_missing' &&
    hasReasoningToolResumeContext(input.messages)
  ) {
    return createFailure(
      capabilities,
      'provider_reasoning_resume_unsupported',
      'requires reasoning preservation across tool resume, but this adapter cannot preserve it yet',
      {
        requiredCapability: 'reasoning.resumePreservation'
      }
    );
  }

  return undefined;
}

function createFailure(
  capabilities: ModelAdapterCapabilities,
  code: string,
  suffix: string,
  details: JsonObject
): CapabilityCheckFailure {
  const modelText = capabilities.models?.length === 1 ? ` model "${capabilities.models[0]}"` : '';
  return {
    code,
    message: `Provider "${capabilities.provider}"${modelText} ${suffix}`,
    details: {
      provider: capabilities.provider,
      adapterKind: capabilities.adapterKind,
      models: capabilities.models as JsonValue,
      knownGaps: capabilities.knownGaps as JsonValue,
      ...details
    }
  };
}

function getModelToolName(tool: ToolDefinition): string {
  return tool.modelName ?? tool.name;
}

function hasReasoningToolResumeContext(messages: ModelAdapterRunInput['messages']): boolean {
  let sawReasoningToolCall = false;

  for (const message of messages) {
    if (message.role === 'assistant') {
      const hasReasoning = message.content.some(part => part.type === 'reasoning' && part.text.length > 0);
      const hasToolCall = message.content.some(part => part.type === 'tool-call');
      if (hasReasoning && hasToolCall) {
        sawReasoningToolCall = true;
      }
    }

    if (sawReasoningToolCall && message.role === 'tool' && message.content.some(part => part.type === 'tool-result')) {
      return true;
    }
  }

  return false;
}
