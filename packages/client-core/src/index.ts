import {
  createId,
  nowIso,
  normalizeToolDefinition,
  stableStringify,
  type AgentMessage,
  type ClientToolDefinition,
  type CoreEvent,
  type JsonObject,
  type JsonValue,
  type RunCancelRequest,
  type RunErrorEvent,
  type RunResumeRequest,
  type RunStartRequest,
  type ToolCallEnvelope,
  type ToolDefinition,
  type ToolResultEnvelope,
  validateSchema
} from '@mido/protocol-core';

export interface AgentTransport {
  startRun(request: RunStartRequest, options?: AgentTransportRequestOptions): Promise<AsyncIterable<CoreEvent>> | AsyncIterable<CoreEvent>;
  resume(request: RunResumeRequest, options?: AgentTransportRequestOptions): Promise<AsyncIterable<CoreEvent>> | AsyncIterable<CoreEvent>;
  cancelRun?(request: RunCancelRequest): Promise<CoreEvent | undefined> | CoreEvent | undefined;
}

export interface AgentTransportRequestOptions {
  signal?: AbortSignal;
}

export interface ClientToolExecutionContext {
  runId: string;
  sharedState: JsonObject;
  toolCall: ToolCallSnapshot;
  signal?: AbortSignal;
}

export type RegisteredClientTool = ToolDefinition & {
  execute?: (args: JsonObject, context: ClientToolExecutionContext) => Promise<JsonValue> | JsonValue;
};

export type NormalizedRegisteredClientTool = RegisteredClientTool & Required<Pick<ToolDefinition, 'toolId' | 'modelName'>>;

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface ToolCallSnapshot extends ToolCallEnvelope {
  status: 'pending' | 'submitted' | 'resolved';
  output?: JsonValue;
  isError?: boolean;
}

export interface AgentClientSnapshot {
  threadId?: string;
  runId?: string;
  status: 'idle' | 'running' | 'awaiting_client_tool' | 'finished' | 'cancelled' | 'error';
  events: CoreEvent[];
  conversationMessages: AgentMessage[];
  sharedState: JsonObject;
  textTranscript: string;
  toolCalls: ToolCallSnapshot[];
  pendingInteractiveTools: ToolCallSnapshot[];
  error?: RunErrorEvent['error'];
}

export type AgentClientListener = (snapshot: AgentClientSnapshot) => void;

export interface ClientSystemPromptContext {
  runId?: string;
  threadId?: string;
  messages: AgentMessage[];
  state?: JsonObject;
  metadata?: JsonObject;
}

export type ClientSystemPromptProvider =
  | string
  | ((context: ClientSystemPromptContext) => Promise<string | undefined> | string | undefined);

export interface ClientSkillRef {
  id: string;
  digest: string;
  source?: string;
  version?: string;
}

export type ClientSkillStatus = 'ready' | 'blocked' | 'needs_review';
export type ClientSkillRisk = 'low' | 'medium' | 'high';

export interface ClientSkillSummary extends ClientSkillRef {
  name: string;
  description: string;
  enabled: boolean;
  hasScripts?: boolean;
  status: ClientSkillStatus;
  risk: ClientSkillRisk;
  metadata?: JsonObject;
}

export type ClientSkillInstallInput = Omit<ClientSkillSummary, 'enabled' | 'status' | 'risk'> &
  Partial<Pick<ClientSkillSummary, 'enabled' | 'status' | 'risk'>>;

export interface ClientSkillStore {
  listSkills(): Promise<ClientSkillSummary[]> | ClientSkillSummary[];
  saveSkill(skill: ClientSkillSummary): Promise<ClientSkillSummary> | ClientSkillSummary;
  deleteSkill(skillId: string): Promise<void> | void;
}

export interface CreateAgentSkillManagerOptions {
  store: ClientSkillStore;
}

export interface AgentSkillManager {
  listSkills(): Promise<ClientSkillSummary[]>;
  installSkill(input: ClientSkillInstallInput): Promise<ClientSkillSummary>;
  uninstallSkill(skillId: string): Promise<void>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<void>;
  getEnabledSkillRefs(): Promise<ClientSkillRef[]>;
}

