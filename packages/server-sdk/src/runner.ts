import {
  createId,
  inferToolRuntime,
  isServerTool,
  nowIso,
  normalizeToolDefinition,
  stableStringify,
  type AgentMessage,
  type ClientToolDefinition,
  type CoreEvent,
  type JsonObject,
  type JsonValue,
  type ModelCallEndEvent,
  type ModelCallStartEvent,
  type ModelProviderMetadata,
  type RunContextBudget,
  type RunCancelRequest,
  type ReasoningDeltaEvent,
  type RunCheckpoint,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunResumeRequest,
  type RunStartedEvent,
  type RunStartRequest,
  type StateDeltaEvent,
  type TextDeltaEvent,
  type TextEndEvent,
  type TextStartEvent,
  type ToolCallEnvelope,
  type ToolDefinition,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
  type TraceKind,
  type TraceMetadata,
  type ToolResultEnvelope,
  type ToolResultEvent,
  validateSchema
} from '@mido/protocol-core';

import { type EventStore, type SessionStore, type StoredThread, type ThreadLifecycle, type ThreadMessageIndexEntry, type ThreadStore } from './store.js';
import { applySystemPromptPolicy, type SystemPromptContext, type SystemPromptProvider } from './system-prompt.js';
import { ToolRegistry, type RegisteredToolDefinition } from './tool-registry.js';
import { checkModelAdapterCapabilities, type ModelAdapterCapabilities } from './capabilities.js';
import type { ToolPolicyContext, ToolPolicyDecision, ToolPolicyProvider } from './policy.js';
import type { AgentSkillRegistry } from './skills.js';
import {
  estimateModelInputTokens,
  resolveRunContextBudget,
  shouldCreateSummaryMessage,
  type ResolvedContextBudget
} from './context-budget.js';
import {
  buildSummaryCompressorMessages,
  type SummaryCompressorInput,
  type SummaryCompressorOutput
} from './summary-compressor.js';
import { selectSummaryWindowMessages } from './summary-messages.js';
import { extractSummaryToolFacts } from './summary-tool-facts.js';

export interface ToolExecutionContext {
  runId: string;
  threadId?: string;
  state: JsonObject;
  metadata?: JsonObject;
  messages: AgentMessage[];
  signal?: AbortSignal;
}

export type ServerToolRuntimeDefinition = ToolDefinition & {
  execute?: (args: JsonObject, context: ToolExecutionContext) => Promise<JsonValue> | JsonValue;
};

type RegisteredServerToolRuntimeDefinition = ServerToolRuntimeDefinition & Required<Pick<ToolDefinition, 'toolId' | 'modelName'>>;
type RegisteredClientToolDefinition = ClientToolDefinition & Required<Pick<ToolDefinition, 'toolId' | 'modelName'>>;

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface EventSink {
  onEvent(event: CoreEvent): void | Promise<void>;
}

export interface ModelAdapterRunInput {
  runId: string;
  threadId?: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  state: JsonObject;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export type ModelAdapterEvent =
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'text-start'; textId?: string }
  | { type: 'text-delta'; textId?: string; delta: string }
  | { type: 'text-end'; textId?: string; text?: string }
  | { type: 'tool-call'; toolCallId?: string; toolId?: string; toolName: string; modelName?: string; args: JsonObject; argsText?: string }
  | { type: 'state-delta'; delta: JsonObject }
  | { type: 'done'; finishReason?: string; providerMetadata?: ModelProviderMetadata }
  | { type: 'error'; code: string; message: string; retryable?: boolean; details?: JsonObject; providerMetadata?: ModelProviderMetadata };

export interface ModelAdapter {
  metadata?: ModelProviderMetadata;
  capabilities?: ModelAdapterCapabilities;
  run(input: ModelAdapterRunInput): Promise<AsyncIterable<ModelAdapterEvent>> | AsyncIterable<ModelAdapterEvent>;
}

export interface CreateAgentRunnerOptions {
  modelAdapter: ModelAdapter;
  summaryCompressor?: ModelAdapter;
  sessionStore: SessionStore;
  threadStore?: ThreadStore;
  eventStore?: EventStore;
  eventSink?: EventSink;
  exposeReasoningEvents?: boolean;
  systemPrompt?: SystemPromptProvider;
  toolPolicy?: ToolPolicyProvider;
  skillRegistry?: AgentSkillRegistry;
}

export interface AgentRunner {
  registerTool(definition: ServerToolRuntimeDefinition): RegisteredServerToolRuntimeDefinition;
  setSystemPrompt(provider?: SystemPromptProvider): void;
  run(request: RunStartRequest): AsyncIterable<CoreEvent>;
  resume(request: RunResumeRequest): AsyncIterable<CoreEvent>;
  cancelRun(request: RunCancelRequest): Promise<CoreEvent | undefined>;
  listTools(): ToolDefinition[];
}

interface RunContext {
  runId: string;
  threadId?: string;
  messages: AgentMessage[];
  clientTools?: RegisteredClientToolDefinition[];
  state: JsonObject;
  metadata?: JsonObject;
  contextBudget?: RunContextBudget;
  isResume?: boolean;
  sequence: number;
  traceId: string;
  inputMessageIds: ReadonlySet<string>;
  triggerMessageId?: string;
}

type CoreEventPayload =
  | Omit<RunStartedEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<TextStartEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<TextDeltaEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<TextEndEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ReasoningDeltaEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ToolCallStartEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ToolCallArgsEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ToolCallEndEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ToolResultEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ModelCallStartEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<ModelCallEndEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<StateDeltaEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>
  | Omit<RunFinishedEvent, 'eventId' | 'messageId' | 'runId' | 'sequence' | 'timestamp'>;

type TraceAttributeInput = Record<string, JsonValue | undefined>;

