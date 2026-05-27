import {
  createId,
  nowIso,
  type AgentMessage,
  type CoreEvent,
  type JSONSchema,
  type JsonObject,
  type JsonValue,
  type ToolDefinition
} from '@mido/protocol-core';

import type {
  AgentRunner,
  RunExecutionContext,
  ServerToolRuntimeDefinition,
  ToolExecutionContext
} from './runner.js';

export interface AgentToolInput {
  task: string;
  context?: JsonObject;
  threadId?: string;
}

export type AgentToolError = JsonObject & {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
};

export type AgentToolResult = JsonObject & {
  agentId: string;
  childRunId: string;
  childThreadId?: string;
  status: 'completed' | 'error';
  outputText?: string;
  error?: AgentToolError;
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
};

export interface AgentToolOptions {
  agentId: string;
  name: string;
  description: string;
  runner: AgentRunner;
  inputSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  timeoutMs?: number;
  maxModelCalls?: number;
  metadata?: ToolDefinition['metadata'];
  resolveThreadId?: (input: AgentToolInput, context: ToolExecutionContext) => string | undefined;
  buildMetadata?: (input: AgentToolInput, context: ToolExecutionContext) => JsonObject | undefined;
}

export type AgentWorkflowAgentMode = 'template' | 'ad_hoc';

export type AgentWorkflowAgentSpec = JsonObject & {
  id: string;
  task: string;
  dependsOn?: string[];
  context?: JsonObject;
  templateId?: string;
  mode?: AgentWorkflowAgentMode;
  systemPrompt?: string;
  description?: string;
};

export type AgentWorkflowInput = JsonObject & {
  agents: AgentWorkflowAgentSpec[];
};

export type AgentWorkflowAgentResult = JsonObject & {
  id: string;
  templateId?: string;
  mode: AgentWorkflowAgentMode;
  childRunId?: string;
  childThreadId?: string;
  status: 'completed' | 'error' | 'skipped';
  outputText?: string;
  error?: AgentToolError;
  dependsOn?: string[];
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
};

export type AgentWorkflowResult = JsonObject & {
  workflowRunId: string;
  status: 'completed' | 'partial' | 'error';
  agents: AgentWorkflowAgentResult[];
  executionOrder: string[];
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
  error?: AgentToolError;
};

export interface AgentWorkflowLimits {
  maxAgents?: number;
  maxParallelAgents?: number;
  maxModelCallsPerAgent?: number;
  timeoutMs?: number;
}

export interface AgentWorkflowRunnerRequest {
  workflowRunId: string;
  agent: AgentWorkflowAgentSpec;
  dependencyResults: AgentWorkflowAgentResult[];
}

export interface AgentWorkflowTemplate {
  description: string;
  createRunner(request: AgentWorkflowRunnerRequest, context: ToolExecutionContext): AgentRunner;
}

export interface CreateAgentWorkflowToolOptions {
  name: string;
  description: string;
  templates: Record<string, AgentWorkflowTemplate>;
  allowAdHocAgents?: boolean;
  createAdHocRunner?: (request: AgentWorkflowRunnerRequest, context: ToolExecutionContext) => AgentRunner;
  inputSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  limits?: AgentWorkflowLimits;
  metadata?: ToolDefinition['metadata'];
}

export class AgentToolExecutionError extends Error {
  constructor(readonly result: JsonValue) {
    super(getStructuredToolErrorMessage(result));
    this.name = 'AgentToolExecutionError';
  }
}

const defaultAgentToolInputSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', minLength: 1 },
    context: { type: 'object', additionalProperties: true },
    threadId: { type: 'string' }
  },
  required: ['task']
};

const defaultAgentToolResultSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agentId: { type: 'string' },
    childRunId: { type: 'string' },
    childThreadId: { type: 'string' },
    status: { enum: ['completed', 'error'] },
    outputText: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: true }
      },
      required: ['code', 'message']
    },
    eventCount: { type: 'number' },
    modelCallCount: { type: 'number' },
    toolCallCount: { type: 'number' }
  },
  required: ['agentId', 'childRunId', 'status', 'eventCount', 'modelCallCount', 'toolCallCount']
};

