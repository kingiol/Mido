import type {
  CoreEvent,
  JsonObject,
  ModelCallEndEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  TextDeltaEvent,
  TextEndEvent,
  TextStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolResultEvent
} from '@mido/protocol-core';

export { MIDO_PROTOCOL_VERSION, MIDO_SDK_VERSION } from '@mido/protocol-core';

const CUSTOM_EVENT_PREFIX = 'mido/';

export type AgUiEventType =
  | 'RUN_STARTED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'REASONING_MESSAGE_CONTENT'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_END'
  | 'TOOL_RESULT'
  | 'STATE_DELTA'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | `${typeof CUSTOM_EVENT_PREFIX}${string}`;

export interface AgUiEvent {
  type: AgUiEventType;
  runId: string;
  messageId: string;
  eventId: string;
  sequence: number;
  timestamp: string;
  [key: string]: unknown;
}

function base(event: CoreEvent): Pick<AgUiEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'> {
  return {
    eventId: event.eventId,
    messageId: event.messageId,
    runId: event.runId,
    sequence: event.sequence,
    timestamp: event.timestamp
  };
}

export function toAgUiEvent(event: CoreEvent): AgUiEvent {
  switch (event.type) {
    case 'RUN_STARTED':
      return {
        ...base(event),
        type: 'RUN_STARTED',
        threadId: event.threadId
      };
    case 'TEXT_START':
      return {
        ...base(event),
        type: 'TEXT_MESSAGE_START',
        textId: event.textId,
        role: event.role
      };
    case 'TEXT_DELTA':
      return {
        ...base(event),
        type: 'TEXT_MESSAGE_CONTENT',
        textId: event.textId,
        delta: event.delta
      };
    case 'TEXT_END':
      return {
        ...base(event),
        type: 'TEXT_MESSAGE_END',
        textId: event.textId,
        text: event.text
      };
    case 'REASONING_DELTA':
      return {
        ...base(event),
        type: 'REASONING_MESSAGE_CONTENT',
        reasoningId: event.reasoningId,
        delta: event.delta
      };
    case 'TOOL_CALL_START':
      return {
        ...base(event),
        type: 'TOOL_CALL_START',
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        timeoutMs: event.timeoutMs,
        executionPolicy: event.executionPolicy
      };
    case 'TOOL_CALL_ARGS':
      return {
        ...base(event),
        type: `${CUSTOM_EVENT_PREFIX}tool-call-args`,
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        delta: event.delta,
        args: event.args
      };
    case 'TOOL_CALL_END':
      return {
        ...base(event),
        type: 'TOOL_CALL_END',
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        executionPolicy: event.executionPolicy,
        timeoutMs: event.timeoutMs,
        args: event.args
      };
    case 'TOOL_RESULT':
      return {
        ...base(event),
        type: 'TOOL_RESULT',
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        output: event.output,
        isError: event.isError
      };
    case 'MODEL_CALL_START':
      return {
        ...base(event),
        type: `${CUSTOM_EVENT_PREFIX}model-call-start`,
        modelCallId: event.modelCallId,
        provider: event.provider,
        model: event.model
      };
    case 'MODEL_CALL_END':
      return {
        ...base(event),
        type: `${CUSTOM_EVENT_PREFIX}model-call-end`,
        modelCallId: event.modelCallId,
        status: event.status,
        finishReason: event.finishReason,
        provider: event.provider,
        model: event.model,
        providerRequestId: event.providerRequestId,
        usage: event.usage
      };
    case 'STATE_DELTA':
      return {
        ...base(event),
        type: 'STATE_DELTA',
        delta: event.delta
      };
    case 'RUN_FINISHED':
      return {
        ...base(event),
        type: 'RUN_FINISHED',
        finishReason: event.finishReason,
        pendingToolCallId: event.pendingToolCallId,
        pendingToolCallIds: event.pendingToolCallIds
      };
    case 'RUN_ERROR':
      return {
        ...base(event),
        type: 'RUN_ERROR',
        error: event.error
      };
  }
}