export function createAgentRunner(options: CreateAgentRunnerOptions): AgentRunner {
  const registry = new ToolRegistry();
  const runtimeDefinitions = new Map<string, RegisteredServerToolRuntimeDefinition>();
  const activeRuns = new Map<string, { controller: AbortController; reason?: string }>();
  let systemPrompt = options.systemPrompt;

  return {
    registerTool(definition) {
      if (definition.executionPolicy === 'server' && typeof definition.execute !== 'function') {
        throw new Error(`Server tool "${definition.name}" must provide an execute handler`);
      }

      const registered = registry.register(definition) as RegisteredServerToolRuntimeDefinition;
      runtimeDefinitions.set(registered.toolId, registered);
      return registered;
    },

    listTools() {
      return registry.list();
    },

    setSystemPrompt(provider) {
      systemPrompt = provider;
    },

    async *run(request: RunStartRequest): AsyncIterable<CoreEvent> {
      const runId = request.runId ?? createId('run');
      const threadId = request.threadId ?? createId('thread');
      const messageId = createId('msg');
      const eventSink = createPersistentEventSink(options.eventSink, options.eventStore);
      const storedThread = await loadThreadSnapshot(threadId, options.threadStore);
      const storedLifecycle = normalizeThreadLifecycle(storedThread?.lifecycle);

      if (isArchivedLifecycle(storedLifecycle)) {
        const started = createEvent({ runId, sequence: 0, traceId: getTraceId(runId, request.metadata) }, messageId, {
          type: 'RUN_STARTED',
          threadId
        });
        yield* emitOne(started, eventSink);
        const errorEvent = createErrorEvent(runId, messageId, started.sequence + 1, createThreadArchivedError(threadId, storedLifecycle), {
          source: 'thread_lifecycle'
        });
        yield* emitOne(errorEvent, eventSink);
        return;
      }

      if (isContextFrozenLifecycle(storedLifecycle)) {
        const started = createEvent({ runId, sequence: 0, traceId: getTraceId(runId, request.metadata) }, messageId, {
          type: 'RUN_STARTED',
          threadId
        });
        yield* emitOne(started, eventSink);
        const errorEvent = createErrorEvent(runId, messageId, started.sequence + 1, createThreadFrozenError(threadId, storedLifecycle), {
          source: 'thread_lifecycle'
        });
        yield* emitOne(errorEvent, eventSink);
        return;
      }

      const clientTools = normalizeClientTools(request.clientTools, registry);
      const state = request.state ?? {};
      const tools = await getPolicyVisibleRunTools(registry, clientTools, {
        toolPolicy: options.toolPolicy,
        runId,
        threadId,
        state,
        metadata: request.metadata
      });
      const requestMessages = await resolveRunMessagesFromThreadSnapshot(request, options.threadStore);
      const messages = await applySystemPromptPolicy(
        requestMessages,
        {
          runId,
          threadId,
          request,
          tools
        },
        composeSystemPromptProvider(systemPrompt, options.skillRegistry)
      );
      const context: RunContext = {
        runId,
        threadId,
        messages,
        clientTools,
        metadata: request.metadata,
        contextBudget: request.contextBudget,
        isResume: false,
        state,
        sequence: 0,
        traceId: getTraceId(runId, request.metadata),
        inputMessageIds: new Set(request.messages.filter(message => message.role !== 'system').map(message => message.id)),
        triggerMessageId: getTriggerMessageId(request.messages)
      };
      await saveThreadSnapshot(context, options.threadStore);

      const started = createEvent(context, messageId, {
        type: 'RUN_STARTED',
        threadId
      });
      yield* emitOne(started, eventSink);
      context.sequence = started.sequence;

      const activeRun = beginActiveRun(activeRuns, runId);
      try {
        yield* executeRunLoop(context, {
          registry,
          runtimeDefinitions,
          modelAdapter: options.modelAdapter,
          summaryCompressor: options.summaryCompressor,
          sessionStore: options.sessionStore,
          threadStore: options.threadStore,
          eventSink,
          exposeReasoningEvents: options.exposeReasoningEvents,
          toolPolicy: options.toolPolicy,
          signal: activeRun.controller.signal
        });
      } finally {
        endActiveRun(activeRuns, runId, activeRun.controller);
      }
    },

    async *resume(request: RunResumeRequest): AsyncIterable<CoreEvent> {
      const activeRun = beginActiveRun(activeRuns, request.runId);
      const resumeMessageId = createId('msg');
      const eventSink = createPersistentEventSink(options.eventSink, options.eventStore);

      try {
        const checkpoint = await options.sessionStore.loadCheckpoint(request.runId);
        if (!checkpoint) {
          yield* emitOne(
            createErrorEvent(request.runId, resumeMessageId, 0, {
              code: 'checkpoint_not_found',
              message: `No checkpoint found for run "${request.runId}"`
            }),
            eventSink
          );
          return;
        }

        const checkpointClientTools = normalizeClientTools(checkpoint.clientTools, registry);
      const duplicateResult = checkpoint.submittedToolResults.find(result => result.toolCallId === request.toolResult.toolCallId);
      if (duplicateResult) {
        if (stableStringify(duplicateResult.output) !== stableStringify(request.toolResult.output)) {
          yield* emitOne(
            createErrorEvent(checkpoint.runId, resumeMessageId, checkpoint.sequence + 1, {
              code: 'tool_result_conflict',
              message: `Tool call "${request.toolResult.toolCallId}" was already resolved with a different payload`
            }),
            eventSink
          );
          return;
        }

        checkpoint.sequence += 1;
        yield* emitOne(
          createEvent(
            { runId: checkpoint.runId, sequence: checkpoint.sequence },
            resumeMessageId,
            {
              type: 'RUN_FINISHED',
              finishReason: 'awaiting_client_tool',
              pendingToolCallId: checkpoint.pendingToolCalls.find(call => call.toolCallId !== request.toolResult.toolCallId)?.toolCallId,
              pendingToolCallIds: checkpoint.pendingToolCalls.map(call => call.toolCallId)
            }
          ),
          eventSink
        );
        return;
      }

      const pendingTool = checkpoint.pendingToolCalls.find(call => call.toolCallId === request.toolResult.toolCallId);
      if (!pendingTool) {
        yield* emitOne(
          createErrorEvent(checkpoint.runId, resumeMessageId, checkpoint.sequence + 1, {
            code: 'invalid_tool_call_id',
            message: `Tool call "${request.toolResult.toolCallId}" is not pending for run "${checkpoint.runId}"`
          }),
          eventSink
        );
        return;
      }

      const definition = getToolDefinition(registry, checkpointClientTools, pendingTool.toolId);
      if (!definition) {
        yield* emitOne(
          createErrorEvent(checkpoint.runId, resumeMessageId, checkpoint.sequence + 1, {
            code: 'unknown_tool',
            message: `Tool "${pendingTool.toolName}" is not registered`
          }),
          eventSink
        );
        return;
      }

      const policyDecision = await evaluateToolPolicy(options.toolPolicy, {
        action: 'tool.resume',
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
        tool: definition,
        args: pendingTool.args,
        state: checkpoint.state,
        metadata: checkpoint.metadata
      });
      if (!isAllowedByToolPolicy(policyDecision)) {
        yield* emitOne(
          createErrorEvent(checkpoint.runId, resumeMessageId, checkpoint.sequence + 1, {
            code: getPolicyDecisionCode(policyDecision),
            message: getPolicyDecisionMessage(policyDecision)
          }),
          eventSink
        );
        return;
      }

      try {
        if (!request.toolResult.isError) {
          validateSchema(definition.resultSchema, request.toolResult.output, `${definition.name} tool result`);
        }
      } catch (error) {
        yield* emitOne(
          createErrorEvent(checkpoint.runId, resumeMessageId, checkpoint.sequence + 1, {
            code: 'invalid_tool_result',
            message: error instanceof Error ? error.message : 'Tool result schema validation failed'
          }),
          eventSink
        );
        return;
      }

      if (request.stateDelta) {
        checkpoint.state = {
          ...checkpoint.state,
          ...request.stateDelta
        };
      }

      const resultEnvelope: ToolResultEnvelope = {
        ...request.toolResult,
        messageId: pendingTool.messageId,
        toolId: pendingTool.toolId,
        toolName: pendingTool.toolName,
        modelName: pendingTool.modelName,
        runId: checkpoint.runId,
        submittedAt: request.toolResult.submittedAt ?? nowIso()
      };
      checkpoint.submittedToolResults.push(resultEnvelope);
      checkpoint.pendingToolCalls = checkpoint.pendingToolCalls.filter(call => call.toolCallId !== pendingTool.toolCallId);
      checkpoint.processedToolCallIds.push(pendingTool.toolCallId);
      const inputMessageIds = new Set(checkpoint.messages.map(message => message.id));
      checkpoint.messages.push(
        {
          id: createId('msg'),
          role: 'tool',
          createdAt: nowIso(),
          content: [
            {
              type: 'tool-result',
              toolCallId: pendingTool.toolCallId,
              toolId: pendingTool.toolId,
              toolName: pendingTool.toolName,
              output: resultEnvelope.output,
              isError: resultEnvelope.isError
            }
          ]
        }
      );
      await saveThreadSnapshot({
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
        messages: checkpoint.messages,
        metadata: checkpoint.metadata,
        state: checkpoint.state,
        inputMessageIds
      }, options.threadStore);

      checkpoint.sequence += 1;
      const resultEndedAt = resultEnvelope.submittedAt;
      const toolResultEvent = createEvent(
        { runId: checkpoint.runId, sequence: checkpoint.sequence, traceId: getTraceId(checkpoint.runId, checkpoint.metadata) },
        pendingTool.messageId,
        {
          type: 'TOOL_RESULT',
          toolCallId: pendingTool.toolCallId,
          toolId: pendingTool.toolId,
          toolName: pendingTool.toolName,
          modelName: pendingTool.modelName,
          toolRuntime: pendingTool.toolRuntime,
          output: resultEnvelope.output,
          isError: resultEnvelope.isError,
          trace: createToolResultTrace(
            getTraceId(checkpoint.runId, checkpoint.metadata),
            pendingTool,
            pendingTool.createdAt,
            resultEndedAt,
            resultEnvelope.isError
          )
        }
      );
      yield* emitOne(toolResultEvent, eventSink);

      if (checkpoint.pendingToolCalls.length > 0) {
        checkpoint.updatedAt = nowIso();
        await options.sessionStore.saveCheckpoint(checkpoint);
        checkpoint.sequence += 1;
        const waitingEvent = createEvent(
          { runId: checkpoint.runId, sequence: checkpoint.sequence, traceId: getTraceId(checkpoint.runId, checkpoint.metadata) },
          resumeMessageId,
          {
            type: 'RUN_FINISHED',
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: checkpoint.pendingToolCalls[0]?.toolCallId,
            pendingToolCallIds: checkpoint.pendingToolCalls.map(call => call.toolCallId)
          }
        );
        yield* emitOne(waitingEvent, eventSink);
        return;
      }

      await options.sessionStore.deleteCheckpoint(checkpoint.runId);

      yield* executeRunLoop(
        {
          runId: checkpoint.runId,
          threadId: checkpoint.threadId,
          messages: checkpoint.messages,
          clientTools: checkpointClientTools,
          metadata: checkpoint.metadata,
          contextBudget: checkpoint.contextBudget,
          isResume: true,
          state: checkpoint.state,
          sequence: checkpoint.sequence,
          traceId: getTraceId(checkpoint.runId, checkpoint.metadata),
          inputMessageIds: new Set(checkpoint.messages.map(message => message.id))
        },
        {
          registry,
          runtimeDefinitions,
          modelAdapter: options.modelAdapter,
          summaryCompressor: options.summaryCompressor,
          sessionStore: options.sessionStore,
          threadStore: options.threadStore,
          eventSink,
          exposeReasoningEvents: options.exposeReasoningEvents,
          toolPolicy: options.toolPolicy,
          signal: activeRun.controller.signal
        }
      );
      } finally {
        endActiveRun(activeRuns, request.runId, activeRun.controller);
      }
    },

    async cancelRun(request: RunCancelRequest): Promise<CoreEvent | undefined> {
      const activeRun = activeRuns.get(request.runId);
      if (activeRun) {
        activeRun.reason = request.reason;
        activeRun.controller.abort(createAbortError(request.reason ?? `Run "${request.runId}" was cancelled`));
        return undefined;
      }

      const checkpoint = await options.sessionStore.loadCheckpoint(request.runId);
      if (!checkpoint) {
        return undefined;
      }

      await options.sessionStore.deleteCheckpoint(request.runId);
      const eventSink = createPersistentEventSink(options.eventSink, options.eventStore);
      const cancelledEvent = createEvent(
        { runId: checkpoint.runId, sequence: checkpoint.sequence, traceId: getTraceId(checkpoint.runId, checkpoint.metadata) },
        createId('msg'),
        {
          type: 'RUN_FINISHED',
          finishReason: 'cancelled',
          pendingToolCallIds: checkpoint.pendingToolCalls.map(call => call.toolCallId)
        }
      );
      if (eventSink) {
        await eventSink.onEvent(cancelledEvent);
      }
      return cancelledEvent;
    }
  };
}