const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 120_000;
const DEFAULT_WORKFLOW_MAX_AGENTS = 5;
const DEFAULT_WORKFLOW_MAX_PARALLEL_AGENTS = 2;
const DEFAULT_WORKFLOW_MAX_MODEL_CALLS_PER_AGENT = 4;

const defaultAgentWorkflowInputSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agents: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          task: { type: 'string', minLength: 1 },
          dependsOn: { type: 'array', items: { type: 'string' } },
          context: { type: 'object', additionalProperties: true },
          templateId: { type: 'string' },
          mode: { enum: ['template', 'ad_hoc'] },
          systemPrompt: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['id', 'task']
      }
    }
  },
  required: ['agents']
};

const defaultAgentWorkflowResultSchema: JSONSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    workflowRunId: { type: 'string' },
    status: { enum: ['completed', 'partial', 'error'] },
    agents: { type: 'array' },
    executionOrder: { type: 'array', items: { type: 'string' } },
    eventCount: { type: 'number' },
    modelCallCount: { type: 'number' },
    toolCallCount: { type: 'number' },
    error: { type: 'object', additionalProperties: true }
  },
  required: ['workflowRunId', 'status', 'agents', 'executionOrder', 'eventCount', 'modelCallCount', 'toolCallCount']
};

type ChildRunIdentity = {
  agentId: string;
  childRunId: string;
  childThreadId?: string;
};

type AgentToolErrorInput = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
};

export function createAgentTool(options: AgentToolOptions): ServerToolRuntimeDefinition {
  return {
    name: options.name,
    description: options.description,
    executionPolicy: 'server',
    inputSchema: options.inputSchema ?? defaultAgentToolInputSchema,
    resultSchema: options.resultSchema ?? defaultAgentToolResultSchema,
    timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS,
    metadata: {
      ...(options.metadata ?? {}),
      mido: {
        ...(isJsonObject(options.metadata?.mido) ? options.metadata.mido : {}),
        kind: 'agent_tool',
        agentId: options.agentId
      }
    },
    async execute(args, context) {
      const input = normalizeAgentToolInput(args);
      const childRunId = createId('run');
      const childThreadId = input.threadId ?? options.resolveThreadId?.(input, context) ?? createId('thread');
      const identity = {
        agentId: options.agentId,
        childRunId,
        childThreadId
      };
      const executionContext: RunExecutionContext = {
        storageScope: context.storageScope
      };
      const metadata = compactJsonObject({
        ...(options.buildMetadata?.(input, context) ?? {}),
        traceId: context.traceId ?? context.runId,
        parentRunId: context.runId,
        parentThreadId: context.threadId,
        parentToolCallId: context.toolCall?.toolCallId,
        agentId: options.agentId
      });

      const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS;
      const childRun = collectChildRun(
        options.runner.run({
          runId: childRunId,
          threadId: childThreadId,
          messages: [createAgentToolUserMessage(input)],
          state: input.context ?? {},
          metadata
        }, executionContext),
        {
          ...identity,
          maxModelCalls: options.maxModelCalls
        }
      );
      const cancelChildRun = async (reason: string) => {
        await options.runner.cancelRun({ runId: childRunId, reason }, executionContext);
      };
      const abortListener = () => {
        void cancelChildRun('parent_run_cancelled');
      };
      context.signal?.addEventListener('abort', abortListener, { once: true });

      try {
        const result = await runWithTimeout(childRun, timeoutMs, async () => {
          await cancelChildRun('subagent_timeout');
        });
        if (result.status === 'error') {
          throw new AgentToolExecutionError(result);
        }

        return result;
      } catch (error) {
        if (error instanceof AgentToolExecutionError) {
          throw error;
        }

        throw new AgentToolExecutionError(createAgentToolErrorResult(identity, {
          code: 'subagent_execution_failed',
          message: error instanceof Error ? error.message : 'Sub-agent execution failed'
        }));
      } finally {
        context.signal?.removeEventListener('abort', abortListener);
      }
    }
  };
}