export interface AgentClient {
  registerClientTool(definition: RegisteredClientTool): NormalizedRegisteredClientTool;
  unregisterClientTool(toolId: string): boolean;
  setSystemPrompt(provider?: ClientSystemPromptProvider): void;
  startRun(request: RunStartRequest): Promise<void>;
  sendMessage(text: string, options?: SendMessageOptions): Promise<void>;
  approveToolCall(toolCallId: string): Promise<void>;
  rejectToolCall(toolCallId: string, reason?: string): Promise<void>;
  submitToolResult(toolCallId: string, output: JsonValue): Promise<void>;
  cancelRun(reason?: string): Promise<void>;
  retryLastRun(options?: RetryRunOptions): Promise<void>;
  clearConversation(options?: ClearConversationOptions): void;
  subscribe(listener: AgentClientListener): () => void;
  getSnapshot(): AgentClientSnapshot;
}

export interface SendMessageOptions {
  runId?: string;
  threadId?: string;
  systemPrompt?: ClientSystemPromptProvider;
  state?: JsonObject;
  metadata?: JsonObject;
}

export interface ClearConversationOptions {
  threadId?: string;
}

export interface RetryRunOptions {
  runId?: string;
}

export interface CreateAgentClientOptions {
  transport: AgentTransport;
  threadId?: string;
  systemPrompt?: ClientSystemPromptProvider;
  skillManager?: AgentSkillManager;
}

export function createAgentClient(options: CreateAgentClientOptions): AgentClient {
  return new AgentClientRuntime(options.transport, options.threadId, options.systemPrompt, options.skillManager);
}

export function createAgentSkillManager(options: CreateAgentSkillManagerOptions): AgentSkillManager {
  return new AgentSkillManagerRuntime(options.store);
}

class AgentClientRuntime implements AgentClient {
  private readonly listeners = new Set<AgentClientListener>();
  private readonly tools = new Map<string, NormalizedRegisteredClientTool>();
  private readonly toolCalls = new Map<string, ToolCallSnapshot>();
  private readonly autoExecutions = new Set<string>();
  private readonly streamedTextIds = new Set<string>();
  private readonly transport: AgentTransport;
  private readonly skillManager?: AgentSkillManager;
  private systemPrompt?: ClientSystemPromptProvider;
  private pendingConversationCommit = false;
  private pendingAssistantMessageId?: string;
  private queue: Promise<void> = Promise.resolve();
  private activeRunController?: AbortController;
  private lastRunRequest?: RunStartRequest;
  private lastRunSourceMetadata?: JsonObject;
  private lastRunShouldCommitConversation = false;
  private snapshot: AgentClientSnapshot = {
    threadId: createId('thread'),
    status: 'idle',
    events: [],
    conversationMessages: [],
    sharedState: {},
    textTranscript: '',
    toolCalls: [],
    pendingInteractiveTools: []
  };

  constructor(
    transport: AgentTransport,
    threadId?: string,
    systemPrompt?: ClientSystemPromptProvider,
    skillManager?: AgentSkillManager
  ) {
    this.transport = transport;
    this.systemPrompt = systemPrompt;
    this.skillManager = skillManager;
    if (threadId) {
      this.snapshot.threadId = threadId;
    }
  }

  registerClientTool(definition: RegisteredClientTool): NormalizedRegisteredClientTool {
    if (definition.executionPolicy === 'server') {
      throw new Error(`Client runtime cannot register server tool "${definition.name}"`);
    }

    if (definition.executionPolicy === 'client_auto' && typeof definition.execute !== 'function') {
      throw new Error(`Auto client tool "${definition.name}" must define an execute handler`);
    }

    const registered = normalizeToolDefinition(definition) as NormalizedRegisteredClientTool;
    this.tools.set(registered.toolId, registered);
    return registered;
  }

  unregisterClientTool(toolId: string): boolean {
    return this.tools.delete(toolId);
  }

  setSystemPrompt(provider?: ClientSystemPromptProvider): void {
    this.systemPrompt = provider;
  }

