import {
  InMemorySessionStore,
  createAgentRunner,
  createAgentWorkflowTool,
  type AgentRunner,
  type AgentWorkflowAgentSpec,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput
} from '@mido/server-sdk';
import type { AgentMessage, CoreEvent, JsonObject, RunStartRequest } from '@mido/protocol-core';

type TestWorkflowOutput = JsonObject & {
  executionOrder: string[];
};

class FunctionModelAdapter implements ModelAdapter {
  constructor(private readonly handler: (input: ModelAdapterRunInput) => ModelAdapterEvent[] | Promise<ModelAdapterEvent[]>) {}

  async *run(input: ModelAdapterRunInput): AsyncIterable<ModelAdapterEvent> {
    for (const event of await this.handler(input)) {
      yield event;
    }
  }
}

describe('server agent workflows', () => {
  it('runs template agents as a DAG and passes dependency results to dependents', async () => {
    const childInputs = new Map<string, ModelAdapterRunInput>();
    const parentRunner = createWorkflowParentRunner({
      agents: [
        { id: 'repo', templateId: 'research', task: 'Inspect server SDK.' },
        { id: 'patterns', templateId: 'research', task: 'Compare orchestration patterns.' },
        { id: 'design', templateId: 'architect', task: 'Design the API.', dependsOn: ['repo', 'patterns'] }
      ]
    });

    parentRunner.registerTool(createAgentWorkflowTool({
      name: 'runAgentWorkflow',
      description: 'Create and coordinate multiple agents.',
      templates: {
        research: {
          description: 'Research specialist.',
          createRunner: request => createChildRunner(request.agent.id, childInputs)
        },
        architect: {
          description: 'Architecture specialist.',
          createRunner: request => createChildRunner(request.agent.id, childInputs)
        }
      },
      limits: {
        maxAgents: 5,
        maxParallelAgents: 2,
        maxModelCallsPerAgent: 2
      }
    }));

    const events = await collect(parentRunner.run(createRunRequest('Coordinate workers.')));
    const output = getWorkflowOutput(events);

    expect(output).toMatchObject({
      status: 'completed',
      modelCallCount: 3,
      toolCallCount: 0,
      agents: [
        { id: 'repo', templateId: 'research', mode: 'template', status: 'completed', outputText: 'output:repo' },
        { id: 'patterns', templateId: 'research', mode: 'template', status: 'completed', outputText: 'output:patterns' },
        { id: 'design', templateId: 'architect', mode: 'template', status: 'completed', outputText: 'output:design' }
      ]
    });
    expect(output.executionOrder.slice(0, 2).sort()).toEqual(['patterns', 'repo']);
    expect(output.executionOrder[2]).toBe('design');
    expect(readFirstText(childInputs.get('design'))).toContain('- repo: output:repo');
    expect(readFirstText(childInputs.get('design'))).toContain('- patterns: output:patterns');
  });

  it('creates an ad-hoc agent when templates do not satisfy the task and ad-hoc is allowed', async () => {
    let adHocRequest: { agent: AgentWorkflowAgentSpec } | undefined;
    const parentRunner = createWorkflowParentRunner({
      agents: [
        {
          id: 'security',
          mode: 'ad_hoc',
          task: 'Review permission risks.',
          systemPrompt: 'You are a security reviewer.'
        }
      ]
    });

    parentRunner.registerTool(createAgentWorkflowTool({
      name: 'runAgentWorkflow',
      description: 'Create and coordinate multiple agents.',
      templates: {},
      allowAdHocAgents: true,
      createAdHocRunner: request => {
        adHocRequest = { agent: request.agent };
        return createChildRunner(request.agent.id);
      }
    }));

    const events = await collect(parentRunner.run(createRunRequest('Coordinate workers.')));
    const output = getWorkflowOutput(events);

    expect(adHocRequest?.agent).toMatchObject({
      id: 'security',
      mode: 'ad_hoc',
      systemPrompt: 'You are a security reviewer.'
    });
    expect(output).toMatchObject({
      status: 'completed',
      agents: [
        {
          id: 'security',
          mode: 'ad_hoc',
          status: 'completed',
          outputText: 'output:security'
        }
      ]
    });
  });

  it('rejects ad-hoc agents when ad-hoc creation is not allowed', async () => {
    const parentRunner = createWorkflowParentRunner({
      agents: [
        {
          id: 'security',
          mode: 'ad_hoc',
          task: 'Review permission risks.',
          systemPrompt: 'You are a security reviewer.'
        }
      ]
    });

    parentRunner.registerTool(createAgentWorkflowTool({
      name: 'runAgentWorkflow',
      description: 'Create and coordinate multiple agents.',
      templates: {}
    }));

    const events = await collect(parentRunner.run(createRunRequest('Coordinate workers.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');

    expect(result).toMatchObject({
      type: 'TOOL_RESULT',
      isError: true,
      output: {
        status: 'error',
        error: {
          code: 'workflow_ad_hoc_not_allowed'
        }
      }
    });
  });

  it('rejects invalid dependency graphs before starting child agents', async () => {
    const parentRunner = createWorkflowParentRunner({
      agents: [
        { id: 'a', templateId: 'research', task: 'A', dependsOn: ['b'] },
        { id: 'b', templateId: 'research', task: 'B', dependsOn: ['a'] }
      ]
    });

    parentRunner.registerTool(createAgentWorkflowTool({
      name: 'runAgentWorkflow',
      description: 'Create and coordinate multiple agents.',
      templates: {
        research: {
          description: 'Research specialist.',
          createRunner: request => createChildRunner(request.agent.id)
        }
      }
    }));

    const events = await collect(parentRunner.run(createRunRequest('Coordinate workers.')));
    const result = events.find(event => event.type === 'TOOL_RESULT');

    expect(result).toMatchObject({
      type: 'TOOL_RESULT',
      isError: true,
      output: {
        status: 'error',
        error: {
          code: 'workflow_cycle_detected'
        },
        agents: []
      }
    });
  });
});

function createWorkflowParentRunner(args: JsonObject): AgentRunner {
  return createAgentRunner({
    modelAdapter: new FunctionModelAdapter(input => {
      const hasToolResult = input.messages.some(message => message.role === 'tool');
      return hasToolResult
        ? [{ type: 'done' }]
        : [{ type: 'tool-call', toolCallId: 'call-workflow', toolName: 'runAgentWorkflow', args }, { type: 'done' }];
    }),
    sessionStore: new InMemorySessionStore()
  });
}

function createChildRunner(agentId: string, inputs = new Map<string, ModelAdapterRunInput>()): AgentRunner {
  return createAgentRunner({
    modelAdapter: new FunctionModelAdapter(input => {
      inputs.set(agentId, input);
      return [{ type: 'text-end', textId: `text-${agentId}`, text: `output:${agentId}` }, { type: 'done' }];
    }),
    sessionStore: new InMemorySessionStore()
  });
}

async function collect(stream: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function createRunRequest(text: string): RunStartRequest {
  return {
    runId: 'run-parent',
    threadId: 'thread-parent',
    messages: [createUserMessage(text)]
  };
}

function createUserMessage(text: string): AgentMessage {
  return {
    id: 'msg-user',
    role: 'user',
    createdAt: new Date().toISOString(),
    content: [{ type: 'text', text }]
  };
}

function getWorkflowOutput(events: CoreEvent[]): TestWorkflowOutput {
  const result = events.find(event => event.type === 'TOOL_RESULT');
  if (!result || result.type !== 'TOOL_RESULT' || typeof result.output !== 'object' || result.output === null || Array.isArray(result.output)) {
    throw new Error('Workflow tool result was not found');
  }
  const executionOrder = result.output.executionOrder;
  if (!Array.isArray(executionOrder) || !executionOrder.every(item => typeof item === 'string')) {
    throw new Error('Workflow tool result did not include executionOrder');
  }

  return result.output as TestWorkflowOutput;
}

function readFirstText(input: ModelAdapterRunInput | undefined): string {
  const part = input?.messages[0]?.content[0];
  return part?.type === 'text' ? part.text : '';
}
