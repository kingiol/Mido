import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JSONSchema = Record<string, unknown>;

export type ToolExecutionPolicy = 'server' | 'client_auto' | 'client_interactive';
export type ToolRuntime = 'server' | 'client';
export type RunFinishReason = 'completed' | 'awaiting_client_tool' | 'cancelled';
export type TraceKind = 'run' | 'model' | 'tool' | 'state' | 'transport';
export type ModelCallStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface TraceMetadata {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: TraceKind;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  attributes?: JsonObject;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolId?: string;
  toolName: string;
  modelName?: string;
  args: JsonObject;
  executionPolicy: ToolExecutionPolicy;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolId?: string;
  toolName: string;
  output: JsonValue;
  isError?: boolean;
}

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

export interface AgentMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool' | 'summary';
  content: MessagePart[];
  createdAt: string;
}

export interface ToolDefinitionBase {
  toolId?: string;
  name: string;
  modelName?: string;
  description: string;
  inputSchema: JSONSchema;
  resultSchema: JSONSchema;
  executionPolicy: ToolExecutionPolicy;
  timeoutMs?: number;
  metadata?: JsonObject;
}

export interface ServerToolDefinition extends ToolDefinitionBase {
  executionPolicy: 'server';
}

export interface ClientToolDefinition extends ToolDefinitionBase {
  executionPolicy: 'client_auto' | 'client_interactive';
}

export type ToolDefinition = ServerToolDefinition | ClientToolDefinition;

export interface RunContextBudget {
  maxInputTokens?: number;
  reserveOutputTokens?: number;
  triggerRatio?: number;
  targetRatio?: number;
}

export interface ToolCallEnvelope {
  runId: string;
  messageId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  modelName: string;
  toolRuntime: ToolRuntime;
  executionPolicy: ToolExecutionPolicy;
  timeoutMs?: number;
  args: JsonObject;
  createdAt: string;
}

export interface ToolResultEnvelope {
  runId: string;
  messageId: string;
  toolCallId: string;
  toolId?: string;
  toolName: string;
  modelName?: string;
  output: JsonValue;
  submittedAt: string;
  isError?: boolean;
}

export interface RunStartRequest {
  runId?: string;
  threadId?: string;
  messages: AgentMessage[];
  clientTools?: ClientToolDefinition[];
  contextBudget?: RunContextBudget;
  state?: JsonObject;
  metadata?: JsonObject;
}

export interface RunResumeRequest {
  runId: string;
  toolResult: ToolResultEnvelope;
  stateDelta?: JsonObject;
}

export interface RunCancelRequest {
  runId: string;
  reason?: string;
}

export interface RunCheckpoint {
  runId: string;
  threadId?: string;
  sequence: number;
  runStartedAt?: string;
  sourceMessageIds?: string[];
  messages: AgentMessage[];
  clientTools?: ClientToolDefinition[];
  contextBudget?: RunContextBudget;
  state: JsonObject;
  metadata?: JsonObject;
  pendingToolCalls: ToolCallEnvelope[];
  submittedToolResults: ToolResultEnvelope[];
  processedToolCallIds: string[];
  updatedAt: string;
}

interface CoreEventBase {
  eventId: string;
  sequence: number;
  runId: string;
  messageId: string;
  timestamp: string;
  trace?: TraceMetadata;
}

export interface RunStartedEvent extends CoreEventBase {
  type: 'RUN_STARTED';
  threadId?: string;
}

export interface TextStartEvent extends CoreEventBase {
  type: 'TEXT_START';
  textId: string;
  role: 'assistant';
}

export interface TextDeltaEvent extends CoreEventBase {
  type: 'TEXT_DELTA';
  textId: string;
  delta: string;
}

export interface TextEndEvent extends CoreEventBase {
  type: 'TEXT_END';
  textId: string;
  text: string;
}

export interface ReasoningDeltaEvent extends CoreEventBase {
  type: 'REASONING_DELTA';
  reasoningId: string;
  delta: string;
}

export interface ToolCallStartEvent extends CoreEventBase {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolId: string;
  toolName: string;
  modelName: string;
  toolRuntime: ToolRuntime;
  executionPolicy: ToolExecutionPolicy;
  timeoutMs?: number;
}