async function* executeRunLoop(
  context: RunContext,
  dependencies: {
    registry: ToolRegistry;
    runtimeDefinitions: Map<string, RegisteredServerToolRuntimeDefinition>;
    modelAdapter: ModelAdapter;
    summaryCompressor?: ModelAdapter;
    sessionStore: SessionStore;
    threadStore?: ThreadStore;
    eventSink?: EventSink;
    exposeReasoningEvents?: boolean;
    toolPolicy?: ToolPolicyProvider;
    signal?: AbortSignal;
  }
): AsyncIterable<CoreEvent> {
  while (true) {
    const assistantMessageId = createId('msg');
    const reasoningId = createId('rsn');
    const textId = createId('txt');
    const assistantParts: AgentMessage['content'] = [];
    const reasoningBuffer: string[] = [];
    const textBuffer: string[] = [];
    const emittedTextStart = { value: false };
    const toolCalls: ToolCallEnvelope[] = [];
    const modelCallId = createId('model');
    const modelStartedAt = nowIso();
    const modelStartedMs = Date.now();
    let modelEndEmitted = false;

    let finished = false;
    let modelFinishReason: string | undefined;

    try {
      throwIfAborted(dependencies.signal);
      const adapterMetadata = dependencies.modelAdapter.metadata;
      const tools = await getPolicyVisibleRunTools(dependencies.registry, context.clientTools, {
        toolPolicy: dependencies.toolPolicy,
        runId: context.runId,
        threadId: context.threadId,
        state: context.state,
        metadata: context.metadata
      });
      const preparedMessages = await prepareModelMessages(context, dependencies, tools);
      if ('error' in preparedMessages) {
        const errorEvent = createErrorEvent(context.runId, assistantMessageId, context.sequence + 1, preparedMessages.error, {
          source: 'context_budget',
          modelCallId,
          provider: adapterMetadata?.provider,
          model: adapterMetadata?.model
        });
        yield* emitOne(errorEvent, dependencies.eventSink);
        context.sequence = errorEvent.sequence;
        return;
      }

      const modelInput: ModelAdapterRunInput = {
        runId: context.runId,
        threadId: context.threadId,
        messages: preparedMessages.messages,
        metadata: context.metadata,
        state: context.state,
        tools,
        signal: dependencies.signal
      };
      const capabilityFailure = checkModelAdapterCapabilities(dependencies.modelAdapter.capabilities, modelInput);
      if (capabilityFailure) {
        const errorEvent = createErrorEvent(context.runId, assistantMessageId, context.sequence + 1, {
          code: capabilityFailure.code,
          message: capabilityFailure.message,
          details: capabilityFailure.details,
          retryable: false
        }, {
          source: 'model_adapter',
          modelCallId,
          provider: adapterMetadata?.provider,
          model: adapterMetadata?.model
        });
        yield* emitOne(errorEvent, dependencies.eventSink);
        context.sequence = errorEvent.sequence;
        return;
      }
      const modelStartEvent = createEvent(context, assistantMessageId, {
        type: 'MODEL_CALL_START',
        modelCallId,
        provider: adapterMetadata?.provider,
        model: adapterMetadata?.model,
        trace: createModelCallTrace(context.traceId, modelCallId, assistantMessageId, adapterMetadata, modelStartedAt)
      });
      yield* emitOne(modelStartEvent, dependencies.eventSink);
      context.sequence = modelStartEvent.sequence;

      const modelStream = await dependencies.modelAdapter.run(modelInput);

      for await (const event of modelStream) {
        throwIfAborted(dependencies.signal);
        switch (event.type) {
          case 'reasoning-delta': {
            reasoningBuffer.push(event.delta);
            if (dependencies.exposeReasoningEvents) {
              const reasoningEvent = createEvent(context, assistantMessageId, {
                type: 'REASONING_DELTA',
                reasoningId,
                delta: event.delta
              });
              yield* emitOne(reasoningEvent, dependencies.eventSink);
              context.sequence = reasoningEvent.sequence;
            }
            break;
          }
          case 'text-start': {
            if (!emittedTextStart.value) {
              const textStart = createEvent(context, assistantMessageId, {
                type: 'TEXT_START',
                textId: event.textId ?? textId,
                role: 'assistant'
              });
              yield* emitOne(textStart, dependencies.eventSink);
              context.sequence = textStart.sequence;
              emittedTextStart.value = true;
            }
            break;
          }
          case 'text-delta': {
            if (!emittedTextStart.value) {
              const textStart = createEvent(context, assistantMessageId, {
                type: 'TEXT_START',
                textId: event.textId ?? textId,
                role: 'assistant'
              });
              yield* emitOne(textStart, dependencies.eventSink);
              context.sequence = textStart.sequence;
              emittedTextStart.value = true;
            }

            textBuffer.push(event.delta);
            const deltaEvent = createEvent(context, assistantMessageId, {
              type: 'TEXT_DELTA',
              textId: event.textId ?? textId,
              delta: event.delta
            });
            yield* emitOne(deltaEvent, dependencies.eventSink);
            context.sequence = deltaEvent.sequence;
            break;
          }
          case 'text-end': {
            const text = event.text ?? textBuffer.join('');
            if (text) {
              assistantParts.push({
                type: 'text',
                text
              });
              const endEvent = createEvent(context, assistantMessageId, {
                type: 'TEXT_END',
                textId: event.textId ?? textId,
                text
              });
              yield* emitOne(endEvent, dependencies.eventSink);
              context.sequence = endEvent.sequence;
            }
            break;
          }
          case 'tool-call': {
            const definition = resolveToolDefinition(dependencies.registry, context.clientTools, event);
            if (!definition) {
              const errorEvent = createErrorEvent(context.runId, assistantMessageId, context.sequence + 1, {
                code: 'unknown_tool',
                message: `Tool "${event.modelName ?? event.toolId ?? event.toolName}" is not registered`
              });
              yield* emitOne(errorEvent, dependencies.eventSink);
              return;
            }

            validateSchema(definition.inputSchema, event.args, `${definition.name} tool arguments`);

            const toolCallId = event.toolCallId ?? createId('tool');
            const toolEnvelope: ToolCallEnvelope = {
              runId: context.runId,
              messageId: assistantMessageId,
              toolCallId,
              toolId: definition.toolId,
              toolName: definition.name,
              modelName: definition.modelName,
              toolRuntime: inferToolRuntime(definition.executionPolicy),
              executionPolicy: definition.executionPolicy,
              timeoutMs: definition.timeoutMs,
              args: event.args,
              createdAt: nowIso()
            };
            toolCalls.push(toolEnvelope);
            assistantParts.push({
              type: 'tool-call',
              toolCallId,
              toolId: definition.toolId,
              toolName: definition.name,
              modelName: definition.modelName,
              args: event.args,
              executionPolicy: definition.executionPolicy
            });

            const startEvent = createEvent(context, assistantMessageId, {
              type: 'TOOL_CALL_START',
              toolCallId,
              toolId: definition.toolId,
              toolName: definition.name,
              modelName: definition.modelName,
              toolRuntime: inferToolRuntime(definition.executionPolicy),
              timeoutMs: definition.timeoutMs,
              executionPolicy: definition.executionPolicy
            });
            yield* emitOne(startEvent, dependencies.eventSink);
            context.sequence = startEvent.sequence;

            const argsEvent = createEvent(context, assistantMessageId, {
              type: 'TOOL_CALL_ARGS',
              toolCallId,
              toolId: definition.toolId,
              delta: event.argsText,
              args: event.args
            });
            yield* emitOne(argsEvent, dependencies.eventSink);
            context.sequence = argsEvent.sequence;

            const endEvent = createEvent(context, assistantMessageId, {
              type: 'TOOL_CALL_END',
              toolCallId,
              toolId: definition.toolId,
              toolName: definition.name,
              modelName: definition.modelName,
              toolRuntime: inferToolRuntime(definition.executionPolicy),
              executionPolicy: definition.executionPolicy,
              timeoutMs: definition.timeoutMs,
              args: event.args
            });
            yield* emitOne(endEvent, dependencies.eventSink);
            context.sequence = endEvent.sequence;
            break;
          }
          case 'state-delta': {
            context.state = {
              ...context.state,
              ...event.delta
            };
            const stateEvent = createEvent(context, assistantMessageId, {
              type: 'STATE_DELTA',
              delta: event.delta
            });
            yield* emitOne(stateEvent, dependencies.eventSink);
            context.sequence = stateEvent.sequence;
            break;
          }
          case 'done': {
            finished = true;
            modelFinishReason = event.finishReason;
            const metadata = mergeProviderMetadata(dependencies.modelAdapter.metadata, event.providerMetadata);
            const modelEndedAt = nowIso();
            const modelEndEvent = createEvent(context, assistantMessageId, {
              type: 'MODEL_CALL_END',
              modelCallId,
              status: event.finishReason === 'cancelled' ? 'cancelled' : 'completed',
              finishReason: event.finishReason,
              provider: metadata.provider,
              model: metadata.model,
              providerRequestId: metadata.requestId,
              usage: metadata.usage,
              trace: createModelCallTrace(
                context.traceId,
                modelCallId,
                assistantMessageId,
                metadata,
                modelStartedAt,
                modelEndedAt,
                Date.now() - modelStartedMs,
                event.finishReason === 'cancelled' ? 'cancelled' : 'completed',
                event.finishReason
              )
            });
            yield* emitOne(modelEndEvent, dependencies.eventSink);
            context.sequence = modelEndEvent.sequence;
            modelEndEmitted = true;
            const content = createAssistantMessageContent(reasoningBuffer, assistantParts);
            if (content.length > 0) {
              context.messages.push({
                id: assistantMessageId,
                role: 'assistant',
                content,
                createdAt: nowIso()
              });
              await saveThreadSnapshot(context, dependencies.threadStore);
            }
            break;
          }
          case 'error': {
            const metadata = mergeProviderMetadata(dependencies.modelAdapter.metadata, event.providerMetadata);
            const modelEndedAt = nowIso();
            const modelEndEvent = createEvent(context, assistantMessageId, {
              type: 'MODEL_CALL_END',
              modelCallId,
              status: 'error',
              provider: metadata.provider,
              model: metadata.model,
              providerRequestId: metadata.requestId,
              usage: metadata.usage,
              trace: createModelCallTrace(
                context.traceId,
                modelCallId,
                assistantMessageId,
                metadata,
                modelStartedAt,
                modelEndedAt,
                Date.now() - modelStartedMs,
                'error',
                event.code
              )
            });
            yield* emitOne(modelEndEvent, dependencies.eventSink);
            context.sequence = modelEndEvent.sequence;
            modelEndEmitted = true;
            const errorEvent = createErrorEvent(context.runId, assistantMessageId, context.sequence + 1, {
              code: event.code,
              message: event.message,
              retryable: event.retryable,
              details: event.details
            }, {
              source: 'provider',
              modelCallId,
              provider: metadata.provider,
              model: metadata.model,
              providerRequestId: metadata.requestId
            });
            yield* emitOne(errorEvent, dependencies.eventSink);
            return;
          }
        }
      }
    } catch (error) {
      if (isAbortError(error) || dependencies.signal?.aborted) {
        yield* emitCancelledRun(context, assistantMessageId, {
          modelCallId,
          modelStartedAt,
          modelStartedMs,
          modelEndEmitted,
          metadata: dependencies.modelAdapter.metadata,
          eventSink: dependencies.eventSink
        });
        return;
      }

      const runError = normalizeRunError(error);
      const metadata = dependencies.modelAdapter.metadata;
      if (!modelEndEmitted) {
        const modelEndedAt = nowIso();
        const modelEndEvent = createEvent(context, assistantMessageId, {
          type: 'MODEL_CALL_END',
          modelCallId,
          status: 'error',
          provider: metadata?.provider,
          model: metadata?.model,
          providerRequestId: metadata?.requestId,
          trace: createModelCallTrace(
            context.traceId,
            modelCallId,
            assistantMessageId,
            metadata,
            modelStartedAt,
            modelEndedAt,
            Date.now() - modelStartedMs,
            'error',
            runError.code
          )
        });
        yield* emitOne(modelEndEvent, dependencies.eventSink);
        context.sequence = modelEndEvent.sequence;
        modelEndEmitted = true;
      }
      const errorEvent = createErrorEvent(context.runId, assistantMessageId, context.sequence + 1, runError, {
        source: 'model_adapter',
        modelCallId,
        provider: metadata?.provider,
        model: metadata?.model,
        providerRequestId: metadata?.requestId
      });
      yield* emitOne(errorEvent, dependencies.eventSink);
      return;
    }

    if (dependencies.signal?.aborted) {
      yield* emitCancelledRun(context, assistantMessageId, {
        modelCallId,
        modelStartedAt,
        modelStartedMs,
        modelEndEmitted,
        metadata: dependencies.modelAdapter.metadata,
        eventSink: dependencies.eventSink
      });
      return;
    }

    if (!modelEndEmitted) {
      const metadata = dependencies.modelAdapter.metadata;
      const modelEndedAt = nowIso();
      const modelEndEvent = createEvent(context, assistantMessageId, {
        type: 'MODEL_CALL_END',
        modelCallId,
        status: 'completed',
        finishReason: 'stream_exhausted',
        provider: metadata?.provider,
        model: metadata?.model,
        providerRequestId: metadata?.requestId,
        usage: metadata?.usage,
        trace: createModelCallTrace(
          context.traceId,
          modelCallId,
          assistantMessageId,
          metadata,
          modelStartedAt,
          modelEndedAt,
          Date.now() - modelStartedMs,
          'completed',
          'stream_exhausted'
        )
      });
      yield* emitOne(modelEndEvent, dependencies.eventSink);
      context.sequence = modelEndEvent.sequence;
      modelEndEmitted = true;
    }

    if (!finished) {
      const content = createAssistantMessageContent(reasoningBuffer, assistantParts);
      if (content.length > 0) {
        context.messages.push({
          id: assistantMessageId,
          role: 'assistant',
          content,
          createdAt: nowIso()
        });
        await saveThreadSnapshot(context, dependencies.threadStore);
      }
    }

    if (toolCalls.length === 0) {
      await saveThreadSnapshot(context, dependencies.threadStore);
      const finishedEvent = createEvent(context, assistantMessageId, {
        type: 'RUN_FINISHED',
        finishReason: modelFinishReason === 'cancelled' ? 'cancelled' : 'completed'
      });
      yield* emitOne(finishedEvent, dependencies.eventSink);
      return;
    }

    const pendingClientCalls: ToolCallEnvelope[] = [];

    for (const toolCall of toolCalls) {
      if (dependencies.signal?.aborted) {
        yield* emitCancelledRun(context, assistantMessageId, {
          modelCallId,
          modelStartedAt,
          modelStartedMs,
          modelEndEmitted: true,
          metadata: dependencies.modelAdapter.metadata,
          eventSink: dependencies.eventSink
        });
        return;
      }

      const definition = getToolDefinition(dependencies.registry, context.clientTools, toolCall.toolId);
      if (!definition) {
        const errorEvent = createErrorEvent(context.runId, toolCall.messageId, context.sequence + 1, {
          code: 'unknown_tool',
          message: `Tool "${toolCall.toolName}" is not registered`
        });
        yield* emitOne(errorEvent, dependencies.eventSink);
        return;
      }

      const policyDecision = await evaluateToolPolicy(dependencies.toolPolicy, {
        action: 'tool.execute',
        runId: context.runId,
        threadId: context.threadId,
        tool: definition,
        args: toolCall.args,
        state: context.state,
        metadata: context.metadata
      });
      if (!isAllowedByToolPolicy(policyDecision)) {
        yield* emitPolicyBlockedToolResult(context, toolCall, policyDecision, dependencies.threadStore, dependencies.eventSink);
        continue;
      }

      if (!isServerTool(definition)) {
        pendingClientCalls.push(toolCall);
        continue;
      }

      const runtimeDefinition = dependencies.runtimeDefinitions.get(toolCall.toolId);
      if (!runtimeDefinition) {
        const errorEvent = createErrorEvent(context.runId, toolCall.messageId, context.sequence + 1, {
          code: 'unknown_tool',
          message: `Server tool "${toolCall.toolName}" is not registered`
        });
        yield* emitOne(errorEvent, dependencies.eventSink);
        return;
      }

      try {
        const toolStartedAt = nowIso();
        const toolStartedMs = Date.now();
        const output = await withTimeout(
          Promise.resolve(runtimeDefinition.execute?.(toolCall.args, {
            runId: context.runId,
            threadId: context.threadId,
            messages: context.messages,
            metadata: context.metadata,
            state: context.state,
            signal: dependencies.signal
          })),
          getToolTimeoutMs(definition),
          definition.name,
          dependencies.signal
        );
        validateSchema(definition.resultSchema, output, `${toolCall.toolName} tool result`);
        const toolEndedAt = nowIso();
        context.messages.push(
          {
            id: createId('msg'),
            role: 'tool',
            createdAt: nowIso(),
            content: [
              {
                type: 'tool-result',
                toolCallId: toolCall.toolCallId,
                toolId: toolCall.toolId,
                toolName: toolCall.toolName,
                output: output as JsonValue
              }
            ]
          }
        );
        await saveThreadSnapshot(context, dependencies.threadStore);
        context.sequence += 1;
        const resultEvent = createEvent(context, toolCall.messageId, {
          type: 'TOOL_RESULT',
          toolCallId: toolCall.toolCallId,
          toolId: toolCall.toolId,
          toolName: toolCall.toolName,
          modelName: toolCall.modelName,
          toolRuntime: toolCall.toolRuntime,
          output: output as JsonValue,
          trace: createToolResultTrace(context.traceId, toolCall, toolStartedAt, toolEndedAt, false, Date.now() - toolStartedMs)
        });
        yield* emitOne(resultEvent, dependencies.eventSink);
        context.sequence = resultEvent.sequence;
      } catch (error) {
        if (isAbortError(error) || dependencies.signal?.aborted) {
          yield* emitCancelledRun(context, assistantMessageId, {
            modelCallId,
            modelStartedAt,
            modelStartedMs,
            modelEndEmitted: true,
            metadata: dependencies.modelAdapter.metadata,
            eventSink: dependencies.eventSink
          });
          return;
        }

        const toolEndedAt = nowIso();
        const toolError = normalizeError(error);
        context.messages.push(
          {
            id: createId('msg'),
            role: 'tool',
            createdAt: nowIso(),
            content: [
              {
                type: 'tool-result',
                toolCallId: toolCall.toolCallId,
                toolId: toolCall.toolId,
                toolName: toolCall.toolName,
                output: {
                  code: toolError.code,
                  message: toolError.message
                },
                isError: true
              }
            ]
          }
        );
        await saveThreadSnapshot(context, dependencies.threadStore);
        context.sequence += 1;
        const resultEvent = createEvent(context, toolCall.messageId, {
          type: 'TOOL_RESULT',
          toolCallId: toolCall.toolCallId,
          toolId: toolCall.toolId,
          toolName: toolCall.toolName,
          modelName: toolCall.modelName,
          toolRuntime: toolCall.toolRuntime,
          output: {
            code: toolError.code,
            message: toolError.message
          },
          isError: true,
          trace: createToolResultTrace(context.traceId, toolCall, toolCall.createdAt, toolEndedAt, true)
        });
        yield* emitOne(resultEvent, dependencies.eventSink);
        context.sequence = resultEvent.sequence;
      }
    }

    if (pendingClientCalls.length > 0) {
      await saveThreadSnapshot(context, dependencies.threadStore);
      const checkpoint: RunCheckpoint = {
        runId: context.runId,
        threadId: context.threadId,
        sequence: context.sequence,
        messages: context.messages,
        metadata: context.metadata,
        clientTools: context.clientTools,
        contextBudget: context.contextBudget,
        pendingToolCalls: pendingClientCalls,
        processedToolCallIds: [],
        state: context.state,
        submittedToolResults: [],
        updatedAt: nowIso()
      };
      await dependencies.sessionStore.saveCheckpoint(checkpoint);

      const waitingEvent = createEvent(context, assistantMessageId, {
        type: 'RUN_FINISHED',
        finishReason: 'awaiting_client_tool',
        pendingToolCallId: pendingClientCalls[0]?.toolCallId,
        pendingToolCallIds: pendingClientCalls.map(call => call.toolCallId)
      });
      yield* emitOne(waitingEvent, dependencies.eventSink);
      return;
    }
  }
}

