import {
  DEFAULT_STORAGE_SCOPE,
  InMemoryEventStore,
  InMemorySessionStore,
  createAgentRunner,
  createAgentTool,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput
} from '@mido-agent/server-sdk';
import type { AgentMessage, CoreEvent, JsonObject, RunStartRequest } from '@mido-agent/protocol-core';

class FunctionModelAdapter implements ModelAdapter {
  constructor(private readonly handler: (input: ModelAdapterRunInput) => ModelAdapterEvent[] | Promise<ModelAdapterEvent[]>) {}

  async *run(input: ModelAdapterRunInput): AsyncIterable<ModelAdapterEvent> {
    for (const event of await this.handler(input)) {
      yield event;
    }
  }
}

describe('server agent tools', () => {
  it('runs a child agent as a server tool and returns a compact result', async () => {
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(() => [
        { type: 'text-end', textId: 'child-text', text: 'Research says Mido should use agent tools.' },
        { type: 'done' }
      ]),
      sessionStore: new InMemorySessionStore()
    });

    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message =>
          message.role === 'tool' &&
          message.content.some(part => part.type === 'tool-result')
        );

        if (!hasToolResult) {
          return [
            {
              type: 'tool-call',
              toolCallId: 'call-research',
              toolName: 'researchAgent',
              args: { task: 'Analyze the best multi-agent V1 for Mido.' }
            },
            { type: 'done' }
          ];
        }

        return [
          { type: 'text-end', textId: 'parent-text', text: 'Use sub-agents as server tools.' },
          { type: 'done' }
        ];
      }),
      sessionStore: new InMemorySessionStore()
    });

    parentRunner.registerTool(createAgentTool({
      agentId: 'research',
      name: 'researchAgent',
      description: 'Delegate focused research tasks to the research agent.',
      runner: childRunner
    }));

    const events = await collect(parentRunner.run(createRunRequest('Plan multi-agent support.')));
    const toolResult = events.find(event => event.type === 'TOOL_RESULT');

    expect(eventTypes(events)).toEqual([
      'RUN_STARTED',
      'MODEL_CALL_START',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'MODEL_CALL_END',
      'TOOL_RESULT',
      'MODEL_CALL_START',
      'TEXT_END',
      'MODEL_CALL_END',
      'RUN_FINISHED'
    ]);
    expect(toolResult).toMatchObject({
      type: 'TOOL_RESULT',
      toolName: 'researchAgent',
      output: {
        agentId: 'research',
        status: 'completed',
        outputText: 'Research says Mido should use agent tools.',
        eventCount: 5,
        modelCallCount: 1,
        toolCallCount: 0
      }
    });
  });

  it('returns a controlled error when a child agent waits for a client tool', async () => {
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(() => [
        {
          type: 'tool-call',
          toolCallId: 'client-call',
          toolName: 'localClientTool',
          args: {}
        },
        { type: 'done' }
      ]),
      sessionStore: new InMemorySessionStore()
    });
    childRunner.registerTool({
      name: 'localClientTool',
      description: 'Client-only tool.',
      executionPolicy: 'client_auto',
      inputSchema: { type: 'object' },
      resultSchema: { type: 'object' }
    });

    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        return hasToolResult
          ? [{ type: 'done' }]
          : [{ type: 'tool-call', toolCallId: 'call-child', toolName: 'childAgent', args: { task: 'Use local tool.' } }, { type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore()
    });

    parentRunner.registerTool(createAgentTool({
      agentId: 'child',
      name: 'childAgent',
      description: 'Delegate to child agent.',
      runner: childRunner
    }));

    const events = await collect(parentRunner.run(createRunRequest('Run child.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');

    expect(result).toMatchObject({
      type: 'TOOL_RESULT',
      isError: true,
      output: {
        agentId: 'child',
        status: 'error',
        error: {
          code: 'subagent_client_tool_unsupported'
        }
      }
    });
  });

  it('returns a controlled error when the child agent fails', async () => {
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(() => [
        { type: 'error', code: 'provider_failed', message: 'provider unavailable', retryable: true }
      ]),
      sessionStore: new InMemorySessionStore()
    });

    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        return hasToolResult
          ? [{ type: 'done' }]
          : [{ type: 'tool-call', toolCallId: 'call-child', toolName: 'childAgent', args: { task: 'Fail.' } }, { type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore()
    });

    parentRunner.registerTool(createAgentTool({
      agentId: 'child',
      name: 'childAgent',
      description: 'Delegate to child agent.',
      runner: childRunner
    }));

    const events = await collect(parentRunner.run(createRunRequest('Run child.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');

    expect(result).toMatchObject({
      type: 'TOOL_RESULT',
      isError: true,
      output: {
        status: 'error',
        error: {
          code: 'provider_failed',
          message: 'provider unavailable',
          retryable: true
        }
      }
    });
  });

  it('returns a controlled error when the child agent exceeds maxModelCalls', async () => {
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        return hasToolResult
          ? [{ type: 'text-end', text: 'second call' }, { type: 'done' }]
          : [{ type: 'tool-call', toolCallId: 'server-call', toolName: 'noop', args: {} }, { type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore()
    });
    childRunner.registerTool({
      name: 'noop',
      description: 'No-op server tool.',
      executionPolicy: 'server',
      inputSchema: { type: 'object' },
      resultSchema: { type: 'object' },
      execute: () => ({})
    });

    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        return hasToolResult
          ? [{ type: 'done' }]
          : [{ type: 'tool-call', toolCallId: 'call-child', toolName: 'childAgent', args: { task: 'Loop.' } }, { type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore()
    });

    parentRunner.registerTool(createAgentTool({
      agentId: 'child',
      name: 'childAgent',
      description: 'Delegate to child agent.',
      runner: childRunner,
      maxModelCalls: 1
    }));

    const events = await collect(parentRunner.run(createRunRequest('Run child.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');

    expect(result).toMatchObject({
      type: 'TOOL_RESULT',
      isError: true,
      output: {
        status: 'error',
        error: {
          code: 'subagent_model_call_limit_exceeded'
        }
      }
    });
  });

  it('auto-registers opt-in delegation agent tools and injects delegation guidance', async () => {
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(() => [
        { type: 'text-end', textId: 'child-text', text: 'delegated output' },
        { type: 'done' }
      ]),
      sessionStore: new InMemorySessionStore()
    });
    let firstParentInput: ModelAdapterRunInput | undefined;
    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        if (!hasToolResult) {
          firstParentInput = input;
          return [
            { type: 'tool-call', toolCallId: 'call-research', toolName: 'researchAgent', args: { task: 'Research SDK delegation.' } },
            { type: 'done' }
          ];
        }

        return [{ type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore(),
      delegation: {
        agents: [
          {
            agentId: 'research',
            name: 'researchAgent',
            description: 'Delegate focused research tasks to the research agent.',
            runner: childRunner
          }
        ]
      }
    });

    expect(parentRunner.listTools()).toEqual([
      expect.objectContaining({
        name: 'researchAgent',
        modelName: 'server__researchAgent',
        metadata: {
          mido: {
            kind: 'agent_tool',
            agentId: 'research'
          }
        }
      })
    ]);

    const events = await collect(parentRunner.run(createRunRequest('Use delegation.')));
    const toolResult = events.find(event => event.type === 'TOOL_RESULT');
    const systemText = firstParentInput?.messages[0]?.content.find(part => part.type === 'text')?.text ?? '';

    expect(toolResult).toMatchObject({
      type: 'TOOL_RESULT',
      toolName: 'researchAgent',
      output: {
        agentId: 'research',
        status: 'completed',
        outputText: 'delegated output'
      }
    });
    expect(systemText).toContain('# Agent Delegation');
    expect(systemText).toContain('server__researchAgent');
    expect(systemText).toContain('Use a single subagent tool for one focused, bounded task');
  });

  it('does not inject delegation guidance without opt-in delegation tools', async () => {
    let modelInput: ModelAdapterRunInput | undefined;
    const runner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        modelInput = input;
        return [{ type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base server prompt.'
    });

    await collect(runner.run(createRunRequest('No delegation.')));
    const systemText = modelInput?.messages[0]?.content.find(part => part.type === 'text')?.text ?? '';

    expect(systemText).toContain('Base server prompt.');
    expect(systemText).not.toContain('# Agent Delegation');
  });

  it('passes isolated child input, storage scope, and trace metadata', async () => {
    const eventStore = new InMemoryEventStore();
    let childInput: ModelAdapterRunInput | undefined;
    const childRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        childInput = input;
        return [{ type: 'text-end', text: 'child ok' }, { type: 'done' }];
      }),
      sessionStore: new InMemorySessionStore(),
      eventStore
    });

    const parentRunner = createAgentRunner({
      modelAdapter: new FunctionModelAdapter(input => {
        const hasToolResult = input.messages.some(message => message.role === 'tool');
        return hasToolResult
          ? [{ type: 'done' }]
          : [
              {
                type: 'tool-call',
                toolCallId: 'call-child',
                toolName: 'childAgent',
                args: {
                  task: 'Use scoped context.',
                  context: { topic: 'multi-agent' },
                  threadId: 'thread-child-fixed'
                }
              },
              { type: 'done' }
            ];
      }),
      sessionStore: new InMemorySessionStore()
    });

    parentRunner.registerTool(createAgentTool({
      agentId: 'child',
      name: 'childAgent',
      description: 'Delegate to child agent.',
      runner: childRunner,
      buildMetadata: () => ({ route: 'test' })
    }));

    const events = await collect(parentRunner.run(createRunRequest('Run child.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');
    const output = result?.type === 'TOOL_RESULT' ? result.output as JsonObject : {};
    const childRunId = typeof output.childRunId === 'string' ? output.childRunId : '';
    const childEvents = await eventStore.loadEvents(DEFAULT_STORAGE_SCOPE, { runId: childRunId });

    expect(childInput).toMatchObject({
      runId: childRunId,
      threadId: 'thread-child-fixed',
      state: { topic: 'multi-agent' },
      metadata: {
        traceId: 'run-parent',
        parentRunId: 'run-parent',
        parentThreadId: 'thread-parent',
        parentToolCallId: 'call-child',
        agentId: 'child',
        route: 'test'
      }
    });
    expect(childInput?.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: 'Task:\nUse scoped context.\n\nContext:\n{"topic":"multi-agent"}'
      }
    ]);
    expect(childEvents.map(event => event.type)).toEqual([
      'RUN_STARTED',
      'MODEL_CALL_START',
      'TEXT_END',
      'MODEL_CALL_END',
      'RUN_FINISHED'
    ]);
  });
});

async function collect(stream: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function createUserMessage(text: string): AgentMessage {
  return {
    id: 'msg-user',
    role: 'user',
    createdAt: new Date().toISOString(),
    content: [{ type: 'text', text }]
  };
}

function createRunRequest(text: string): RunStartRequest {
  return {
    runId: 'run-parent',
    threadId: 'thread-parent',
    messages: [createUserMessage(text)]
  };
}

function eventTypes(events: CoreEvent[]): string[] {
  return events.map(event => event.type);
}