export function createAgentWorkflowTool(options: CreateAgentWorkflowToolOptions): ServerToolRuntimeDefinition {
  const limits = normalizeWorkflowLimits(options.limits);

  return {
    name: options.name,
    description: options.description,
    executionPolicy: 'server',
    inputSchema: options.inputSchema ?? defaultAgentWorkflowInputSchema,
    resultSchema: options.resultSchema ?? defaultAgentWorkflowResultSchema,
    timeoutMs: limits.timeoutMs,
    metadata: {
      ...(options.metadata ?? {}),
      mido: {
        ...(isJsonObject(options.metadata?.mido) ? options.metadata.mido : {}),
        kind: 'agent_workflow_tool'
      }
    },
    async execute(args, context) {
      const workflowRunId = createId('workflow');
      const activeChildRuns = new Map<string, { runner: AgentRunner; runId: string; executionContext: RunExecutionContext }>();
      const abortListener = () => {
        for (const child of activeChildRuns.values()) {
          void child.runner.cancelRun({ runId: child.runId, reason: 'parent_run_cancelled' }, child.executionContext);
        }
      };
      context.signal?.addEventListener('abort', abortListener, { once: true });

      try {
        const result = await runWithTimeout(
          executeWorkflow(
            normalizeWorkflowInput(args, workflowRunId),
            {
              ...options,
              limits
            },
            workflowRunId,
            context,
            activeChildRuns
          ),
          limits.timeoutMs,
          async () => {
            await cancelActiveWorkflowChildren(activeChildRuns, 'workflow_timeout');
          }
        );
        if (result.status === 'error') {
          throw new AgentToolExecutionError(result);
        }

        return result;
      } catch (error) {
        if (error instanceof AgentToolExecutionError) {
          throw error;
        }

        throw new AgentToolExecutionError(createWorkflowErrorResult(workflowRunId, {
          code: error instanceof Error && error.message.includes('timed out') ? 'workflow_timeout' : 'workflow_execution_failed',
          message: error instanceof Error ? error.message : 'Agent workflow execution failed'
        }));
      } finally {
        context.signal?.removeEventListener('abort', abortListener);
      }
    }
  };
}

async function cancelActiveWorkflowChildren(
  activeChildRuns: Map<string, { runner: AgentRunner; runId: string; executionContext: RunExecutionContext }>,
  reason: string
): Promise<void> {
  await Promise.all([...activeChildRuns.values()].map(child =>
    child.runner.cancelRun({ runId: child.runId, reason }, child.executionContext)
  ));
}