export interface ToolCallArgsEvent extends CoreEventBase {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  toolId?: string;
  delta?: string;
  args?: JsonObject;
}

export interface ToolCallEndEvent extends CoreEventBase {
  type: 'TOOL_CALL_END';
  toolCallId: string;
  toolId: string;
  toolName: string;
  modelName: string;
  toolRuntime: ToolRuntime;
  executionPolicy: ToolExecutionPolicy;
  timeoutMs?: number;
  args: JsonObject;
}

export interface ToolResultEvent extends CoreEventBase {
  type: 'TOOL_RESULT';
  toolCallId: string;
  toolId?: string;
  toolName: string;
  modelName?: string;
  toolRuntime?: ToolRuntime;
  output: JsonValue;
  isError?: boolean;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelProviderMetadata {
  provider?: string;
  model?: string;
  requestId?: string;
  usage?: ModelUsage;
  rawFinishReason?: string;
}

export interface ModelCallStartEvent extends CoreEventBase {
  type: 'MODEL_CALL_START';
  modelCallId: string;
  provider?: string;
  model?: string;
}

export interface ModelCallEndEvent extends CoreEventBase {
  type: 'MODEL_CALL_END';
  modelCallId: string;
  status: ModelCallStatus;
  finishReason?: string;
  provider?: string;
  model?: string;
  providerRequestId?: string;
  usage?: ModelUsage;
}

export interface StateDeltaEvent extends CoreEventBase {
  type: 'STATE_DELTA';
  delta: JsonObject;
}

export interface RunFinishedEvent extends CoreEventBase {
  type: 'RUN_FINISHED';
  finishReason: RunFinishReason;
  pendingToolCallId?: string;
  pendingToolCallIds?: string[];
}

export interface RunErrorEvent extends CoreEventBase {
  type: 'RUN_ERROR';
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: JsonObject;
  };
}

export type CoreEvent =
  | RunStartedEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolResultEvent
  | ModelCallStartEvent
  | ModelCallEndEvent
  | StateDeltaEvent
  | RunFinishedEvent
  | RunErrorEvent;

export interface ModelCallTraceSummary {
  modelCallId: string;
  provider?: string;
  model?: string;
  status: ModelCallStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  finishReason?: string;
  providerRequestId?: string;
  usage?: ModelUsage;
}

export interface ToolCallTraceSummary {
  toolCallId: string;
  toolId?: string;
  toolName?: string;
  modelName?: string;
  toolRuntime?: ToolRuntime;
  executionPolicy?: ToolExecutionPolicy;
  status: 'pending' | 'completed' | 'error';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  isError?: boolean;
  error?: JsonValue;
}

export interface RunTraceSummary {
  runId?: string;
  threadId?: string;
  status: 'unknown' | 'running' | 'awaiting_client_tool' | 'completed' | 'cancelled' | 'error';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  eventCount: number;
  modelCalls: ModelCallTraceSummary[];
  toolCalls: ToolCallTraceSummary[];
  errors: Array<{
    eventId: string;
    sequence: number;
    code?: string;
    message?: string;
    toolCallId?: string;
  }>;
}

const anyValueSchema: JSONSchema = {};
const timestampSchema: JSONSchema = { type: 'string', format: 'date-time' };
const jsonObjectSchema: JSONSchema = {
  type: 'object',
  additionalProperties: true
};
const modelUsageSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'number', minimum: 0 },
    outputTokens: { type: 'number', minimum: 0 },
    totalTokens: { type: 'number', minimum: 0 }
  }
};
const requiredString = (name: string): [string, JSONSchema] => [name, { type: 'string' }];
export const traceMetadataSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string' },
    spanId: { type: 'string' },
    parentSpanId: { type: 'string' },
    name: { type: 'string' },
    kind: {
      enum: ['run', 'model', 'tool', 'state', 'transport']
    },
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    durationMs: { type: 'number', minimum: 0 },
    attributes: jsonObjectSchema
  },
  required: ['traceId', 'spanId', 'name', 'kind']
};
const eventBaseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventId: { type: 'string' },
    sequence: { type: 'integer', minimum: 0 },
    runId: { type: 'string' },
    messageId: { type: 'string' },
    timestamp: timestampSchema,
    trace: traceMetadataSchema
  },
  required: ['eventId', 'sequence', 'runId', 'messageId', 'timestamp']
} as const;

