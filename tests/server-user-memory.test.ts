import type { AgentMessage, CoreEvent, ModelProviderMetadata, RunStartRequest } from '@mido/protocol-core';
import {
  InMemorySessionStore,
  InMemoryUserMemoryStore,
  createAgentRunner,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput,
  type StorageScope
} from '@mido/server-sdk';

describe('server user memory', () => {
  it('deduplicates scoped semantic memories by content hash', async () => {
    const store = new InMemoryUserMemoryStore();
    const userKey = store.deriveUserKey({ segments: ['tenant', 'alpha'] });

    const first = await store.write(userKey, {
      type: 'semantic',
      text: 'The user deploys FastAPI services on Railway.',
      confidence: 0.9,
      importance: 0.8,
      reason: 'User stated deployment target'
    });
    const duplicate = await store.write(userKey, {
      type: 'semantic',
      text: 'The user deploys FastAPI services on Railway.',
      confidence: 0.7,
      importance: 0.4
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.confidence).toBe(0.9);
    expect(duplicate.importance).toBe(0.8);
    await expect(store.search({ userKey, query: 'Railway deployment', limit: 1 })).resolves.toMatchObject([
      {
        id: first.id,
        type: 'semantic',
        text: 'The user deploys FastAPI services on Railway.',
        score: expect.any(Number)
      }
    ]);
  });

  it('isolates search, read, and delete by derived user key', async () => {
    const store = new InMemoryUserMemoryStore();
    const alpha = store.deriveUserKey({ segments: ['tenant', 'alpha'] });
    const beta = store.deriveUserKey({ segments: ['tenant', 'beta'] });
    const alphaMemory = await store.write(alpha, {
      text: 'The user prefers pnpm workspaces for TypeScript packages.',
      confidence: 0.95
    });
    await store.write(beta, {
      text: 'The user prefers npm scripts for JavaScript packages.',
      confidence: 0.95
    });

    await expect(store.search({ userKey: alpha, query: 'pnpm workspace' })).resolves.toHaveLength(1);
    await expect(store.search({ userKey: alpha, query: 'npm scripts' })).resolves.toHaveLength(0);
    await expect(store.read(beta, alphaMemory.id)).resolves.toBeUndefined();
    await expect(store.delete(beta, alphaMemory.id)).resolves.toBe(false);
    await expect(store.delete(alpha, alphaMemory.id)).resolves.toBe(true);
    await expect(store.read(alpha, alphaMemory.id)).resolves.toBeUndefined();
  });

  it('injects relevant memories into the runner system prompt', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'text-delta', delta: 'Done' },
        { type: 'text-end', text: 'Done' },
        { type: 'done' }
      ]
    ]);
    const store = new InMemoryUserMemoryStore();
    const scope: StorageScope = { segments: ['tenant', 'alpha'] };
    await store.write(store.deriveUserKey(scope), {
      type: 'semantic',
      text: 'The user prefers Python 3.12 for backend services.',
      confidence: 0.95,
      importance: 0.9
    });

    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base instruction.',
      userMemoryStore: store,
      userMemoryKey: store.deriveUserKey(scope)
    });

    await collect(runner.run(createRunRequest('Write a backend deployment script'), { storageScope: scope }));

    const systemText = getFirstSystemText(adapter.inputs[0]?.messages);
    expect(systemText).toContain('Base instruction.');
    expect(systemText).toContain('## User Memory');
    expect(systemText).toContain('Python 3.12');
    expect(systemText).toContain("trust the user's latest statement");
  });

  it('does not derive user memory from a generic storage scope implicitly', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'text-delta', delta: 'Done' },
        { type: 'text-end', text: 'Done' },
        { type: 'done' }
      ]
    ]);
    const store = new InMemoryUserMemoryStore();
    const workspaceScope: StorageScope = { segments: ['workspace', 'shared'] };
    await store.write(store.deriveUserKey(workspaceScope), {
      type: 'semantic',
      text: 'A different user prefers Go for backend services.',
      confidence: 0.95,
      importance: 0.9
    });

    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base instruction.',
      userMemoryStore: store
    });

    await collect(runner.run(createRunRequest('Write a backend deployment script'), { storageScope: workspaceScope }));

    expect(getFirstSystemText(adapter.inputs[0]?.messages)).toBe('Base instruction.');
  });

  it('does not inject memories when the user query is empty', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'text-delta', delta: 'Done' },
        { type: 'text-end', text: 'Done' },
        { type: 'done' }
      ]
    ]);
    const store = new InMemoryUserMemoryStore();
    const userKey = store.deriveUserKey({ segments: ['user', 'alpha'] });
    await store.write(userKey, {
      text: 'The user prefers Python 3.12 for backend services.',
      confidence: 0.95,
      importance: 0.9
    });
    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base instruction.',
      userMemoryStore: store,
      userMemoryKey: userKey
    });

    await collect(runner.run(createRunRequest('   ')));

    expect(getFirstSystemText(adapter.inputs[0]?.messages)).toBe('Base instruction.');
  });

  it('does not add an empty user memory block', async () => {
    const adapter = new ScriptedModelAdapter([
      [
        { type: 'text-delta', delta: 'Done' },
        { type: 'text-end', text: 'Done' },
        { type: 'done' }
      ]
    ]);
    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base instruction.',
      userMemoryStore: new InMemoryUserMemoryStore()
    });

    await collect(runner.run(createRunRequest('Write a backend deployment script')));

    expect(getFirstSystemText(adapter.inputs[0]?.messages)).toBe('Base instruction.');
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
    messages: [
      {
        id: 'user-1',
        role: 'user',
        createdAt: new Date().toISOString(),
        content: [
          {
            type: 'text',
            text
          }
        ]
      }
    ]
  };
}

function getFirstSystemText(messages: AgentMessage[] | undefined): string {
  const systemMessage = messages?.find(message => message.role === 'system');
  return systemMessage?.content.find(part => part.type === 'text')?.text ?? '';
}