async function executeWorkflow(
  input: AgentWorkflowInput,
  options: CreateAgentWorkflowToolOptions & { limits: Required<AgentWorkflowLimits> },
  workflowRunId: string,
  context: ToolExecutionContext,
  activeChildRuns: Map<string, { runner: AgentRunner; runId: string; executionContext: RunExecutionContext }>
): Promise<AgentWorkflowResult> {
  const validationError = validateWorkflowInput(input, options);
  if (validationError) {
    throw new AgentToolExecutionError(createWorkflowErrorResult(workflowRunId, validationError));
  }

  const pending = new Map(input.agents.map(agent => [agent.id, agent]));
  const results = new Map<string, AgentWorkflowAgentResult>();
  const running = new Map<string, Promise<AgentWorkflowAgentResult>>();
  const executionOrder: string[] = [];

  while (results.size < input.agents.length) {
    for (const [agentId, agent] of [...pending.entries()]) {
      const dependencyResults = getDependencyResults(agent, results);
      if (dependencyResults.some(result => result.status !== 'completed')) {
        const skipped = createWorkflowAgentSkippedResult(agent, {
          code: 'workflow_dependency_failed',
          message: `Agent "${agent.id}" was skipped because one or more dependencies failed`
        });
        pending.delete(agentId);
        results.set(agentId, skipped);
        executionOrder.push(agentId);
      }
    }

    const ready = [...pending.values()].filter(agent => getDependencyResults(agent, results).length === (agent.dependsOn?.length ?? 0));
    while (running.size < options.limits.maxParallelAgents && ready.length > 0) {
      const agent = ready.shift();
      if (!agent || !pending.has(agent.id)) {
        continue;
      }

      pending.delete(agent.id);
      running.set(agent.id, runWorkflowAgent(agent, {
        options,
        workflowRunId,
        context,
        dependencyResults: getDependencyResults(agent, results),
        activeChildRuns
      }));
    }

    if (running.size === 0) {
      break;
    }

    const settled = await Promise.race(
      [...running.entries()].map(async ([agentId, promise]) => ({
        agentId,
        result: await promise
      }))
    );
    running.delete(settled.agentId);
    results.set(settled.agentId, settled.result);
    executionOrder.push(settled.agentId);
  }

  const agents = input.agents.map(agent => results.get(agent.id) ?? createWorkflowAgentSkippedResult(agent, {
    code: 'workflow_agent_not_scheduled',
    message: `Agent "${agent.id}" was not scheduled`
  }));
  return buildWorkflowResult(workflowRunId, agents, executionOrder);
}

async function runWorkflowAgent(
  agent: AgentWorkflowAgentSpec,
  input: {
    options: CreateAgentWorkflowToolOptions & { limits: Required<AgentWorkflowLimits> };
    workflowRunId: string;
    context: ToolExecutionContext;
    dependencyResults: AgentWorkflowAgentResult[];
    activeChildRuns: Map<string, { runner: AgentRunner; runId: string; executionContext: RunExecutionContext }>;
  }
): Promise<AgentWorkflowAgentResult> {
  const resolved = resolveWorkflowRunner(agent, input);
  if ('error' in resolved) {
    return createWorkflowAgentErrorResult(agent, resolved.mode, resolved.error);
  }

  const childRunId = createId('run');
  const childThreadId = createId('thread');
  const executionContext: RunExecutionContext = {
    storageScope: input.context.storageScope
  };
  input.activeChildRuns.set(agent.id, {
    runner: resolved.runner,
    runId: childRunId,
    executionContext
  });

  try {
    const childResult = await collectChildRun(
      resolved.runner.run({
        runId: childRunId,
        threadId: childThreadId,
        messages: [createWorkflowAgentUserMessage(agent, input.dependencyResults)],
        state: agent.context ?? {},
        metadata: compactJsonObject({
          traceId: input.context.traceId ?? input.context.runId,
          parentRunId: input.context.runId,
          parentThreadId: input.context.threadId,
          parentToolCallId: input.context.toolCall?.toolCallId,
          workflowRunId: input.workflowRunId,
          workflowAgentId: agent.id,
          templateId: agent.templateId,
          mode: resolved.mode
        })
      }, executionContext),
      {
        agentId: agent.id,
        childRunId,
        childThreadId,
        maxModelCalls: input.options.limits.maxModelCallsPerAgent
      }
    );

    return compactWorkflowAgentResult({
      id: agent.id,
      ...(agent.templateId ? { templateId: agent.templateId } : {}),
      mode: resolved.mode,
      childRunId,
      childThreadId,
      status: childResult.status,
      ...(childResult.outputText ? { outputText: childResult.outputText } : {}),
      ...(childResult.error ? { error: childResult.error } : {}),
      ...(agent.dependsOn ? { dependsOn: agent.dependsOn } : {}),
      eventCount: childResult.eventCount,
      modelCallCount: childResult.modelCallCount,
      toolCallCount: childResult.toolCallCount
    });
  } finally {
    input.activeChildRuns.delete(agent.id);
  }
}