async function resolveRunMessagesFromThreadSnapshot(
  request: RunStartRequest,
  threadStore?: ThreadStore
): Promise<AgentMessage[]> {
  if (!threadStore || !request.threadId) {
    return request.messages;
  }

  const stored = await threadStore.loadThread(request.threadId);
  if (!stored) {
    return request.messages;
  }

  return mergeStoredThreadMessages(stored.messages, request.messages);
}

function mergeStoredThreadMessages(storedMessages: AgentMessage[], requestMessages: AgentMessage[]): AgentMessage[] {
  const requestSystemMessages = requestMessages.filter(message => message.role === 'system');
  const mergedMessages = storedMessages.filter(message => message.role !== 'system');
  const mergedIds = new Set(mergedMessages.map(message => message.id));

  for (const message of requestMessages) {
    if (message.role === 'system' || mergedIds.has(message.id)) {
      continue;
    }

    mergedMessages.push(message);
    mergedIds.add(message.id);
  }

  return [
    ...requestSystemMessages,
    ...mergedMessages
  ];
}

async function loadThreadSnapshot(threadId: string | undefined, threadStore?: ThreadStore): Promise<StoredThread | null> {
  if (!threadStore || !threadId) {
    return null;
  }

  return threadStore.loadThread(threadId);
}