const mergeSchema = (base: JSONSchema, extension: JSONSchema): JSONSchema => ({
  allOf: [base, extension]
});

export const textPartSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'text' },
    text: { type: 'string' }
  },
  required: ['type', 'text']
};

export const reasoningPartSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'reasoning' },
    text: { type: 'string' }
  },
  required: ['type', 'text']
};

export const toolCallPartSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'tool-call' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    args: jsonObjectSchema,
    executionPolicy: {
      enum: ['server', 'client_auto', 'client_interactive']
    }
  },
  required: ['type', 'toolCallId', 'toolName', 'args', 'executionPolicy']
};

export const toolResultPartSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'tool-result' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    output: anyValueSchema,
    isError: { type: 'boolean' }
  },
  required: ['type', 'toolCallId', 'toolName', 'output']
};

export const messagePartSchema: JSONSchema = {
  oneOf: [textPartSchema, reasoningPartSchema, toolCallPartSchema, toolResultPartSchema]
};

export const agentMessageSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    role: { enum: ['system', 'user', 'assistant', 'tool', 'summary'] },
    content: { type: 'array', items: messagePartSchema },
    createdAt: timestampSchema
  },
  required: ['id', 'role', 'content', 'createdAt']
};

export const runContextBudgetSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxInputTokens: { type: 'number', minimum: 0 },
    reserveOutputTokens: { type: 'number', minimum: 0 },
    triggerRatio: { type: 'number', minimum: 0, maximum: 1 },
    targetRatio: { type: 'number', minimum: 0, maximum: 1 }
  }
};

export const toolDefinitionSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    toolId: { type: 'string' },
    name: { type: 'string' },
    modelName: { type: 'string' },
    description: { type: 'string' },
    inputSchema: jsonObjectSchema,
    resultSchema: jsonObjectSchema,
    executionPolicy: {
      enum: ['server', 'client_auto', 'client_interactive']
    },
    timeoutMs: { type: 'number', minimum: 0 },
    metadata: jsonObjectSchema
  },
  required: ['name', 'description', 'inputSchema', 'resultSchema', 'executionPolicy']
};

export const toolCallEnvelopeSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    messageId: { type: 'string' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    toolRuntime: { enum: ['server', 'client'] },
    executionPolicy: {
      enum: ['server', 'client_auto', 'client_interactive']
    },
    timeoutMs: { type: 'number', minimum: 0 },
    args: jsonObjectSchema,
    createdAt: timestampSchema
  },
  required: ['runId', 'messageId', 'toolCallId', 'toolId', 'toolName', 'modelName', 'toolRuntime', 'executionPolicy', 'args', 'createdAt']
};

export const toolResultEnvelopeSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    messageId: { type: 'string' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    output: anyValueSchema,
    submittedAt: timestampSchema,
    isError: { type: 'boolean' }
  },
  required: ['runId', 'messageId', 'toolCallId', 'toolName', 'output', 'submittedAt']
};

export const runStartRequestSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    threadId: { type: 'string' },
    messages: { type: 'array', items: agentMessageSchema },
    clientTools: {
      type: 'array',
      items: {
        allOf: [
          toolDefinitionSchema,
          {
            type: 'object',
            properties: {
              executionPolicy: {
                enum: ['client_auto', 'client_interactive']
              }
            }
          }
        ]
      }
    },
    contextBudget: runContextBudgetSchema,
    state: jsonObjectSchema,
    metadata: jsonObjectSchema
  },
  required: ['messages']
};

export const runResumeRequestSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    toolResult: toolResultEnvelopeSchema,
    stateDelta: jsonObjectSchema
  },
  required: ['runId', 'toolResult']
};

export const runCancelRequestSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['runId']
};