function resolveWorkflowRunner(
  agent: AgentWorkflowAgentSpec,
  input: {
    options: CreateAgentWorkflowToolOptions & { limits: Required<AgentWorkflowLimits> };
    workflowRunId: string;
    context: ToolExecutionContext;
    dependencyResults: AgentWorkflowAgentResult[];
  }
):
  | { runner: AgentRunner; mode: AgentWorkflowAgentMode }
  | { error: AgentToolErrorInput; mode: AgentWorkflowAgentMode } {
  if (agent.mode === 'ad_hoc' || !agent.templateId) {
    return resolveAdHocWorkflowRunner(agent, input);
  }

  const template = input.options.templates[agent.templateId];
  if (template) {
    return {
      mode: 'template',
      runner: template.createRunner({
        workflowRunId: input.workflowRunId,
        agent,
        dependencyResults: input.dependencyResults
      }, input.context)
    };
  }

  if (input.options.allowAdHocAgents) {
    return resolveAdHocWorkflowRunner(agent, input);
  }

  return {
    mode: 'template',
    error: {
      code: 'workflow_template_not_found',
      message: `Agent template "${agent.templateId}" is not registered`
    }
  };
}

function resolveAdHocWorkflowRunner(
  agent: AgentWorkflowAgentSpec,
  input: {
    options: CreateAgentWorkflowToolOptions & { limits: Required<AgentWorkflowLimits> };
    workflowRunId: string;
    context: ToolExecutionContext;
    dependencyResults: AgentWorkflowAgentResult[];
  }
): { runner: AgentRunner; mode: 'ad_hoc' } | { error: AgentToolErrorInput; mode: 'ad_hoc' } {
  if (!input.options.allowAdHocAgents) {
    return {
      mode: 'ad_hoc',
      error: {
        code: 'workflow_ad_hoc_not_allowed',
        message: `Ad-hoc agent "${agent.id}" is not allowed`
      }
    };
  }

  if (!input.options.createAdHocRunner) {
    return {
      mode: 'ad_hoc',
      error: {
        code: 'workflow_ad_hoc_factory_missing',
        message: `Ad-hoc agent "${agent.id}" requires createAdHocRunner`
      }
    };
  }

  return {
    mode: 'ad_hoc',
    runner: input.options.createAdHocRunner({
      workflowRunId: input.workflowRunId,
      agent,
      dependencyResults: input.dependencyResults
    }, input.context)
  };
}

async function collectChildRun(
  stream: AsyncIterable<CoreEvent>,
  options: ChildRunIdentity & {
    maxModelCalls?: number;
  }
): Promise<AgentToolResult> {
  const textParts: string[] = [];
  let finalError: AgentToolError | undefined;
  let completed = false;
  let awaitingClientTool = false;
  let eventCount = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;

  for await (const event of stream) {
    eventCount += 1;

    if (event.type === 'MODEL_CALL_START') {
      modelCallCount += 1;
      if (options.maxModelCalls !== undefined && modelCallCount > options.maxModelCalls) {
        return createAgentToolErrorResult(options, {
          code: 'subagent_model_call_limit_exceeded',
          message: `Sub-agent "${options.agentId}" exceeded maxModelCalls=${options.maxModelCalls}`
        }, eventCount, modelCallCount, toolCallCount);
      }
    }

    if (event.type === 'TOOL_CALL_END') {
      toolCallCount += 1;
    }

    if (event.type === 'TEXT_END' && event.text) {
      textParts.push(event.text);
    }

    if (event.type === 'RUN_ERROR') {
      finalError = compactAgentToolError({
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
        details: event.error.details
      });
    }

    if (event.type === 'RUN_FINISHED') {
      completed = event.finishReason === 'completed';
      awaitingClientTool = event.finishReason === 'awaiting_client_tool';
    }
  }

  if (awaitingClientTool) {
    return createAgentToolErrorResult(options, {
      code: 'subagent_client_tool_unsupported',
      message: `Sub-agent "${options.agentId}" requested a client tool, which is not supported by createAgentTool V1`
    }, eventCount, modelCallCount, toolCallCount);
  }

  if (!completed || finalError) {
    return createAgentToolErrorResult(options, finalError ?? {
      code: 'subagent_incomplete',
      message: `Sub-agent "${options.agentId}" did not complete`
    }, eventCount, modelCallCount, toolCallCount);
  }

  return compactAgentToolResult({
    ...options,
    status: 'completed',
    outputText: textParts.join('\n').trim(),
    eventCount,
    modelCallCount,
    toolCallCount
  });
}