type ArchivedThreadLifecycle = ThreadLifecycle & {
  userState: Extract<ThreadLifecycle['userState'], { state: 'archived' }>;
};

type FrozenThreadLifecycle = ThreadLifecycle & {
  contextState: Extract<ThreadLifecycle['contextState'], { state: 'frozen' }>;
};

function createActiveThreadLifecycle(): ThreadLifecycle {
  return {
    userState: { state: 'active' },
    contextState: { state: 'ok' }
  };
}

function normalizeThreadLifecycle(lifecycle: ThreadLifecycle | undefined): ThreadLifecycle {
  return lifecycle ?? createActiveThreadLifecycle();
}

function isArchivedLifecycle(lifecycle: ThreadLifecycle): lifecycle is ArchivedThreadLifecycle {
  return lifecycle.userState.state === 'archived';
}

function isContextFrozenLifecycle(
  lifecycle: ThreadLifecycle
): lifecycle is FrozenThreadLifecycle {
  return lifecycle.contextState.state === 'frozen';
}

function createThreadArchivedError(
  threadId: string,
  lifecycle: ArchivedThreadLifecycle
): RunErrorEvent['error'] {
  return {
    code: 'thread_archived',
    message: `Thread "${threadId}" is archived and cannot accept new runs`,
    retryable: false,
    details: {
      threadId,
      userState: lifecycle.userState.state,
      contextState: lifecycle.contextState.state,
      archivedAt: lifecycle.userState.archivedAt,
      ...(lifecycle.userState.archivedBy ? { archivedBy: lifecycle.userState.archivedBy } : {})
    }
  };
}

function createThreadFrozenError(
  threadId: string,
  lifecycle: FrozenThreadLifecycle
): RunErrorEvent['error'] {
  const frozen = lifecycle.contextState;
  return {
    code: 'thread_context_frozen',
    message: `Thread "${threadId}" is frozen because its compressed context exceeds the model budget`,
    retryable: false,
    details: {
      threadId,
      userState: lifecycle.userState.state,
      contextState: frozen.state,
      reason: frozen.reason,
      frozenAt: frozen.frozenAt,
      frozenByRunId: frozen.frozenByRunId,
      estimatedInputTokens: frozen.estimatedInputTokens,
      maxInputTokens: frozen.maxInputTokens,
      ...(frozen.lastSummaryMessageId ? { lastSummaryMessageId: frozen.lastSummaryMessageId } : {})
    }
  };
}