  async startRun(request: RunStartRequest): Promise<void> {
    return this.enqueue(async () => {
      const runId = request.runId ?? createId('run');
      const messages = await withClientSystemPrompts(request.messages, [this.systemPrompt], {
        runId,
        threadId: request.threadId ?? this.snapshot.threadId,
        messages: request.messages,
        state: request.state,
        metadata: request.metadata
      });
      const runRequest: RunStartRequest = {
        ...request,
        runId,
        messages,
        metadata: await this.withEnabledSkillMetadata(request.metadata)
      };
      this.lastRunRequest = runRequest;
      this.lastRunSourceMetadata = request.metadata;
      this.lastRunShouldCommitConversation = false;
      this.resetForRun(runId);
      this.patchSnapshot({
        runId,
        status: 'running'
      });
      await this.consumeRunStream(runRequest, 'start');
    });
  }

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return;
      }

      if (this.snapshot.status === 'running' || this.snapshot.status === 'awaiting_client_tool') {
        throw new Error('Cannot send a new message while a run is active');
      }

      const threadId = options.threadId ?? this.snapshot.threadId ?? createId('thread');
      const userMessage = createTextMessage('user', trimmedText);
      const messages = [...this.snapshot.conversationMessages, userMessage];
      const runId = options.runId ?? createId('run');
      const requestMessages = await withClientSystemPrompts(messages, [this.systemPrompt, options.systemPrompt], {
        runId,
        threadId,
        messages,
        state: options.state,
        metadata: options.metadata
      });
      const runRequest: RunStartRequest = {
        runId,
        threadId,
        messages: requestMessages,
        state: options.state,
        metadata: await this.withEnabledSkillMetadata(options.metadata)
      };
      this.lastRunRequest = runRequest;
      this.lastRunSourceMetadata = options.metadata;
      this.lastRunShouldCommitConversation = true;
      this.pendingConversationCommit = true;
      this.resetForRun(runId, {
        threadId,
        conversationMessages: messages,
        sharedState: options.state ?? this.snapshot.sharedState
      });
      this.patchSnapshot({
        threadId,
        runId,
        status: 'running'
      });

      await this.consumeRunStream(runRequest, 'start');
      this.commitPendingConversation();
    });
  }

  async submitToolResult(toolCallId: string, output: JsonValue): Promise<void> {
    return this.enqueue(async () => {
      await this.resumeWithToolResult(toolCallId, output);
      this.commitPendingConversation();
    });
  }

  async approveToolCall(toolCallId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.executeInteractiveTool(toolCallId);
      this.commitPendingConversation();
    });
  }

  async rejectToolCall(toolCallId: string, reason = 'User rejected client tool execution'): Promise<void> {
    return this.enqueue(async () => {
      this.getPendingInteractiveToolCall(toolCallId);
      await this.resumeWithToolResult(
        toolCallId,
        {
          code: 'client_tool_rejected',
          message: reason
        },
        {
          isError: true
        }
      );
      this.commitPendingConversation();
    });
  }

  async cancelRun(reason = 'User cancelled the run'): Promise<void> {
    const runId = this.snapshot.runId;
    if (!runId || (this.snapshot.status !== 'running' && this.snapshot.status !== 'awaiting_client_tool')) {
      return;
    }

    if (this.transport.cancelRun) {
      if (this.snapshot.status === 'awaiting_client_tool') {
        this.activeRunController?.abort(createAbortError(reason));
      }
      const event = await this.transport.cancelRun({
        runId,
        reason
      });
      if (event) {
        this.applyEvent(event);
      }
      return;
    }

    this.activeRunController?.abort(createAbortError(reason));
    this.applyLocalCancelledEvent(runId);
  }

  async retryLastRun(options: RetryRunOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.snapshot.status === 'running' || this.snapshot.status === 'awaiting_client_tool') {
        throw new Error('Cannot retry while a run is active');
      }

      if (!this.lastRunRequest) {
        throw new Error('No run is available to retry');
      }

      const runRequest: RunStartRequest = {
        ...this.lastRunRequest,
        runId: options.runId ?? createId('run'),
        metadata: await this.withEnabledSkillMetadata(this.lastRunSourceMetadata)
      };
      this.lastRunRequest = runRequest;
      this.pendingConversationCommit = this.lastRunShouldCommitConversation;
      this.resetForRun(runRequest.runId, {
        threadId: runRequest.threadId ?? this.snapshot.threadId,
        conversationMessages: this.snapshot.conversationMessages,
        sharedState: runRequest.state ?? this.snapshot.sharedState
      });
      this.patchSnapshot({
        runId: runRequest.runId,
        threadId: runRequest.threadId ?? this.snapshot.threadId,
        status: 'running'
      });
      await this.consumeRunStream(runRequest, 'start');
      this.commitPendingConversation();
    });
  }

  clearConversation(options: ClearConversationOptions = {}): void {
    if (this.snapshot.status === 'running' || this.snapshot.status === 'awaiting_client_tool') {
      throw new Error('Cannot clear the conversation while a run is active');
    }

    this.pendingConversationCommit = false;
    this.pendingAssistantMessageId = undefined;
    this.toolCalls.clear();
    this.autoExecutions.clear();
    this.streamedTextIds.clear();
    this.snapshot = {
      threadId: options.threadId ?? createId('thread'),
      status: 'idle',
      events: [],
      conversationMessages: [],
      sharedState: {},
      textTranscript: '',
      toolCalls: [],
      pendingInteractiveTools: []
    };
    this.notify();
  }

  subscribe(listener: AgentClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AgentClientSnapshot {
    return this.snapshot;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task);
    return this.queue;
  }

  private resetForRun(
    runId?: string,
    options: {
      threadId?: string;
      conversationMessages?: AgentMessage[];
      sharedState?: JsonObject;
    } = {}
  ) {
    this.toolCalls.clear();
    this.autoExecutions.clear();
    this.streamedTextIds.clear();
    this.pendingAssistantMessageId = undefined;
    this.snapshot = {
      threadId: options.threadId ?? this.snapshot.threadId,
      runId,
      status: 'idle',
      events: [],
      conversationMessages: options.conversationMessages ?? this.snapshot.conversationMessages,
      sharedState: options.sharedState ?? {},
      textTranscript: '',
      toolCalls: [],
      pendingInteractiveTools: []
    };
    this.notify();
  }

  private async consumeRunStream(request: RunStartRequest, mode: 'start'): Promise<void>;
  private async consumeRunStream(request: RunResumeRequest, mode: 'resume'): Promise<void>;
  private async consumeRunStream(request: RunStartRequest | RunResumeRequest, mode: 'start' | 'resume'): Promise<void> {
    const controller = new AbortController();
    this.activeRunController = controller;

    try {
      const stream =
        mode === 'start'
          ? await this.transport.startRun(this.withRegisteredClientTools(request as RunStartRequest), { signal: controller.signal })
          : await this.transport.resume(request as RunResumeRequest, { signal: controller.signal });
      await this.consume(stream);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        this.applyLocalCancelledEvent(request.runId ?? this.snapshot.runId ?? createId('run'));
        return;
      }

      throw error;
    } finally {
      if (this.activeRunController === controller) {
        this.activeRunController = undefined;
      }
    }
  }

  private async consume(stream: AsyncIterable<CoreEvent>): Promise<void> {
    for await (const event of stream) {
      this.applyEvent(event);
    }

    if (this.snapshot.status !== 'cancelled') {
      await this.flushAutoTools();
    }
  }

  private async flushAutoTools(): Promise<void> {
    const pendingAutoTools = [...this.toolCalls.values()].filter(
      toolCall =>
        toolCall.executionPolicy === 'client_auto' &&
        toolCall.status === 'pending' &&
        !this.autoExecutions.has(toolCall.toolCallId)
    );

    for (const toolCall of pendingAutoTools) {
      if (!this.tools.get(toolCall.toolId)?.execute) {
        this.patchSnapshot({
          error: {
            code: 'client_tool_missing_handler',
            message: `No execute handler registered for auto tool "${toolCall.toolName}"`
          },
          status: 'error'
        });
        return;
      }

      try {
        this.autoExecutions.add(toolCall.toolCallId);
        await this.executeClientTool(toolCall);
      } catch (error) {
        if (isAbortError(error) || this.snapshot.status === 'cancelled') {
          return;
        }

        await this.resumeWithToolResult(
          toolCall.toolCallId,
          {
            code: error instanceof Error && error.name === 'ToolTimeoutError' ? 'tool_timeout' : 'client_tool_execution_failed',
            message: error instanceof Error ? error.message : 'Client tool execution failed'
          },
          {
            isError: true
          }
        );
      } finally {
        this.autoExecutions.delete(toolCall.toolCallId);
      }
    }
  }

  private async executeInteractiveTool(toolCallId: string): Promise<void> {
    const toolCall = this.getPendingInteractiveToolCall(toolCallId);
    const definition = this.tools.get(toolCall.toolId);
    if (!definition?.execute) {
      throw new Error(`Interactive client tool "${toolCall.toolName}" must define an execute handler to be approved`);
    }

    try {
      await this.executeClientTool(toolCall);
    } catch (error) {
      if (isAbortError(error) || this.snapshot.status === 'cancelled') {
        return;
      }

      await this.resumeWithToolResult(
        toolCall.toolCallId,
        {
          code: error instanceof Error && error.name === 'ToolTimeoutError' ? 'tool_timeout' : 'client_tool_execution_failed',
          message: error instanceof Error ? error.message : 'Client tool execution failed'
        },
        {
          isError: true
        }
      );
    }
  }

  private async executeClientTool(toolCall: ToolCallSnapshot): Promise<void> {
    const definition = this.tools.get(toolCall.toolId);
    if (!definition?.execute) {
      throw new Error(`No execute handler registered for client tool "${toolCall.toolName}"`);
    }

    const output = await withTimeout(
      Promise.resolve(definition.execute(toolCall.args, {
        runId: this.snapshot.runId ?? toolCall.runId,
        sharedState: this.snapshot.sharedState,
        toolCall,
        signal: this.activeRunController?.signal
      })),
      getToolTimeoutMs(definition),
      definition.name,
      this.activeRunController?.signal
    );
    validateSchema(definition.resultSchema, output, `${definition.name} tool result`);
    await this.resumeWithToolResult(toolCall.toolCallId, output);
  }

  private getPendingInteractiveToolCall(toolCallId: string): ToolCallSnapshot {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      throw new Error(`Unknown tool call "${toolCallId}"`);
    }

    if (toolCall.executionPolicy !== 'client_interactive') {
      throw new Error(`Tool call "${toolCallId}" is not interactive`);
    }

    if (toolCall.status !== 'pending') {
      throw new Error(`Tool call "${toolCallId}" is not pending`);
    }

    return toolCall;
  }

  private async resumeWithToolResult(
    toolCallId: string,
    output: JsonValue,
    options: {
      isError?: boolean;
    } = {}
  ): Promise<void> {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      throw new Error(`Unknown tool call "${toolCallId}"`);
    }

    if (toolCall.status === 'resolved') {
      if (stableStringify(toolCall.output) === stableStringify(output)) {
        return;
      }

      throw new Error(`Tool call "${toolCallId}" has already been resolved with a different output`);
    }

    const definition = this.tools.get(toolCall.toolId);
    if (!definition) {
      throw new Error(`Tool "${toolCall.toolName}" is not registered on the client`);
    }

    if (!options.isError) {
      validateSchema(definition.resultSchema, output, `${definition.name} tool result`);
    }

    toolCall.status = 'submitted';
    this.rebuildToolCollections();
    this.notify();

    const request: RunResumeRequest = {
      runId: this.snapshot.runId ?? toolCall.runId,
      toolResult: {
        runId: this.snapshot.runId ?? toolCall.runId,
        messageId: toolCall.messageId,
        toolCallId,
        toolId: toolCall.toolId,
        toolName: toolCall.toolName,
        modelName: toolCall.modelName,
        output,
        isError: options.isError,
        submittedAt: new Date().toISOString()
      }
    };

    await this.consumeRunStream(request, 'resume');
  }

  private commitPendingConversation() {
    if (!this.pendingConversationCommit) {
      return;
    }

    if (this.snapshot.status !== 'finished') {
      return;
    }

    this.pendingConversationCommit = false;
    if (!this.snapshot.textTranscript) {
      return;
    }

    this.patchSnapshot({
      conversationMessages: [
        ...this.snapshot.conversationMessages,
        createTextMessage('assistant', this.snapshot.textTranscript, this.pendingAssistantMessageId)
      ]
    });
    this.pendingAssistantMessageId = undefined;
  }

  private applyEvent(event: CoreEvent) {
    this.snapshot = {
      ...this.snapshot,
      runId: event.runId,
      events: [...this.snapshot.events, event]
    };

    switch (event.type) {
      case 'RUN_STARTED':
        this.patchSnapshot({
          runId: event.runId,
          threadId: event.threadId ?? this.snapshot.threadId,
          status: 'running'
        });
        break;
      case 'TEXT_DELTA':
        this.streamedTextIds.add(event.textId);
        this.patchSnapshot({
          textTranscript: `${this.snapshot.textTranscript}${event.delta}`
        });
        break;
      case 'TEXT_END':
        this.pendingAssistantMessageId = event.messageId;
        if (!this.streamedTextIds.has(event.textId)) {
          this.patchSnapshot({
            textTranscript: `${this.snapshot.textTranscript}${event.text}`
          });
        }
        break;
      case 'TOOL_CALL_END':
        this.toolCalls.set(event.toolCallId, {
          runId: event.runId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          toolId: event.toolId,
          toolName: event.toolName,
          modelName: event.modelName,
          toolRuntime: event.toolRuntime,
          executionPolicy: event.executionPolicy,
          timeoutMs: event.timeoutMs,
          args: event.args,
          createdAt: event.timestamp,
          status: 'pending'
        });
        this.rebuildToolCollections();
        break;
      case 'TOOL_RESULT': {
        const existing = this.toolCalls.get(event.toolCallId);
        if (existing) {
          existing.status = 'resolved';
          existing.output = event.output;
          existing.isError = event.isError;
          this.rebuildToolCollections();
        }
        break;
      }
      case 'STATE_DELTA':
        this.patchSnapshot({
          sharedState: {
            ...this.snapshot.sharedState,
            ...event.delta
          }
        });
        break;
      case 'RUN_FINISHED':
        this.patchSnapshot({
          status:
            event.finishReason === 'awaiting_client_tool'
              ? 'awaiting_client_tool'
              : event.finishReason === 'cancelled'
                ? 'cancelled'
                : 'finished'
        });
        break;
      case 'RUN_ERROR':
        this.patchSnapshot({
          error: event.error,
          status: 'error'
        });
        break;
      default:
        break;
    }

    this.notify();
  }

  private rebuildToolCollections() {
    const toolCalls = [...this.toolCalls.values()];
    this.snapshot = {
      ...this.snapshot,
      toolCalls,
      pendingInteractiveTools: toolCalls.filter(
        toolCall => toolCall.executionPolicy === 'client_interactive' && toolCall.status === 'pending'
      )
    };
  }

  private patchSnapshot(patch: Partial<AgentClientSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch
    };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private withRegisteredClientTools(request: RunStartRequest): RunStartRequest {
    const clientTools = this.getSerializableClientTools();
    if (clientTools.length === 0) {
      return request;
    }

    return {
      ...request,
      clientTools: [
        ...(request.clientTools ?? []),
        ...clientTools
      ]
    };
  }

  private getSerializableClientTools(): ClientToolDefinition[] {
    return [...this.tools.values()]
      .filter((definition): definition is NormalizedRegisteredClientTool & ClientToolDefinition => definition.executionPolicy !== 'server')
      .map(({ execute: _execute, ...definition }) => definition);
  }

  private async withEnabledSkillMetadata(metadata: JsonObject | undefined): Promise<JsonObject | undefined> {
    if (!this.skillManager) {
      return metadata;
    }

    const enabledSkills = await this.skillManager.getEnabledSkillRefs();
    if (enabledSkills.length === 0) {
      return metadata;
    }

    return mergeEnabledSkillMetadata(metadata, enabledSkills);
  }

  private applyLocalCancelledEvent(runId: string): void {
    if (this.snapshot.status === 'cancelled' || this.snapshot.status === 'finished') {
      return;
    }

    const lastSequence = this.snapshot.events.at(-1)?.sequence ?? 0;
    this.applyEvent({
      type: 'RUN_FINISHED',
      eventId: createId('evt'),
      runId,
      messageId: createId('msg'),
      sequence: lastSequence + 1,
      timestamp: nowIso(),
      finishReason: 'cancelled'
    });
  }
}