function createAgentToolErrorResult(
  identity: ChildRunIdentity,
  error: AgentToolErrorInput,
  eventCount = 0,
  modelCallCount = 0,
  toolCallCount = 0
): AgentToolResult {
  return compactAgentToolResult({
    ...identity,
    status: 'error',
    error: compactAgentToolError(error),
    eventCount,
    modelCallCount,
    toolCallCount
  });
}

function createWorkflowErrorResult(workflowRunId: string, error: AgentToolErrorInput): AgentWorkflowResult {
  return {
    workflowRunId,
    status: 'error',
    agents: [],
    executionOrder: [],
    eventCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    error: compactAgentToolError(error)
  };
}

function createWorkflowAgentErrorResult(
  agent: AgentWorkflowAgentSpec,
  mode: AgentWorkflowAgentMode,
  error: AgentToolErrorInput
): AgentWorkflowAgentResult {
  return compactWorkflowAgentResult({
    id: agent.id,
    ...(agent.templateId ? { templateId: agent.templateId } : {}),
    mode,
    status: 'error',
    error: compactAgentToolError(error),
    ...(agent.dependsOn ? { dependsOn: agent.dependsOn } : {}),
    eventCount: 0,
    modelCallCount: 0,
    toolCallCount: 0
  });
}

function createWorkflowAgentSkippedResult(agent: AgentWorkflowAgentSpec, error: AgentToolErrorInput): AgentWorkflowAgentResult {
  return compactWorkflowAgentResult({
    id: agent.id,
    ...(agent.templateId ? { templateId: agent.templateId } : {}),
    mode: agent.mode === 'ad_hoc' || !agent.templateId ? 'ad_hoc' : 'template',
    status: 'skipped',
    error: compactAgentToolError(error),
    ...(agent.dependsOn ? { dependsOn: agent.dependsOn } : {}),
    eventCount: 0,
    modelCallCount: 0,
    toolCallCount: 0
  });
}

function buildWorkflowResult(
  workflowRunId: string,
  agents: AgentWorkflowAgentResult[],
  executionOrder: string[]
): AgentWorkflowResult {
  const completedCount = agents.filter(agent => agent.status === 'completed').length;
  const status = completedCount === agents.length
    ? 'completed'
    : completedCount > 0
      ? 'partial'
      : 'error';

  return {
    workflowRunId,
    status,
    agents,
    executionOrder,
    eventCount: agents.reduce((sum, agent) => sum + agent.eventCount, 0),
    modelCallCount: agents.reduce((sum, agent) => sum + agent.modelCallCount, 0),
    toolCallCount: agents.reduce((sum, agent) => sum + agent.toolCallCount, 0),
    ...(status === 'error' ? {
      error: compactAgentToolError({
        code: 'workflow_agent_failed',
        message: 'No workflow agents completed successfully'
      })
    } : {})
  };
}

function compactAgentToolResult(result: AgentToolResult): AgentToolResult {
  return {
    agentId: result.agentId,
    childRunId: result.childRunId,
    ...(result.childThreadId ? { childThreadId: result.childThreadId } : {}),
    status: result.status,
    ...(result.outputText ? { outputText: result.outputText } : {}),
    ...(result.error ? { error: result.error } : {}),
    eventCount: result.eventCount,
    modelCallCount: result.modelCallCount,
    toolCallCount: result.toolCallCount
  };
}