export const runCheckpointSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string' },
    threadId: { type: 'string' },
    sequence: { type: 'integer', minimum: 0 },
    runStartedAt: timestampSchema,
    sourceMessageIds: { type: 'array', items: { type: 'string' } },
    messages: { type: 'array', items: agentMessageSchema },
    clientTools: {
      type: 'array',
      items: {
        allOf: [
          toolDefinitionSchema,
          {
            type: 'object',
            properties: {
              executionPolicy: {
                enum: ['client_auto', 'client_interactive']
              }
            }
          }
        ]
      }
    },
    contextBudget: runContextBudgetSchema,
    state: jsonObjectSchema,
    metadata: jsonObjectSchema,
    pendingToolCalls: { type: 'array', items: toolCallEnvelopeSchema },
    submittedToolResults: { type: 'array', items: toolResultEnvelopeSchema },
    processedToolCallIds: { type: 'array', items: { type: 'string' } },
    updatedAt: timestampSchema
  },
  required: [
    'runId',
    'sequence',
    'messages',
    'state',
    'pendingToolCalls',
    'submittedToolResults',
    'processedToolCallIds',
    'updatedAt'
  ]
};

export const runStartedEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'RUN_STARTED' },
    threadId: { type: 'string' }
  },
  required: ['type']
});

export const textStartEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TEXT_START' },
    textId: { type: 'string' },
    role: { const: 'assistant' }
  },
  required: ['type', 'textId', 'role']
});

export const textDeltaEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TEXT_DELTA' },
    textId: { type: 'string' },
    delta: { type: 'string' }
  },
  required: ['type', 'textId', 'delta']
});

export const textEndEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TEXT_END' },
    textId: { type: 'string' },
    text: { type: 'string' }
  },
  required: ['type', 'textId', 'text']
});

export const reasoningDeltaEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'REASONING_DELTA' },
    reasoningId: { type: 'string' },
    delta: { type: 'string' }
  },
  required: ['type', 'reasoningId', 'delta']
});

export const toolCallStartEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TOOL_CALL_START' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    toolRuntime: { enum: ['server', 'client'] },
    executionPolicy: {
      enum: ['server', 'client_auto', 'client_interactive']
    },
    timeoutMs: { type: 'number', minimum: 0 }
  },
  required: ['type', 'toolCallId', 'toolId', 'toolName', 'modelName', 'toolRuntime', 'executionPolicy']
});

export const toolCallArgsEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TOOL_CALL_ARGS' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    delta: { type: 'string' },
    args: jsonObjectSchema
  },
  required: ['type', 'toolCallId']
});

export const toolCallEndEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TOOL_CALL_END' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    toolRuntime: { enum: ['server', 'client'] },
    executionPolicy: {
      enum: ['server', 'client_auto', 'client_interactive']
    },
    timeoutMs: { type: 'number', minimum: 0 },
    args: jsonObjectSchema
  },
  required: ['type', 'toolCallId', 'toolId', 'toolName', 'modelName', 'toolRuntime', 'executionPolicy', 'args']
});

export const toolResultEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'TOOL_RESULT' },
    toolCallId: { type: 'string' },
    toolId: { type: 'string' },
    toolName: { type: 'string' },
    modelName: { type: 'string' },
    toolRuntime: { enum: ['server', 'client'] },
    output: anyValueSchema,
    isError: { type: 'boolean' }
  },
  required: ['type', 'toolCallId', 'toolName', 'output']
});

export const modelCallStartEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'MODEL_CALL_START' },
    modelCallId: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' }
  },
  required: ['type', 'modelCallId']
});

export const modelCallEndEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'MODEL_CALL_END' },
    modelCallId: { type: 'string' },
    status: { enum: ['running', 'completed', 'error', 'cancelled'] },
    finishReason: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    providerRequestId: { type: 'string' },
    usage: modelUsageSchema
  },
  required: ['type', 'modelCallId', 'status']
});

export const stateDeltaEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'STATE_DELTA' },
    delta: jsonObjectSchema
  },
  required: ['type', 'delta']
});

export const runFinishedEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'RUN_FINISHED' },
    finishReason: { enum: ['completed', 'awaiting_client_tool', 'cancelled'] },
    pendingToolCallId: { type: 'string' },
    pendingToolCallIds: { type: 'array', items: { type: 'string' } }
  },
  required: ['type', 'finishReason']
});