export function fromAgUiEvent(event: AgUiEvent): CoreEvent {
  switch (event.type) {
    case 'RUN_STARTED':
      return {
        ...commonEventFields(event),
        type: 'RUN_STARTED',
        threadId: stringOrUndefined(event.threadId)
      };
    case 'TEXT_MESSAGE_START':
      return {
        ...commonEventFields(event),
        type: 'TEXT_START',
        textId: readString(event, 'textId'),
        role: 'assistant'
      };
    case 'TEXT_MESSAGE_CONTENT':
      return {
        ...commonEventFields(event),
        type: 'TEXT_DELTA',
        textId: readString(event, 'textId'),
        delta: readString(event, 'delta')
      };
    case 'TEXT_MESSAGE_END':
      return {
        ...commonEventFields(event),
        type: 'TEXT_END',
        textId: readString(event, 'textId'),
        text: readString(event, 'text')
      };
    case 'REASONING_MESSAGE_CONTENT':
      return {
        ...commonEventFields(event),
        type: 'REASONING_DELTA',
        reasoningId: readString(event, 'reasoningId'),
        delta: readString(event, 'delta')
      };
    case 'TOOL_CALL_START':
      return {
        ...commonEventFields(event),
        type: 'TOOL_CALL_START',
        toolCallId: readString(event, 'toolCallId'),
        toolId: readString(event, 'toolId'),
        toolName: readString(event, 'toolName'),
        modelName: readString(event, 'modelName'),
        toolRuntime: readRuntime(event.toolRuntime),
        timeoutMs: numberOrUndefined(event.timeoutMs),
        executionPolicy: readPolicy(event.executionPolicy)
      };
    case 'TOOL_CALL_END':
      return {
        ...commonEventFields(event),
        type: 'TOOL_CALL_END',
        toolCallId: readString(event, 'toolCallId'),
        toolId: readString(event, 'toolId'),
        toolName: readString(event, 'toolName'),
        modelName: readString(event, 'modelName'),
        toolRuntime: readRuntime(event.toolRuntime),
        executionPolicy: readPolicy(event.executionPolicy),
        timeoutMs: numberOrUndefined(event.timeoutMs),
        args: readObject(event.args)
      };
    case 'TOOL_RESULT':
      return {
        ...commonEventFields(event),
        type: 'TOOL_RESULT',
        toolCallId: readString(event, 'toolCallId'),
        toolId: stringOrUndefined(event.toolId),
        toolName: readString(event, 'toolName'),
        modelName: stringOrUndefined(event.modelName),
        toolRuntime: runtimeOrUndefined(event.toolRuntime),
        output: (event.output ?? null) as never,
        isError: booleanOrUndefined(event.isError)
      };
    case 'STATE_DELTA':
      return {
        ...commonEventFields(event),
        type: 'STATE_DELTA',
        delta: readObject(event.delta)
      };
    case 'RUN_FINISHED':
      return {
        ...commonEventFields(event),
        type: 'RUN_FINISHED',
        finishReason: readFinishReason(event.finishReason),
        pendingToolCallId: stringOrUndefined(event.pendingToolCallId),
        pendingToolCallIds: Array.isArray(event.pendingToolCallIds)
          ? event.pendingToolCallIds.map(String)
          : undefined
      };
    case 'RUN_ERROR':
      return {
        ...commonEventFields(event),
        type: 'RUN_ERROR',
        error: readError(event.error)
      };
    default:
      if (event.type === `${CUSTOM_EVENT_PREFIX}tool-call-args`) {
        return {
          ...commonEventFields(event),
          type: 'TOOL_CALL_ARGS',
          toolCallId: readString(event, 'toolCallId'),
          toolId: stringOrUndefined(event.toolId),
          delta: stringOrUndefined(event.delta),
          args: event.args ? readObject(event.args) : undefined
        };
      }

      if (event.type === `${CUSTOM_EVENT_PREFIX}model-call-start`) {
        return {
          ...commonEventFields(event),
          type: 'MODEL_CALL_START',
          modelCallId: readString(event, 'modelCallId'),
          provider: stringOrUndefined(event.provider),
          model: stringOrUndefined(event.model)
        };
      }

      if (event.type === `${CUSTOM_EVENT_PREFIX}model-call-end`) {
        return {
          ...commonEventFields(event),
          type: 'MODEL_CALL_END',
          modelCallId: readString(event, 'modelCallId'),
          status: readModelCallStatus(event.status),
          finishReason: stringOrUndefined(event.finishReason),
          provider: stringOrUndefined(event.provider),
          model: stringOrUndefined(event.model),
          providerRequestId: stringOrUndefined(event.providerRequestId),
          usage: objectOrUndefined(event.usage) as ModelCallEndEvent['usage']
        };
      }

      throw new Error(`Unsupported AG-UI event type: ${event.type}`);
  }
}

function commonEventFields(event: AgUiEvent) {
  return {
    eventId: event.eventId,
    runId: event.runId,
    messageId: event.messageId,
    sequence: event.sequence,
    timestamp: event.timestamp
  } satisfies Pick<CoreEvent, 'eventId' | 'runId' | 'messageId' | 'sequence' | 'timestamp'>;
}

function readString(event: AgUiEvent, key: string): string {
  const value = event[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected "${key}" to be a string`);
  }

  return value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object payload');
  }

  return value as JsonObject;
}

function readPolicy(value: unknown): ToolCallStartEvent['executionPolicy'] {
  if (value === 'server' || value === 'client_auto' || value === 'client_interactive') {
    return value;
  }

  throw new Error(`Unsupported execution policy: ${String(value)}`);
}

function readRuntime(value: unknown): ToolCallStartEvent['toolRuntime'] {
  if (value === 'server' || value === 'client') {
    return value;
  }

  throw new Error(`Unsupported tool runtime: ${String(value)}`);
}

function runtimeOrUndefined(value: unknown): ToolCallStartEvent['toolRuntime'] | undefined {
  return value === 'server' || value === 'client' ? value : undefined;
}

function readFinishReason(value: unknown): RunFinishedEvent['finishReason'] {
  if (value === 'completed' || value === 'awaiting_client_tool' || value === 'cancelled') {
    return value;
  }

  throw new Error(`Unsupported finish reason: ${String(value)}`);
}

function readModelCallStatus(value: unknown): ModelCallEndEvent['status'] {
  if (value === 'running' || value === 'completed' || value === 'error' || value === 'cancelled') {
    return value;
  }

  throw new Error(`Unsupported model call status: ${String(value)}`);
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function readError(value: unknown): RunErrorEvent['error'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected error payload');
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.code !== 'string' || typeof payload.message !== 'string') {
    throw new Error('Error payload must include code and message');
  }

  return {
    code: payload.code,
    message: payload.message,
    retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
    details: payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
      ? (payload.details as JsonObject)
      : undefined
  };
}