async function prepareModelMessages(
  context: RunContext,
  dependencies: {
    modelAdapter: ModelAdapter;
    summaryCompressor?: ModelAdapter;
    threadStore?: ThreadStore;
    signal?: AbortSignal;
  },
  tools: ToolDefinition[]
): Promise<{ messages: AgentMessage[] } | { error: RunErrorEvent['error'] }> {
  let messages = selectSummaryWindowMessages(context.messages);
  const budget = resolveRunContextBudget({
    contextWindowTokens: dependencies.modelAdapter.capabilities?.limits?.contextWindowTokens,
    maxOutputTokens: dependencies.modelAdapter.capabilities?.limits?.maxOutputTokens,
    requestBudget: context.contextBudget
  });
  if (!budget) {
    return { messages };
  }

  let estimatedInputTokens = estimateModelInputTokens({ messages, tools });
  const triggerDecision = shouldCreateSummaryMessage({
    estimatedInputTokens,
    selectedMessageCount: context.messages.filter(message => message.role !== 'system').length,
    hasThreadStore: Boolean(dependencies.threadStore),
    hasThreadId: Boolean(context.threadId),
    isResume: context.isResume ?? false,
    hasPendingToolResults: false,
    budget
  });

  if (triggerDecision.shouldCreate && dependencies.summaryCompressor) {
    const summaryCreated = await createSummaryMessage(context, dependencies, budget);
    if (summaryCreated) {
      await saveThreadSnapshot(context, dependencies.threadStore);
      messages = selectSummaryWindowMessages(context.messages);
      estimatedInputTokens = estimateModelInputTokens({ messages, tools });
    }
  }

  if (estimatedInputTokens > budget.maxInputTokens) {
    if (shouldFreezeThreadForContextBudget(context, messages, tools, budget)) {
      await saveThreadSnapshot({
        ...context,
        lifecycle: createContextFrozenLifecycle(context, messages, tools, budget)
      }, dependencies.threadStore);
    }

    return {
      error: {
        code: 'context_budget_exceeded',
        message: `Estimated model input is ${estimatedInputTokens} tokens, above the max input budget of ${budget.maxInputTokens} tokens`,
        retryable: false,
        details: {
          estimatedInputTokens,
          maxInputTokens: budget.maxInputTokens,
          triggerTokens: budget.triggerTokens,
          targetTokens: budget.targetTokens
        }
      }
    };
  }

  return { messages };
}

function shouldFreezeThreadForContextBudget(
  context: RunContext,
  selectedMessages: AgentMessage[],
  tools: ToolDefinition[],
  budget: ResolvedContextBudget
): boolean {
  if (!findLastSummaryMessageId(selectedMessages)) {
    return false;
  }

  const existingContinuationMessages = selectedMessages.filter(message => !context.inputMessageIds.has(message.id));
  const hasThreadContinuation = existingContinuationMessages.some(message => message.role !== 'system');
  if (!hasThreadContinuation) {
    return false;
  }

  return estimateModelInputTokens({ messages: existingContinuationMessages, tools }) > budget.maxInputTokens;
}

function createContextFrozenLifecycle(
  context: RunContext,
  selectedMessages: AgentMessage[],
  tools: ToolDefinition[],
  budget: ResolvedContextBudget
): ThreadLifecycle {
  return {
    userState: { state: 'active' },
    contextState: {
      state: 'frozen',
      reason: 'context_budget_exhausted',
      frozenAt: nowIso(),
      frozenByRunId: context.runId,
      estimatedInputTokens: estimateModelInputTokens({ messages: selectedMessages, tools }),
      maxInputTokens: budget.maxInputTokens,
      lastSummaryMessageId: findLastSummaryMessageId(selectedMessages)
    }
  };
}

function findLastSummaryMessageId(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'summary') {
      return message.id;
    }
  }

  return undefined;
}

async function createSummaryMessage(
  context: RunContext,
  dependencies: {
    summaryCompressor?: ModelAdapter;
    threadStore?: ThreadStore;
    signal?: AbortSignal;
  },
  budget: ResolvedContextBudget
): Promise<boolean> {
  if (!dependencies.summaryCompressor || !context.threadId) {
    return false;
  }

  const plan = createSummaryInsertionPlan(context.messages);
  if (!plan) {
    return false;
  }

  const toolFacts = extractSummaryToolFacts(plan.coveredMessages);
  const compressorInput: SummaryCompressorInput = {
    threadId: context.threadId,
    coveredMessages: plan.coveredMessages,
    toolFacts,
    retainedWindowPreview: plan.retainedWindowPreview,
    targetTokens: budget.targetTokens
  };
  const summaryText = await runSummaryCompressor(dependencies.summaryCompressor, context, compressorInput, dependencies.signal);
  if (!summaryText) {
    return false;
  }

  const summaryMessage: AgentMessage = {
    id: createId('msg'),
    role: 'summary',
    createdAt: nowIso(),
    content: [{ type: 'text', text: summaryText }]
  };
  context.messages = [
    ...context.messages.slice(0, plan.insertBeforeIndex),
    summaryMessage,
    ...context.messages.slice(plan.insertBeforeIndex)
  ];

  return true;
}

function createSummaryInsertionPlan(messages: AgentMessage[]): {
  insertBeforeIndex: number;
  coveredMessages: AgentMessage[];
  retainedWindowPreview: AgentMessage[];
} | undefined {
  const insertBeforeIndex = findLastUserIndex(messages);
  if (insertBeforeIndex <= 0) {
    return undefined;
  }

  const coveredMessages = messages
    .slice(0, insertBeforeIndex)
    .filter(message => message.role !== 'system');
  if (coveredMessages.length < 2) {
    return undefined;
  }

  return {
    insertBeforeIndex,
    coveredMessages,
    retainedWindowPreview: messages.slice(insertBeforeIndex)
  };
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }

  return -1;
}

async function runSummaryCompressor(
  compressor: ModelAdapter,
  context: RunContext,
  input: SummaryCompressorInput,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const compressorMessages = buildSummaryCompressorMessages(input);
    const stream = await compressor.run({
      runId: `${context.runId}-summary`,
      threadId: context.threadId,
      messages: compressorMessages,
      tools: [],
      state: context.state,
      metadata: context.metadata,
      signal
    });
    let deltaBuffer = '';
    let finalText: string | undefined;

    for await (const event of stream) {
      throwIfAborted(signal);
      if (event.type === 'text-delta') {
        deltaBuffer += event.delta;
      } else if (event.type === 'text-end') {
        finalText = event.text ?? deltaBuffer;
      } else if (event.type === 'error') {
        return undefined;
      }
    }

    return normalizeSummaryCompressorText(finalText ?? deltaBuffer);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }

    return undefined;
  }
}

function normalizeSummaryCompressorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseSummaryCompressorJson(trimmed);
  const summaryText = parsed?.summaryText?.trim() ?? trimmed;
  return summaryText.startsWith('Summary:') ? summaryText : undefined;
}