export const runErrorEventSchema: JSONSchema = mergeSchema(eventBaseSchema, {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'RUN_ERROR' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: jsonObjectSchema
      },
      required: ['code', 'message']
    }
  },
  required: ['type', 'error']
});

export const coreEventSchema: JSONSchema = {
  oneOf: [
    runStartedEventSchema,
    textStartEventSchema,
    textDeltaEventSchema,
    textEndEventSchema,
    reasoningDeltaEventSchema,
    toolCallStartEventSchema,
    toolCallArgsEventSchema,
    toolCallEndEventSchema,
    toolResultEventSchema,
    modelCallStartEventSchema,
    modelCallEndEventSchema,
    stateDeltaEventSchema,
    runFinishedEventSchema,
    runErrorEventSchema
  ]
};

export const coreProtocolSchemas = {
  agentMessage: agentMessageSchema,
  coreEvent: coreEventSchema,
  runCancelRequest: runCancelRequestSchema,
  runCheckpoint: runCheckpointSchema,
  runResumeRequest: runResumeRequestSchema,
  runStartRequest: runStartRequestSchema,
  traceMetadata: traceMetadataSchema,
  toolCallEnvelope: toolCallEnvelopeSchema,
  toolDefinition: toolDefinitionSchema,
  toolResultEnvelope: toolResultEnvelopeSchema
} as const;

const validatorCache = new WeakMap<object, ValidateFunction>();

function getAjv() {
  return new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  });
}

function getValidator(schema: JSONSchema): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  const validator = getAjv().compile(schema);
  validatorCache.set(schema, validator);
  return validator;
}

function formatErrors(errors?: ErrorObject[] | null): string {
  if (!errors?.length) {
    return 'Unknown schema validation error';
  }

  return errors
    .map(error => {
      const path = error.instancePath || '/';
      return `${path} ${error.message ?? 'is invalid'}`.trim();
    })
    .join('; ');
}

export function safeValidateSchema<T>(schema: JSONSchema, value: unknown): { success: true; data: T } | { success: false; errors: string } {
  const validator = getValidator(schema);
  if (validator(value)) {
    return { success: true, data: value as T };
  }

  return {
    success: false,
    errors: formatErrors(validator.errors)
  };
}

