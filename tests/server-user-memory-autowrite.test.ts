import type { AgentMessage, CoreEvent, ModelProviderMetadata, RunCheckpoint, RunStartRequest } from '@mido-agent/protocol-core';
import {
  InMemorySessionStore,
  InMemoryUserMemoryStore,
  applyUserMemoryAutowrites,
  createAgentRunner,
  extractUserMemoryCandidates,
  evaluateUserMemoryCandidate,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput,
  type StorageScope,
  type UserMemoryCandidate
} from '@mido-agent/server-sdk';

const approvalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' }
  },
  required: ['approved']
} as const;

describe('user memory autonomous write', () => {
  it('extracts stable user preferences as semantic candidates', () => {
    const candidates = extractUserMemoryCandidates([
      createUserMessage('I prefer pnpm for TypeScript packages.')
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: 'semantic',
      sourceKind: 'user_statement',
      text: 'User prefers pnpm for TypeScript packages.',
      confidence: expect.any(Number),
      importance: expect.any(Number)
    });
  });

  it('classifies corrections as superseding candidates', () => {
    const candidate: UserMemoryCandidate = {
      type: 'semantic',
      sourceKind: 'user_correction',
      text: 'User switched to Vercel for deployments.',
      confidence: 0.96,
      importance: 0.9,
      reason: 'user correction'
    };

    const decision = evaluateUserMemoryCandidate(candidate, {
      userKey: 'user:alpha',
      existingMemories: [
        {
          id: 'mem_sem_old',
          type: 'semantic',
          userKey: 'user:alpha',
          text: 'User deploys on Railway.',
          reason: 'old fact',
          confidence: 0.9,
          importance: 0.8,
          contentHash: 'old-hash',
          status: 'active',
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z'
        }
      ]
    });

    expect(decision).toMatchObject({
      action: 'write',
      supersedeTargetIds: ['mem_sem_old']
    });
  });

  it('writes pending and active memories through the autonomous writer', async () => {
    const store = new InMemoryUserMemoryStore();
    const userKey = 'user:alpha';
    const pendingCandidate: UserMemoryCandidate = {
      type: 'episodic',
      sourceKind: 'tool_result',
      text: 'Deployment tool returned summary: configured successfully.',
      confidence: 0.62,
      importance: 0.5,
      reason: 'tool result'
    };
    const activeCandidate: UserMemoryCandidate = {
      type: 'semantic',
      sourceKind: 'user_statement',
      text: 'User prefers pnpm for TypeScript packages.',
      confidence: 0.93,
      importance: 0.85,
      reason: 'preference stated by user'
    };

    const written = await applyUserMemoryAutowrites(store, userKey, [pendingCandidate, activeCandidate]);

    const activeResults = await store.search({ userKey, query: 'pnpm TypeScript packages' });
    const activeEntry = await store.read(userKey, activeResults[0]?.id ?? '');
    expect(activeResults).toHaveLength(1);
    expect(activeEntry).toMatchObject({
      text: 'User prefers pnpm for TypeScript packages.',
      status: 'active'
    });
    expect(written.find(entry => entry.text === pendingCandidate.text)).toMatchObject({
      text: pendingCandidate.text,
      status: 'pending'
    });
  });

  it('supersedes related active memories when applying user corrections', async () => {
    const store = new InMemoryUserMemoryStore();
    const userKey = 'user:alpha';
    const oldMemory = await store.write(userKey, {
      type: 'semantic',
      text: 'User deploys on Railway.',
      confidence: 0.9,
      importance: 0.8
    });

    await applyUserMemoryAutowrites(store, userKey, [
      {
        type: 'semantic',
        sourceKind: 'user_correction',
        text: 'User switched to Vercel for deployments.',
        confidence: 0.96,
        importance: 0.9,
        reason: 'user correction'
      }
    ]);

    const newMemory = (await store.search({ userKey, query: 'Vercel deployments' }))[0];
    await expect(store.read(userKey, oldMemory.id)).resolves.toMatchObject({
      status: 'superseded',
      supersededBy: newMemory.id
    });
    const activeRailwayResults = await store.search({ userKey, query: 'Railway deployment' });
    expect(activeRailwayResults.map(memory => memory.id)).not.toContain(oldMemory.id);
  });

  it('writes memories after a completed run when autonomous writing is enabled', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'text-delta', delta: 'Done' },
        { type: 'text-end', text: 'Done' },
        { type: 'done' }
      ]
    ]);
    const store = new InMemoryUserMemoryStore();
    const scope: StorageScope = { segments: ['tenant', 'alpha'] };
    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      userMemoryStore: store,
      userMemoryKey: 'user:alpha',
      autoWriteMemory: true
    });

    await collect(runner.run(createRunRequest('I prefer pnpm for TypeScript packages.'), { storageScope: scope }));

    await expect(store.search({ userKey: 'user:alpha', query: 'pnpm TypeScript packages' })).resolves.toHaveLength(1);
  });

  it('skips autowriting on resumed checkpoints without boundary metadata', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'done' }
      ]
    ]);
    const sessionStore = new InMemorySessionStore();
    const store = new InMemoryUserMemoryStore();
    const scope: StorageScope = { segments: ['tenant', 'alpha'] };
    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore,
      userMemoryStore: store,
      userMemoryKey: 'user:alpha',
      autoWriteMemory: true
    });

    const checkpoint: RunCheckpoint = {
      runId: 'run-legacy-checkpoint',
      threadId: 'thread-legacy-checkpoint',
      sequence: 3,
      messages: [
        createUserMessage('I prefer pnpm for TypeScript packages.'),
        {
          id: 'assistant-1',
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: [
            {
              type: 'tool-call',
              toolCallId: 'confirm-1',
              toolId: 'confirm-tool',
              toolName: 'confirm',
              modelName: 'confirm',
              args: { approved: false },
              executionPolicy: 'client_interactive'
            }
          ]
        }
      ],
      clientTools: [
        {
          toolId: 'confirm-tool',
          name: 'confirm',
          modelName: 'confirm',
          description: 'Confirm something',
          executionPolicy: 'client_interactive',
          inputSchema: approvalSchema,
          resultSchema: approvalSchema
        }
      ],
      state: {},
      pendingToolCalls: [
        {
          runId: 'run-legacy-checkpoint',
          messageId: 'assistant-1',
          toolCallId: 'confirm-1',
          toolId: 'confirm-tool',
          toolName: 'confirm',
          modelName: 'confirm',
          toolRuntime: 'client',
          executionPolicy: 'client_interactive',
          args: { approved: false },
          createdAt: new Date().toISOString()
        }
      ],
      submittedToolResults: [],
      processedToolCallIds: [],
      updatedAt: new Date().toISOString()
    };
    await sessionStore.saveCheckpoint(scope, checkpoint);

    await collect(
      runner.resume({
        runId: checkpoint.runId,
        toolResult: {
          runId: checkpoint.runId,
          messageId: 'tool-result-1',
          toolCallId: 'confirm-1',
          toolId: 'confirm-tool',
          toolName: 'confirm',
          modelName: 'confirm',
          output: { approved: true },
          submittedAt: new Date().toISOString()
        }
      }, { storageScope: scope })
    );

    await expect(store.search({ userKey: 'user:alpha', query: 'pnpm TypeScript packages' })).resolves.toHaveLength(0);
  });
});

class ScriptedModelAdapter implements ModelAdapter {
  readonly inputs: ModelAdapterRunInput[] = [];
  readonly metadata?: ModelProviderMetadata;
  private index = 0;

  constructor(private readonly scripts: ModelAdapterEvent[][]) {}

  async run(input: ModelAdapterRunInput): Promise<AsyncIterable<ModelAdapterEvent>> {
    this.inputs.push(JSON.parse(JSON.stringify(input)) as ModelAdapterRunInput);
    const script = this.scripts[this.index] ?? [];
    this.index += 1;

    return toAsyncIterable(script);
  }
}

function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

async function collect(events: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const collected: CoreEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function createRunRequest(text: string): RunStartRequest {
  return {
    messages: [createUserMessage(text)]
  };
}

function createUserMessage(text: string, id = 'user-1'): AgentMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}