function compactWorkflowAgentResult(result: AgentWorkflowAgentResult): AgentWorkflowAgentResult {
  return {
    id: result.id,
    ...(result.templateId ? { templateId: result.templateId } : {}),
    mode: result.mode,
    ...(result.childRunId ? { childRunId: result.childRunId } : {}),
    ...(result.childThreadId ? { childThreadId: result.childThreadId } : {}),
    status: result.status,
    ...(result.outputText ? { outputText: result.outputText } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.dependsOn ? { dependsOn: result.dependsOn } : {}),
    eventCount: result.eventCount,
    modelCallCount: result.modelCallCount,
    toolCallCount: result.toolCallCount
  };
}

function compactAgentToolError(error: AgentToolErrorInput): AgentToolError {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.details ? { details: error.details } : {})
  };
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, onTimeout: () => Promise<void>): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => {
        reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function normalizeAgentToolInput(args: JsonObject): AgentToolInput {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) {
    throw new Error('Agent tool input requires a non-empty task');
  }

  return {
    task,
    ...(isJsonObject(args.context) ? { context: args.context } : {}),
    ...(typeof args.threadId === 'string' && args.threadId.trim() ? { threadId: args.threadId.trim() } : {})
  };
}

function normalizeWorkflowInput(args: JsonObject, workflowRunId: string): AgentWorkflowInput {
  if (!Array.isArray(args.agents)) {
    throw new AgentToolExecutionError(createWorkflowErrorResult(workflowRunId, {
      code: 'workflow_invalid_input',
      message: 'Agent workflow input requires an agents array'
    }));
  }

  return {
    agents: args.agents
      .filter(isJsonObject)
      .map(agent => ({
        id: typeof agent.id === 'string' ? agent.id.trim() : '',
        task: typeof agent.task === 'string' ? agent.task.trim() : '',
        ...(readStringArray(agent.dependsOn) ? { dependsOn: readStringArray(agent.dependsOn) } : {}),
        ...(isJsonObject(agent.context) ? { context: agent.context } : {}),
        ...(typeof agent.templateId === 'string' && agent.templateId.trim() ? { templateId: agent.templateId.trim() } : {}),
        ...(agent.mode === 'template' || agent.mode === 'ad_hoc' ? { mode: agent.mode } : {}),
        ...(typeof agent.systemPrompt === 'string' && agent.systemPrompt.trim() ? { systemPrompt: agent.systemPrompt.trim() } : {}),
        ...(typeof agent.description === 'string' && agent.description.trim() ? { description: agent.description.trim() } : {})
      }))
  };
}

function validateWorkflowInput(
  input: AgentWorkflowInput,
  options: CreateAgentWorkflowToolOptions & { limits: Required<AgentWorkflowLimits> }
): AgentToolErrorInput | undefined {
  if (input.agents.length === 0 || input.agents.some(agent => !agent.id || !agent.task)) {
    return {
      code: 'workflow_invalid_input',
      message: 'Agent workflow requires at least one agent with id and task'
    };
  }

  if (input.agents.length > options.limits.maxAgents) {
    return {
      code: 'workflow_agent_limit_exceeded',
      message: `Agent workflow exceeds maxAgents=${options.limits.maxAgents}`
    };
  }

  const ids = new Set<string>();
  for (const agent of input.agents) {
    if (ids.has(agent.id)) {
      return {
        code: 'workflow_duplicate_agent_id',
        message: `Agent workflow contains duplicate agent id "${agent.id}"`
      };
    }
    ids.add(agent.id);
  }

  for (const agent of input.agents) {
    for (const dependency of agent.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        return {
          code: 'workflow_unknown_dependency',
          message: `Agent "${agent.id}" depends on unknown agent "${dependency}"`
        };
      }
    }
  }

  if (hasWorkflowCycle(input.agents)) {
    return {
      code: 'workflow_cycle_detected',
      message: 'Agent workflow dependency graph contains a cycle'
    };
  }

  for (const agent of input.agents) {
    if ((agent.mode === 'ad_hoc' || !agent.templateId) && !options.allowAdHocAgents) {
      return {
        code: 'workflow_ad_hoc_not_allowed',
        message: `Ad-hoc agent "${agent.id}" is not allowed`
      };
    }

    if ((agent.mode === 'ad_hoc' || !agent.templateId) && !options.createAdHocRunner) {
      return {
        code: 'workflow_ad_hoc_factory_missing',
        message: `Ad-hoc agent "${agent.id}" requires createAdHocRunner`
      };
    }
  }

  return undefined;
}