export function validateSchema<T>(schema: JSONSchema, value: unknown, label = 'value'): T {
  const result = safeValidateSchema<T>(schema, value);
  if (!result.success) {
    throw new Error(`Invalid ${label}: ${result.errors}`);
  }

  return result.data;
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function inferToolRuntime(executionPolicy: ToolExecutionPolicy): ToolRuntime {
  return executionPolicy === 'server' ? 'server' : 'client';
}

export function buildRunTrace(events: CoreEvent[]): RunTraceSummary {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const firstEvent = orderedEvents[0];
  const lastEvent = orderedEvents.at(-1);
  const modelCalls = new Map<string, ModelCallTraceSummary>();
  const toolCalls = new Map<string, ToolCallTraceSummary>();
  const errors: RunTraceSummary['errors'] = [];
  let status: RunTraceSummary['status'] = firstEvent ? 'running' : 'unknown';
  let threadId: string | undefined;

  for (const event of orderedEvents) {
    if (event.type === 'RUN_STARTED') {
      threadId = event.threadId;
      status = 'running';
    }

    if (event.type === 'MODEL_CALL_START') {
      const existing = modelCalls.get(event.modelCallId);
      modelCalls.set(event.modelCallId, {
        ...existing,
        modelCallId: event.modelCallId,
        provider: event.provider ?? existing?.provider,
        model: event.model ?? existing?.model,
        status: existing?.status ?? 'running',
        startedAt: event.trace?.startedAt ?? event.timestamp
      });
    }

    if (event.type === 'MODEL_CALL_END') {
      const existing = modelCalls.get(event.modelCallId);
      const endedAt = event.trace?.endedAt ?? event.timestamp;
      modelCalls.set(event.modelCallId, {
        ...existing,
        modelCallId: event.modelCallId,
        provider: event.provider ?? existing?.provider,
        model: event.model ?? existing?.model,
        status: event.status,
        startedAt: existing?.startedAt ?? event.trace?.startedAt,
        endedAt,
        durationMs: event.trace?.durationMs,
        finishReason: event.finishReason,
        providerRequestId: event.providerRequestId,
        usage: event.usage
      });
    }

    if (event.type === 'TOOL_CALL_START' || event.type === 'TOOL_CALL_END') {
      const existing = toolCalls.get(event.toolCallId);
      toolCalls.set(event.toolCallId, {
        ...existing,
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        executionPolicy: event.executionPolicy,
        status: existing?.status ?? 'pending',
        startedAt: existing?.startedAt ?? event.trace?.startedAt ?? event.timestamp
      });
    }

    if (event.type === 'TOOL_RESULT') {
      const existing = toolCalls.get(event.toolCallId);
      const endedAt = event.trace?.endedAt ?? event.timestamp;
      toolCalls.set(event.toolCallId, {
        ...existing,
        toolCallId: event.toolCallId,
        toolId: event.toolId ?? existing?.toolId,
        toolName: event.toolName ?? existing?.toolName,
        modelName: event.modelName ?? existing?.modelName,
        toolRuntime: event.toolRuntime ?? existing?.toolRuntime,
        status: event.isError ? 'error' : 'completed',
        startedAt: existing?.startedAt ?? event.trace?.startedAt,
        endedAt,
        durationMs: event.trace?.durationMs,
        isError: event.isError,
        error: event.isError ? event.output : existing?.error
      });

      if (event.isError) {
        errors.push({
          eventId: event.eventId,
          sequence: event.sequence,
          toolCallId: event.toolCallId,
          message: stringifyTraceError(event.output)
        });
      }
    }

    if (event.type === 'RUN_ERROR') {
      status = 'error';
      errors.push({
        eventId: event.eventId,
        sequence: event.sequence,
        code: event.error.code,
        message: event.error.message
      });
    }

    if (event.type === 'RUN_FINISHED') {
      status = event.finishReason;
    }
  }

  return {
    runId: firstEvent?.runId,
    threadId,
    status,
    startedAt: firstEvent?.timestamp,
    endedAt: lastEvent?.timestamp,
    durationMs: firstEvent && lastEvent ? Math.max(0, Date.parse(lastEvent.timestamp) - Date.parse(firstEvent.timestamp)) : undefined,
    eventCount: orderedEvents.length,
    modelCalls: [...modelCalls.values()],
    toolCalls: [...toolCalls.values()],
    errors
  };
}

function stringifyTraceError(value: JsonValue): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const message = value.message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return stableStringify(value);
}

export function createToolId(executionPolicy: ToolExecutionPolicy, name: string): string {
  return `${inferToolRuntime(executionPolicy)}:${name}`;
}

export function createToolModelName(executionPolicy: ToolExecutionPolicy, name: string): string {
  return `${inferToolRuntime(executionPolicy)}__${sanitizeToolModelName(name)}`;
}

export function normalizeToolDefinition<T extends ToolDefinition>(definition: T): T & Required<Pick<ToolDefinitionBase, 'toolId' | 'modelName'>> {
  const normalized = {
    ...definition,
    toolId: definition.toolId ?? createToolId(definition.executionPolicy, definition.name),
    modelName: definition.modelName ?? createToolModelName(definition.executionPolicy, definition.name)
  };

  if (!isValidToolModelName(normalized.modelName)) {
    throw new Error(`Invalid tool modelName "${normalized.modelName}". Use letters, numbers, "_" or "-", and keep it under 64 characters.`);
  }

  if (normalized.timeoutMs !== undefined && (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs < 0)) {
    throw new Error(`Invalid timeoutMs for tool "${normalized.name}". Use a finite number greater than or equal to 0.`);
  }

  return normalized as T & Required<Pick<ToolDefinitionBase, 'toolId' | 'modelName'>>;
}

function sanitizeToolModelName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
}

function isValidToolModelName(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function createMessage(role: AgentMessage['role'], content: MessagePart[]): AgentMessage {
  return {
    id: createId('msg'),
    role,
    content,
    createdAt: nowIso()
  };
}

export function isClientTool(definition: ToolDefinition): definition is ClientToolDefinition {
  return definition.executionPolicy !== 'server';
}

export function isServerTool(definition: ToolDefinition): definition is ServerToolDefinition {
  return definition.executionPolicy === 'server';
}