function getToolTimeoutMs(definition: ToolDefinition): number | undefined {
  return definition.timeoutMs === undefined ? DEFAULT_TOOL_TIMEOUT_MS : definition.timeoutMs;
}

class AgentSkillManagerRuntime implements AgentSkillManager {
  constructor(private readonly store: ClientSkillStore) {}

  async listSkills(): Promise<ClientSkillSummary[]> {
    return [...await this.store.listSkills()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async installSkill(input: ClientSkillInstallInput): Promise<ClientSkillSummary> {
    const skill = normalizeClientSkill(input);
    return this.store.saveSkill(skill);
  }

  async uninstallSkill(skillId: string): Promise<void> {
    await this.store.deleteSkill(skillId);
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
    const skills = await this.store.listSkills();
    const skill = skills.find(item => item.id === skillId);
    if (!skill) {
      throw new Error(`Unknown client skill "${skillId}"`);
    }

    await this.store.saveSkill({
      ...skill,
      enabled
    });
  }

  async getEnabledSkillRefs(): Promise<ClientSkillRef[]> {
    return (await this.listSkills())
      .filter(skill => skill.enabled && skill.status === 'ready')
      .map(skill => ({
        id: skill.id,
        digest: skill.digest,
        source: skill.source,
        version: skill.version
      }))
      .map(compactSkillRef);
  }
}

function normalizeClientSkill(input: ClientSkillInstallInput): ClientSkillSummary {
  assertNonEmptyString(input.id, 'skill id');
  assertNonEmptyString(input.name, 'skill name');
  assertNonEmptyString(input.description, 'skill description');
  assertNonEmptyString(input.digest, 'skill digest');

  return {
    ...input,
    enabled: input.enabled ?? false,
    status: input.status ?? 'ready',
    risk: input.risk ?? (input.hasScripts ? 'high' : 'low')
  };
}

function assertNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Client ${label} cannot be empty`);
  }
}

function mergeEnabledSkillMetadata(metadata: JsonObject | undefined, refs: ClientSkillRef[]): JsonObject {
  const existingSkills = isJsonObject(metadata?.skills) ? metadata.skills : {};
  const existingEnabled = Array.isArray(existingSkills.enabled)
    ? existingSkills.enabled.filter(isJsonObject)
    : [];
  const merged = dedupeSkillRefs([
    ...existingEnabled,
    ...refs.map(skillRefToJsonObject)
  ]);

  return {
    ...(metadata ?? {}),
    skills: {
      ...existingSkills,
      enabled: merged
    }
  };
}

function dedupeSkillRefs(refs: JsonObject[]): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  for (const ref of refs) {
    const id = typeof ref.id === 'string' ? ref.id : undefined;
    const digest = typeof ref.digest === 'string' ? ref.digest : undefined;
    if (!id || !digest) {
      continue;
    }

    byKey.set(`${id}:${digest}`, ref);
  }

  return [...byKey.values()];
}

function compactSkillRef(ref: ClientSkillRef): ClientSkillRef {
  return {
    id: ref.id,
    digest: ref.digest,
    ...(ref.source ? { source: ref.source } : {}),
    ...(ref.version ? { version: ref.version } : {})
  };
}

function skillRefToJsonObject(ref: ClientSkillRef): JsonObject {
  const compact = compactSkillRef(ref);
  return {
    id: compact.id,
    digest: compact.digest,
    ...(compact.source ? { source: compact.source } : {}),
    ...(compact.version ? { version: compact.version } : {})
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function createAbortError(message = 'Run was cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function withClientSystemPrompts(
  messages: AgentMessage[],
  systemPrompts: Array<ClientSystemPromptProvider | undefined>,
  context: ClientSystemPromptContext
): Promise<AgentMessage[]> {
  const combinedSystemPrompt = (
    await Promise.all(systemPrompts.map(prompt => resolveClientSystemPrompt(prompt, context)))
  )
    .map(prompt => prompt.trim())
    .filter((prompt): prompt is string => Boolean(prompt))
    .join('\n\n');
  if (!combinedSystemPrompt) {
    return messages;
  }

  return [createTextMessage('system', combinedSystemPrompt), ...messages];
}

async function resolveClientSystemPrompt(
  provider: ClientSystemPromptProvider | undefined,
  context: ClientSystemPromptContext
): Promise<string> {
  const prompt = typeof provider === 'function' ? await provider(context) : provider;
  return prompt?.trim() ?? '';
}

function createTextMessage(role: 'system' | 'user' | 'assistant', text: string, id = createId('msg')): AgentMessage {
  return {
    id,
    role,
    createdAt: nowIso(),
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

export type {
  CreateManagedMcpHttpClientToolsResult,
  McpClientToolMappingOptions,
  McpClientToolRefreshResult,
  McpHttpClientConnection,
  McpHttpClientOptions,
  McpManagedConnection,
  McpManagedConnectionState,
  McpManagedConnectionStatus,
  McpManagedConnectionStatusListener,
  McpManagedHttpClientOptions,
  McpToolClient,
  RegisterManagedMcpHttpClientToolsResult
} from './mcp.js';
export {
  connectMcpHttpClient,
  createManagedMcpConnection,
  createManagedMcpHttpClientTools,
  createManagedMcpHttpConnection,
  createMcpClientTools,
  McpConnectionUnavailableError,
  refreshMcpClientTools,
  registerManagedMcpHttpClientTools
} from './mcp.js';