function normalizeWorkflowLimits(limits: AgentWorkflowLimits | undefined): Required<AgentWorkflowLimits> {
  return {
    maxAgents: Math.max(1, limits?.maxAgents ?? DEFAULT_WORKFLOW_MAX_AGENTS),
    maxParallelAgents: Math.max(1, limits?.maxParallelAgents ?? DEFAULT_WORKFLOW_MAX_PARALLEL_AGENTS),
    maxModelCallsPerAgent: Math.max(1, limits?.maxModelCallsPerAgent ?? DEFAULT_WORKFLOW_MAX_MODEL_CALLS_PER_AGENT),
    timeoutMs: Math.max(1, limits?.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS)
  };
}

function hasWorkflowCycle(agents: AgentWorkflowAgentSpec[]): boolean {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (agentId: string): boolean => {
    if (visiting.has(agentId)) {
      return true;
    }

    if (visited.has(agentId)) {
      return false;
    }

    visiting.add(agentId);
    for (const dependency of byId.get(agentId)?.dependsOn ?? []) {
      if (visit(dependency)) {
        return true;
      }
    }
    visiting.delete(agentId);
    visited.add(agentId);
    return false;
  };

  return agents.some(agent => visit(agent.id));
}

function getDependencyResults(
  agent: AgentWorkflowAgentSpec,
  results: Map<string, AgentWorkflowAgentResult>
): AgentWorkflowAgentResult[] {
  return (agent.dependsOn ?? [])
    .map(dependency => results.get(dependency))
    .filter((result): result is AgentWorkflowAgentResult => Boolean(result));
}

function createWorkflowAgentUserMessage(agent: AgentWorkflowAgentSpec, dependencyResults: AgentWorkflowAgentResult[]): AgentMessage {
  const dependencyText = dependencyResults.length > 0
    ? `\n\nDependency results:\n${dependencyResults.map(result => `- ${result.id}: ${result.outputText ?? result.error?.message ?? result.status}`).join('\n')}`
    : '';
  const contextText = agent.context ? `\n\nContext:\n${JSON.stringify(agent.context)}` : '';
  return {
    id: createId('msg'),
    role: 'user',
    createdAt: nowIso(),
    content: [
      {
        type: 'text',
        text: `Task:\n${agent.task}${dependencyText}${contextText}`
      }
    ]
  };
}

function createAgentToolUserMessage(input: AgentToolInput): AgentMessage {
  const contextText = input.context ? `\n\nContext:\n${JSON.stringify(input.context)}` : '';
  return {
    id: createId('msg'),
    role: 'user',
    createdAt: nowIso(),
    content: [
      {
        type: 'text',
        text: `Task:\n${input.task}${contextText}`
      }
    ]
  };
}

function compactJsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function readStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    return undefined;
  }

  return value;
}

function getStructuredToolErrorMessage(result: JsonValue): string {
  if (isJsonObject(result) && isJsonObject(result.error) && typeof result.error.message === 'string') {
    return result.error.message;
  }

  return 'Agent tool execution failed';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