function parseSummaryCompressorJson(text: string): SummaryCompressorOutput | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as SummaryCompressorOutput).summaryText === 'string') {
      return parsed as SummaryCompressorOutput;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function createEvent(context: Pick<RunContext, 'sequence' | 'runId'> & Partial<Pick<RunContext, 'traceId'>>, messageId: string, event: CoreEventPayload): CoreEvent {
  const timestamp = nowIso();
  return {
    ...event,
    eventId: createId('evt'),
    messageId,
    runId: context.runId,
    sequence: context.sequence + 1,
    timestamp,
    trace: event.trace ?? createDefaultTrace(context.runId, context.traceId ?? context.runId, messageId, event, timestamp)
  } as CoreEvent;
}

function createErrorEvent(
  runId: string,
  messageId: string,
  sequence: number,
  error: RunErrorEvent['error'],
  traceAttributes: TraceAttributeInput = {}
): RunErrorEvent {
  const timestamp = nowIso();
  return {
    eventId: createId('evt'),
    type: 'RUN_ERROR',
    runId,
    messageId,
    sequence,
    timestamp,
    trace: {
      traceId: runId,
      spanId: messageId,
      name: 'RUN_ERROR',
      kind: 'run',
      startedAt: timestamp,
      endedAt: timestamp,
      attributes: {
        errorCode: error.code,
        retryable: error.retryable ?? false,
        ...compactJsonObject(traceAttributes)
      }
    },
    error
  };
}

async function* emitOne(event: CoreEvent, sink?: EventSink): AsyncIterable<CoreEvent> {
  if (sink) {
    await sink.onEvent(event);
  }

  yield event;
}

async function* emitPolicyBlockedToolResult(
  context: RunContext,
  toolCall: ToolCallEnvelope,
  decision: ToolPolicyDecision,
  threadStore: ThreadStore | undefined,
  eventSink: EventSink | undefined
): AsyncIterable<CoreEvent> {
  const output: JsonObject = {
    code: getPolicyDecisionCode(decision),
    message: getPolicyDecisionMessage(decision)
  };
  context.messages.push(
    {
      id: createId('msg'),
      role: 'tool',
      createdAt: nowIso(),
      content: [
        {
          type: 'tool-result',
          toolCallId: toolCall.toolCallId,
          toolId: toolCall.toolId,
          toolName: toolCall.toolName,
          output,
          isError: true
        }
      ]
    }
  );
  await saveThreadSnapshot(context, threadStore);
  context.sequence += 1;
  const toolEndedAt = nowIso();
  const resultEvent = createEvent(context, toolCall.messageId, {
    type: 'TOOL_RESULT',
    toolCallId: toolCall.toolCallId,
    toolId: toolCall.toolId,
    toolName: toolCall.toolName,
    modelName: toolCall.modelName,
    toolRuntime: toolCall.toolRuntime,
    output,
    isError: true,
    trace: createToolResultTrace(context.traceId, toolCall, toolCall.createdAt, toolEndedAt, true)
  });
  yield* emitOne(resultEvent, eventSink);
  context.sequence = resultEvent.sequence;
}

function createPersistentEventSink(eventSink?: EventSink, eventStore?: EventStore): EventSink | undefined {
  if (!eventSink && !eventStore) {
    return undefined;
  }

  return {
    async onEvent(event) {
      if (eventStore) {
        await eventStore.appendEvent(event);
      }

      if (eventSink) {
        await eventSink.onEvent(event);
      }
    }
  };
}

function beginActiveRun(
  activeRuns: Map<string, { controller: AbortController; reason?: string }>,
  runId: string
): { controller: AbortController; reason?: string } {
  const existing = activeRuns.get(runId);
  if (existing && !existing.controller.signal.aborted) {
    throw new Error(`Run "${runId}" is already active`);
  }

  const activeRun = {
    controller: new AbortController()
  };
  activeRuns.set(runId, activeRun);
  return activeRun;
}

function endActiveRun(
  activeRuns: Map<string, { controller: AbortController; reason?: string }>,
  runId: string,
  controller: AbortController
): void {
  if (activeRuns.get(runId)?.controller === controller) {
    activeRuns.delete(runId);
  }
}

async function* emitCancelledRun(
  context: RunContext,
  messageId: string,
  options: {
    modelCallId: string;
    modelStartedAt: string;
    modelStartedMs: number;
    modelEndEmitted: boolean;
    metadata?: ModelProviderMetadata;
    eventSink?: EventSink;
  }
): AsyncIterable<CoreEvent> {
  if (!options.modelEndEmitted) {
    const modelEndedAt = nowIso();
    const modelEndEvent = createEvent(context, messageId, {
      type: 'MODEL_CALL_END',
      modelCallId: options.modelCallId,
      status: 'cancelled',
      finishReason: 'cancelled',
      provider: options.metadata?.provider,
      model: options.metadata?.model,
      providerRequestId: options.metadata?.requestId,
      usage: options.metadata?.usage,
      trace: createModelCallTrace(
        context.traceId,
        options.modelCallId,
        messageId,
        options.metadata,
        options.modelStartedAt,
        modelEndedAt,
        Date.now() - options.modelStartedMs,
        'cancelled',
        'cancelled'
      )
    });
    yield* emitOne(modelEndEvent, options.eventSink);
    context.sequence = modelEndEvent.sequence;
  }

  const cancelledEvent = createEvent(context, messageId, {
    type: 'RUN_FINISHED',
    finishReason: 'cancelled'
  });
  yield* emitOne(cancelledEvent, options.eventSink);
  context.sequence = cancelledEvent.sequence;
}

async function saveThreadSnapshot(
  context: Pick<RunContext, 'runId' | 'threadId' | 'messages' | 'state' | 'metadata' | 'inputMessageIds' | 'triggerMessageId'> & {
    lifecycle?: ThreadLifecycle;
  },
  threadStore?: ThreadStore
): Promise<void> {
  if (!threadStore || !context.threadId) {
    return;
  }

  const existing = await threadStore.loadThread(context.threadId);
  const messageIndex: Record<string, ThreadMessageIndexEntry> = {};

  for (const message of context.messages) {
    const previous = existing?.messageIndex?.[message.id];
    const entry: ThreadMessageIndexEntry = previous ? structuredClone(previous) : {};

    if (message.id === context.triggerMessageId) {
      entry.triggeredRunId ??= context.runId;
    } else if (context.inputMessageIds.has(message.id)) {
      // Historical input messages may not have source metadata yet. Do not
      // attribute them to the current run.
    } else if (message.role === 'user') {
      entry.triggeredRunId ??= context.runId;
    } else {
      entry.createdByRunId ??= context.runId;
    }

    if (entry.createdByRunId || entry.triggeredRunId) {
      messageIndex[message.id] = entry;
    }
  }

  await threadStore.saveThread({
    threadId: context.threadId,
    messages: context.messages,
    messageIndex,
    lifecycle: context.lifecycle ?? normalizeThreadLifecycle(existing?.lifecycle),
    state: context.state,
    metadata: context.metadata,
    updatedAt: nowIso()
  });
}

function getTriggerMessageId(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]?.id;
    }
  }

  return undefined;
}

function getTraceId(runId: string, metadata?: JsonObject): string {
  const traceId = metadata?.traceId;
  return typeof traceId === 'string' && traceId.trim() ? traceId : runId;
}

function createDefaultTrace(runId: string, traceId: string, messageId: string, event: CoreEventPayload, timestamp: string): TraceMetadata {
  const attributes = createTraceAttributes(event);

  return {
    traceId,
    spanId: getSpanId(messageId, event),
    name: event.type,
    kind: getTraceKind(event.type),
    startedAt: timestamp,
    attributes: {
      runId,
      ...attributes
    }
  };
}

function createToolResultTrace(
  traceId: string,
  toolCall: ToolCallEnvelope,
  startedAt: string,
  endedAt: string,
  isError?: boolean,
  durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
): TraceMetadata {
  return {
    traceId,
    spanId: toolCall.toolCallId,
    parentSpanId: toolCall.messageId,
    name: `tool:${toolCall.toolName}`,
    kind: 'tool',
    startedAt,
    endedAt,
    durationMs,
    attributes: {
      toolId: toolCall.toolId,
      toolName: toolCall.toolName,
      modelName: toolCall.modelName,
      toolRuntime: toolCall.toolRuntime,
      executionPolicy: toolCall.executionPolicy,
      isError: isError ?? false
    }
  };
}

function createModelCallTrace(
  traceId: string,
  modelCallId: string,
  messageId: string,
  metadata: ModelProviderMetadata | undefined,
  startedAt: string,
  endedAt?: string,
  durationMs?: number,
  status: ModelCallEndEvent['status'] = 'running',
  finishReason?: string
): TraceMetadata {
  return {
    traceId,
    spanId: modelCallId,
    parentSpanId: messageId,
    name: metadata?.model ? `model:${metadata.model}` : 'model',
    kind: 'model',
    startedAt,
    endedAt,
    durationMs,
    attributes: compactJsonObject({
      provider: metadata?.provider,
      model: metadata?.model,
      providerRequestId: metadata?.requestId,
      inputTokens: metadata?.usage?.inputTokens,
      outputTokens: metadata?.usage?.outputTokens,
      totalTokens: metadata?.usage?.totalTokens,
      rawFinishReason: metadata?.rawFinishReason,
      finishReason,
      status
    })
  };
}

function mergeProviderMetadata(
  base: ModelProviderMetadata | undefined,
  override: ModelProviderMetadata | undefined
): ModelProviderMetadata {
  const usage = {
    ...base?.usage,
    ...override?.usage
  };

  return {
    ...base,
    ...override,
    ...(Object.keys(usage).length > 0 ? { usage } : {})
  };
}

function compactJsonObject(input: TraceAttributeInput): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

function getSpanId(messageId: string, event: CoreEventPayload): string {
  if ('modelCallId' in event && typeof event.modelCallId === 'string') {
    return event.modelCallId;
  }

  if ('toolCallId' in event && typeof event.toolCallId === 'string') {
    return event.toolCallId;
  }

  if ('textId' in event && typeof event.textId === 'string') {
    return event.textId;
  }

  if ('reasoningId' in event && typeof event.reasoningId === 'string') {
    return event.reasoningId;
  }

  return messageId;
}

function getTraceKind(type: CoreEvent['type']): TraceKind {
  if (type.startsWith('TOOL_')) {
    return 'tool';
  }

  if (
    type === 'MODEL_CALL_START' ||
    type === 'MODEL_CALL_END' ||
    type === 'TEXT_START' ||
    type === 'TEXT_DELTA' ||
    type === 'TEXT_END' ||
    type === 'REASONING_DELTA'
  ) {
    return 'model';
  }

  if (type === 'STATE_DELTA') {
    return 'state';
  }

  return 'run';
}

function createTraceAttributes(event: CoreEventPayload): JsonObject {
  switch (event.type) {
    case 'RUN_FINISHED':
      return {
        finishReason: event.finishReason,
        pendingToolCallIds: event.pendingToolCallIds ?? []
      };
    case 'MODEL_CALL_START':
      return compactJsonObject({
        modelCallId: event.modelCallId,
        provider: event.provider,
        model: event.model
      });
    case 'MODEL_CALL_END':
      return compactJsonObject({
        modelCallId: event.modelCallId,
        status: event.status,
        finishReason: event.finishReason,
        provider: event.provider,
        model: event.model,
        providerRequestId: event.providerRequestId,
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        totalTokens: event.usage?.totalTokens
      });
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_END':
      return {
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        executionPolicy: event.executionPolicy
      };
    case 'TOOL_RESULT':
      return {
        toolId: event.toolId ?? '',
        toolName: event.toolName,
        modelName: event.modelName ?? '',
        toolRuntime: event.toolRuntime ?? '',
        isError: event.isError ?? false
      };
    default:
      return {};
  }
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    if (error.name === 'ToolTimeoutError') {
      return {
        code: 'tool_timeout',
        message: error.message
      };
    }

    return {
      code: 'tool_execution_failed',
      message: error.message
    };
  }

  return {
    code: 'tool_execution_failed',
    message: typeof error === 'string' ? error : 'Tool execution failed'
  };
}

function getToolTimeoutMs(definition: ToolDefinition): number | undefined {
  return definition.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : definition.timeoutMs;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, toolName: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  if ((timeoutMs === undefined || timeoutMs <= 0) && !signal) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const candidates: Promise<T>[] = [promise];

  if (timeoutMs !== undefined && timeoutMs > 0) {
    candidates.push(new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
        error.name = 'ToolTimeoutError';
        reject(error);
      }, timeoutMs);
    }));
  }

  let abortListener: (() => void) | undefined;
  if (signal) {
    candidates.push(new Promise<T>((_, reject) => {
      abortListener = () => reject(createAbortError());
      signal.addEventListener('abort', abortListener, { once: true });
    }));
  }

  return Promise.race(candidates).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }

    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(message = 'Run was cancelled'): Error {
  const reason = new Error(message);
  reason.name = 'AbortError';
  return reason;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function resolveToolDefinition(
  registry: ToolRegistry,
  clientTools: RegisteredClientToolDefinition[] | undefined,
  event: Extract<ModelAdapterEvent, { type: 'tool-call' }>
): RegisteredToolDefinition | undefined {
  if (event.toolId) {
    return getToolDefinition(registry, clientTools, event.toolId);
  }

  if (event.modelName) {
    return getToolDefinitionByModelName(registry, clientTools, event.modelName);
  }

  return getToolDefinitionByModelName(registry, clientTools, event.toolName) ?? getToolDefinitionByName(registry, clientTools, event.toolName);
}

function normalizeClientTools(tools: ClientToolDefinition[] | undefined, registry: ToolRegistry): RegisteredClientToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const byId = new Set<string>();
  const byModelName = new Set<string>();
  const normalizedTools: RegisteredClientToolDefinition[] = [];

  for (const tool of tools) {
    const normalized = normalizeToolDefinition(tool) as RegisteredClientToolDefinition;

    const existingById = registry.get(normalized.toolId);
    const existingByModelName = registry.getByModelName(normalized.modelName);
    if (existingById || existingByModelName) {
      const existing = existingById ?? existingByModelName;
      if (
        existing?.name === normalized.name &&
        existing.executionPolicy === normalized.executionPolicy &&
        existing.modelName === normalized.modelName
      ) {
        continue;
      }

      throw new Error(`Client tool id "${normalized.toolId}" is already registered`);
    }

    if (byId.has(normalized.toolId)) {
      throw new Error(`Client tool id "${normalized.toolId}" is already registered`);
    }

    if (byModelName.has(normalized.modelName)) {
      throw new Error(`Client tool modelName "${normalized.modelName}" is already registered`);
    }

    byId.add(normalized.toolId);
    byModelName.add(normalized.modelName);
    normalizedTools.push(normalized);
  }

  return normalizedTools.length > 0 ? normalizedTools : undefined;
}

function getRunTools(registry: ToolRegistry, clientTools: RegisteredClientToolDefinition[] | undefined): ToolDefinition[] {
  return [
    ...registry.list(),
    ...(clientTools ?? [])
  ];
}

function composeSystemPromptProvider(
  baseProvider: SystemPromptProvider | undefined,
  skillRegistry: AgentSkillRegistry | undefined
): SystemPromptProvider | undefined {
  if (!baseProvider && !skillRegistry) {
    return undefined;
  }

  return async (context: SystemPromptContext) => {
    const basePrompt = typeof baseProvider === 'function' ? await baseProvider(context) : baseProvider;
    const skillPrompt = await skillRegistry?.buildSystemPrompt(context);
    return [basePrompt, skillPrompt].map(part => part?.trim()).filter(Boolean).join('\n\n');
  };
}

async function getPolicyVisibleRunTools(
  registry: ToolRegistry,
  clientTools: RegisteredClientToolDefinition[] | undefined,
  context: Omit<ToolPolicyContext, 'action' | 'tool'> & { toolPolicy?: ToolPolicyProvider }
): Promise<ToolDefinition[]> {
  const tools = getRunTools(registry, clientTools);
  if (!context.toolPolicy) {
    return tools;
  }

  const visibleTools: ToolDefinition[] = [];
  for (const tool of tools) {
    const decision = await evaluateToolPolicy(context.toolPolicy, {
      action: 'tool.expose',
      runId: context.runId,
      threadId: context.threadId,
      tool,
      state: context.state,
      metadata: context.metadata
    });
    if (isVisibleByToolPolicy(decision)) {
      visibleTools.push(tool);
    }
  }

  return visibleTools;
}

async function evaluateToolPolicy(provider: ToolPolicyProvider | undefined, context: ToolPolicyContext): Promise<ToolPolicyDecision> {
  if (!provider) {
    return { type: 'allow' };
  }

  try {
    return await provider(context);
  } catch (error) {
    return {
      type: 'deny',
      code: 'tool_policy_failed',
      reason: error instanceof Error ? error.message : 'Tool policy failed'
    };
  }
}

function isVisibleByToolPolicy(decision: ToolPolicyDecision): boolean {
  return decision.type !== 'deny';
}

function isAllowedByToolPolicy(decision: ToolPolicyDecision): boolean {
  return decision.type === 'allow';
}

function getPolicyDecisionCode(decision: ToolPolicyDecision): string {
  if (decision.type === 'allow') {
    return 'tool_policy_allowed';
  }

  if (decision.type === 'require_confirmation') {
    return decision.code ?? 'tool_policy_confirmation_required';
  }

  return decision.code;
}

function getPolicyDecisionMessage(decision: ToolPolicyDecision): string {
  if (decision.type === 'allow') {
    return 'Tool policy allowed the action';
  }

  return decision.reason;
}

function getToolDefinition(
  registry: ToolRegistry,
  clientTools: RegisteredClientToolDefinition[] | undefined,
  toolId: string
): RegisteredToolDefinition | RegisteredClientToolDefinition | undefined {
  return registry.get(toolId) ?? clientTools?.find(tool => tool.toolId === toolId);
}

function getToolDefinitionByModelName(
  registry: ToolRegistry,
  clientTools: RegisteredClientToolDefinition[] | undefined,
  modelName: string
): RegisteredToolDefinition | RegisteredClientToolDefinition | undefined {
  return registry.getByModelName(modelName) ?? clientTools?.find(tool => tool.modelName === modelName);
}

function getToolDefinitionByName(
  registry: ToolRegistry,
  clientTools: RegisteredClientToolDefinition[] | undefined,
  name: string
): RegisteredToolDefinition | RegisteredClientToolDefinition | undefined {
  const registryMatch = registry.getByName(name);
  if (registryMatch) {
    return registryMatch;
  }

  const clientMatches = (clientTools ?? []).filter(tool => tool.name === name);
  return clientMatches.length === 1 ? clientMatches[0] : undefined;
}

function createAssistantMessageContent(reasoningBuffer: string[], assistantParts: AgentMessage['content']): AgentMessage['content'] {
  const reasoning = reasoningBuffer.join('');
  if (!reasoning) {
    return assistantParts;
  }

  return [
    {
      type: 'reasoning',
      text: reasoning
    },
    ...assistantParts
  ];
}

function normalizeRunError(error: unknown): RunErrorEvent['error'] {
  if (error instanceof Error) {
    return {
      code: 'model_adapter_failed',
      message: error.message
    };
  }

  return {
    code: 'model_adapter_failed',
    message: typeof error === 'string' ? error : 'Model adapter failed'
  };
}
