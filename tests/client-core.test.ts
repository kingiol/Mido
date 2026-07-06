import { createAgentClient, createAgentSkillManager, createManagedMcpConnection, createMcpClientTools, refreshMcpClientTools } from '@mido-agent/client-core';
import type { AgentTransport, ClientSkillStore, McpToolClient } from '@mido-agent/client-core';
import type { CoreEvent, RunResumeRequest, RunStartRequest } from '@mido-agent/protocol-core';

const locationResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { type: 'string' }
  },
  required: ['location']
} as const;

describe('client-core', () => {
  it('manages native client skill state and returns enabled skill refs', async () => {
    const store = new MemorySkillStore();
    const manager = createAgentSkillManager({ store });

    await manager.installSkill({
      id: 'support-triage',
      name: 'Support Triage',
      description: 'Triage support tickets.',
      digest: 'sha256:abc',
      source: 'user',
      hasScripts: false
    });
    await manager.installSkill({
      id: 'report-writer',
      name: 'Report Writer',
      description: 'Draft reports.',
      digest: 'sha256:def',
      source: 'user',
      hasScripts: true,
      status: 'needs_review'
    });
    await manager.setSkillEnabled('support-triage', true);
    await manager.setSkillEnabled('report-writer', true);

    expect(await manager.listSkills()).toMatchObject([
      {
        id: 'report-writer',
        enabled: true,
        status: 'needs_review'
      },
      {
        id: 'support-triage',
        enabled: true,
        status: 'ready'
      }
    ]);
    expect(await manager.getEnabledSkillRefs()).toEqual([
      {
        id: 'support-triage',
        digest: 'sha256:abc',
        source: 'user'
      }
    ]);
  });

  it('adds enabled client skill refs to run metadata', async () => {
    const startRequests: RunStartRequest[] = [];
    const store = new MemorySkillStore();
    const skillManager = createAgentSkillManager({ store });
    await skillManager.installSkill({
      id: 'support-triage',
      name: 'Support Triage',
      description: 'Triage support tickets.',
      digest: 'sha256:abc',
      source: 'user',
      enabled: true
    });
    const transport: AgentTransport = {
      async startRun(request) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };
    const client = createAgentClient({
      transport,
      skillManager
    });

    await client.sendMessage('Please triage this ticket.', {
      metadata: {
        tenantId: 'tenant-1',
        skills: {
          enabled: [
            {
              id: 'admin-approved',
              digest: 'sha256:server',
              source: 'admin'
            }
          ]
        }
      }
    });

    expect(startRequests[0]?.metadata).toEqual({
      tenantId: 'tenant-1',
      skills: {
        enabled: [
          {
            id: 'admin-approved',
            digest: 'sha256:server',
            source: 'admin'
          },
          {
            id: 'support-triage',
            digest: 'sha256:abc',
            source: 'user'
          }
        ]
      }
    });
  });

  it('rebuilds retry skill metadata from the current skill state', async () => {
    const startRequests: RunStartRequest[] = [];
    const store = new MemorySkillStore();
    const skillManager = createAgentSkillManager({ store });
    await skillManager.installSkill({
      id: 'support-triage',
      name: 'Support Triage',
      description: 'Triage support tickets.',
      digest: 'sha256:abc',
      source: 'user',
      enabled: true
    });
    const transport: AgentTransport = {
      async startRun(request) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };
    const client = createAgentClient({
      transport,
      skillManager
    });

    await client.sendMessage('Please triage this ticket.', {
      metadata: {
        tenantId: 'tenant-1',
        skills: {
          enabled: [
            {
              id: 'admin-approved',
              digest: 'sha256:server',
              source: 'admin'
            }
          ]
        }
      }
    });
    await skillManager.setSkillEnabled('support-triage', false);
    await client.retryLastRun({
      runId: 'retry-1'
    });

    expect(startRequests[0]?.metadata).toEqual({
      tenantId: 'tenant-1',
      skills: {
        enabled: [
          {
            id: 'admin-approved',
            digest: 'sha256:server',
            source: 'admin'
          },
          {
            id: 'support-triage',
            digest: 'sha256:abc',
            source: 'user'
          }
        ]
      }
    });
    expect(startRequests[1]?.metadata).toEqual({
      tenantId: 'tenant-1',
      skills: {
        enabled: [
          {
            id: 'admin-approved',
            digest: 'sha256:server',
            source: 'admin'
          }
        ]
      }
    });
  });

  it('wraps remote MCP tools as auto client tools', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const listRequests: Array<{ cursor?: string } | undefined> = [];
    const resumeRequests: RunResumeRequest[] = [];
    const mcpClient: McpToolClient = {
      async listTools(params) {
        listRequests.push(params);
        if (params?.cursor === 'next') {
          return {
            tools: [
              {
                name: 'unused',
                inputSchema: {
                  type: 'object'
                }
              }
            ]
          };
        }

        return {
          nextCursor: 'next',
          tools: [
            {
              name: 'lookup',
              description: 'Lookup through MCP',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  location: { type: 'string' }
                },
                required: ['location']
              }
            }
          ]
        };
      },
      async callTool(params) {
        calls.push(params);
        return {
          content: [
            {
              type: 'text',
              text: String(params.arguments?.location)
            }
          ]
        };
      }
    };
    const transport: AgentTransport = {
      async startRun() {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:mcp_lookup',
            toolName: 'mcp_lookup',
            modelName: 'client__mcp_lookup',
            toolRuntime: 'client',
            executionPolicy: 'client_auto',
            args: {
              location: 'Hangzhou'
            }
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    const [tool, secondTool] = await createMcpClientTools(mcpClient);
    expect(listRequests).toEqual([undefined, { cursor: 'next' }]);
    expect(secondTool?.name).toBe('mcp_unused');
    client.registerClientTool(tool!);

    await client.startRun({
      messages: []
    });

    expect(calls).toEqual([
      {
        name: 'lookup',
        arguments: {
          location: 'Hangzhou'
        }
      }
    ]);
    expect(resumeRequests[0]?.toolResult.output).toEqual({
      content: [
        {
          type: 'text',
          text: 'Hangzhou'
        }
      ]
    });
  });

  it('refreshes registered MCP client tools without keeping removed tools', async () => {
    let snapshotIndex = 0;
    const startRequests: RunStartRequest[] = [];
    const snapshots = [
      [
        {
          name: 'lookup',
          description: 'Lookup v1',
          inputSchema: {
            type: 'object' as const
          }
        },
        {
          name: 'route',
          description: 'Route v1',
          inputSchema: {
            type: 'object' as const
          }
        }
      ],
      [
        {
          name: 'lookup',
          description: 'Lookup v2',
          inputSchema: {
            type: 'object' as const
          }
        },
        {
          name: 'nearby',
          description: 'Nearby v1',
          inputSchema: {
            type: 'object' as const
          }
        }
      ]
    ];
    const mcpClient: McpToolClient = {
      async listTools(params) {
        const tools = snapshots[snapshotIndex] ?? [];
        if (params?.cursor === 'next') {
          return {
            tools: tools.slice(1)
          };
        }

        return {
          nextCursor: tools.length > 1 ? 'next' : undefined,
          tools: tools.slice(0, 1)
        };
      },
      async callTool() {
        return {};
      }
    };
    const transport: AgentTransport = {
      async startRun(request) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const connection = createManagedMcpConnection({
      connect: async () => ({
        client: mcpClient,
        close: async () => {},
        terminateSession: async () => {}
      })
    });
    const client = createAgentClient({ transport });
    const initialTools = await createMcpClientTools(connection);
    initialTools.forEach(tool => client.registerClientTool(tool));

    await client.startRun({ messages: [] });
    snapshotIndex = 1;
    const refresh = await refreshMcpClientTools(client, connection);
    await client.startRun({ messages: [] });

    expect(startRequests[0]?.clientTools?.map(tool => tool.name)).toEqual(['mcp_lookup', 'mcp_route']);
    expect(refresh.added.map(tool => tool.name)).toEqual(['mcp_nearby']);
    expect(refresh.updated.map(tool => tool.name)).toEqual(['mcp_lookup']);
    expect(refresh.removed.map(tool => tool.name)).toEqual(['mcp_route']);
    expect(startRequests[1]?.clientTools?.map(tool => tool.name)).toEqual(['mcp_lookup', 'mcp_nearby']);
    expect(startRequests[1]?.clientTools?.find(tool => tool.name === 'mcp_lookup')?.description).toBe('Lookup v2');
  });

  it('keeps conversation memory across sendMessage calls', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        const latestUserMessage = [...request.messages].reverse().find(message => message.role === 'user');
        const latestText = latestUserMessage?.content.find(part => part.type === 'text')?.text ?? '';

        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: `Answer: ${latestText}`
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({ transport, threadId: 'thread-1' });

    await client.sendMessage('First');
    await client.sendMessage('Second');

    expect(startRequests).toHaveLength(2);
    expect(startRequests[0]?.messages.map(message => message.role)).toEqual(['user']);
    expect(startRequests[1]?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(startRequests[1]?.messages[1]?.id).toBe('msg-1');
    expect(startRequests[1]?.messages.map(message => message.content.find(part => part.type === 'text')?.text)).toEqual([
      'First',
      'Answer: First',
      'Second'
    ]);
    expect(client.getSnapshot().conversationMessages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('sends registered client tool definitions with new runs', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'client_lookup',
      description: 'Lookup through a client MCP server',
      executionPolicy: 'client_auto',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      },
      resultSchema: {
        type: 'object',
        additionalProperties: true
      },
      execute: async () => ({ ok: true })
    });

    await client.sendMessage('Find coffee');

    expect(startRequests[0]?.clientTools).toMatchObject([
      {
        name: 'client_lookup',
        modelName: 'client__client_lookup',
        executionPolicy: 'client_auto'
      }
    ]);
    expect(JSON.stringify(startRequests[0]?.clientTools)).not.toContain('execute');
  });

  it('sends a per-run client system prompt without storing it in conversation memory', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: 'ok'
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({ transport, threadId: 'thread-1' });
    await client.sendMessage('Hi', {
      systemPrompt: 'Answer in JSON.'
    });

    expect(startRequests[0]?.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(startRequests[0]?.messages[0]?.content.find(part => part.type === 'text')?.text).toBe('Answer in JSON.');
    expect(client.getSnapshot().conversationMessages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('sends a default client system prompt from client creation', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: 'ok'
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({
      transport,
      threadId: 'thread-1',
      systemPrompt: 'Always end answers with 大爷好。'
    });

    await client.sendMessage('Hi', {
      systemPrompt: 'Use concise wording.'
    });

    expect(startRequests[0]?.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(startRequests[0]?.messages[0]?.content.find(part => part.type === 'text')?.text).toBe(
      'Always end answers with 大爷好。\n\nUse concise wording.'
    );
    expect(client.getSnapshot().conversationMessages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('supports dynamic client system prompts and runtime updates', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: 'ok'
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({
      transport,
      threadId: 'thread-1',
      systemPrompt: context => `Default prompt for ${context.threadId}.`
    });

    await client.sendMessage('First', {
      systemPrompt: async context => {
        const latestText = context.messages.at(-1)?.content.find(part => part.type === 'text')?.text ?? 'unknown';
        return `Per-message prompt for ${latestText}.`;
      }
    });
    client.setSystemPrompt('Updated default prompt.');
    await client.sendMessage('Second');

    expect(startRequests[0]?.messages[0]?.content.find(part => part.type === 'text')?.text).toBe(
      'Default prompt for thread-1.\n\nPer-message prompt for First.'
    );
    expect(startRequests[1]?.messages[0]?.content.find(part => part.type === 'text')?.text).toBe('Updated default prompt.');
    expect(client.getSnapshot().conversationMessages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('adds the default client system prompt to explicit startRun requests', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        return streamOf([
          createEvent('RUN_STARTED', {
            threadId: request.threadId
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({
      transport,
      systemPrompt: 'Always end answers with 大爷好。'
    });

    await client.startRun({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          createdAt: '2026-04-28T00:00:00.000Z',
          content: [{ type: 'text', text: 'Hi' }]
        }
      ]
    });

    expect(startRequests[0]?.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(startRequests[0]?.messages[0]?.content.find(part => part.type === 'text')?.text).toBe(
      'Always end answers with 大爷好。'
    );
  });

  it('auto executes client tools and resumes the run', async () => {
    const resumeRequests: RunResumeRequest[] = [];
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:getLocation',
            toolName: 'getLocation',
            modelName: 'client__getLocation',
            toolRuntime: 'client',
            executionPolicy: 'client_auto',
            args: {}
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request: RunResumeRequest) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('TOOL_RESULT', {
            toolCallId: 'tool-1',
            toolName: 'getLocation',
            output: request.toolResult.output
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: 'Hangzhou'
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'getLocation',
      description: 'Read the local location',
      executionPolicy: 'client_auto',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: locationResultSchema,
      execute: async () => ({ location: 'Hangzhou' })
    });

    await client.startRun({
      messages: []
    });

    expect(resumeRequests).toHaveLength(1);
    expect(resumeRequests[0]?.toolResult.output).toEqual({ location: 'Hangzhou' });
    expect(client.getSnapshot().status).toBe('finished');
    expect(client.getSnapshot().textTranscript).toBe('Hangzhou');
  });

  it('resumes with an error when auto client tools time out', async () => {
    const resumeRequests: RunResumeRequest[] = [];
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:getLocation',
            toolName: 'getLocation',
            modelName: 'client__getLocation',
            toolRuntime: 'client',
            executionPolicy: 'client_auto',
            timeoutMs: 1,
            args: {}
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request: RunResumeRequest) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('TOOL_RESULT', {
            toolCallId: 'tool-1',
            toolName: 'getLocation',
            output: request.toolResult.output,
            isError: request.toolResult.isError
          }),
          createEvent('TEXT_END', {
            textId: 'txt-1',
            text: 'Recovered'
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'getLocation',
      description: 'Read the local location',
      executionPolicy: 'client_auto',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: locationResultSchema,
      timeoutMs: 1,
      execute: async () => new Promise(() => {})
    });

    await client.startRun({
      messages: []
    });

    expect(resumeRequests).toHaveLength(1);
    expect(resumeRequests[0]?.toolResult).toMatchObject({
      toolCallId: 'tool-1',
      isError: true,
      output: {
        code: 'tool_timeout'
      }
    });
    expect(client.getSnapshot().status).toBe('finished');
    expect(client.getSnapshot().textTranscript).toBe('Recovered');
  });

  it('executes interactive client tools only after approval', async () => {
    const executeCalls: unknown[] = [];
    const resumeRequests: RunResumeRequest[] = [];
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:deleteDraft',
            toolName: 'deleteDraft',
            modelName: 'client__deleteDraft',
            toolRuntime: 'client',
            executionPolicy: 'client_interactive',
            args: {
              draftId: 'draft-1'
            }
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request: RunResumeRequest) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('TOOL_RESULT', {
            toolCallId: 'tool-1',
            toolName: 'deleteDraft',
            output: request.toolResult.output
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'deleteDraft',
      description: 'Delete a local draft after user approval',
      executionPolicy: 'client_interactive',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string' }
        },
        required: ['draftId']
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean' }
        },
        required: ['deleted']
      },
      execute: async args => {
        executeCalls.push(args);
        return { deleted: true };
      }
    });

    await client.startRun({
      messages: []
    });

    expect(executeCalls).toHaveLength(0);
    expect(client.getSnapshot().pendingInteractiveTools).toHaveLength(1);

    await client.approveToolCall('tool-1');

    expect(executeCalls).toEqual([{ draftId: 'draft-1' }]);
    expect(resumeRequests[0]?.toolResult).toMatchObject({
      toolCallId: 'tool-1',
      isError: undefined,
      output: {
        deleted: true
      }
    });
    expect(client.getSnapshot().status).toBe('finished');
  });

  it('rejects interactive client tools without executing them', async () => {
    const executeCalls: unknown[] = [];
    const resumeRequests: RunResumeRequest[] = [];
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:deleteDraft',
            toolName: 'deleteDraft',
            modelName: 'client__deleteDraft',
            toolRuntime: 'client',
            executionPolicy: 'client_interactive',
            args: {
              draftId: 'draft-1'
            }
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume(request: RunResumeRequest) {
        resumeRequests.push(request);
        return streamOf([
          createEvent('TOOL_RESULT', {
            toolCallId: 'tool-1',
            toolName: 'deleteDraft',
            output: request.toolResult.output,
            isError: request.toolResult.isError
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'completed'
          })
        ]);
      }
    };

    const client = createAgentClient({ transport });
    client.registerClientTool({
      name: 'deleteDraft',
      description: 'Delete a local draft after user approval',
      executionPolicy: 'client_interactive',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string' }
        },
        required: ['draftId']
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean' }
        },
        required: ['deleted']
      },
      execute: async args => {
        executeCalls.push(args);
        return { deleted: true };
      }
    });

    await client.startRun({
      messages: []
    });
    await client.rejectToolCall('tool-1', 'User declined deleting the draft');

    expect(executeCalls).toHaveLength(0);
    expect(resumeRequests[0]?.toolResult).toMatchObject({
      toolCallId: 'tool-1',
      isError: true,
      output: {
        code: 'client_tool_rejected',
        message: 'User declined deleting the draft'
      }
    });
    expect(client.getSnapshot().status).toBe('finished');
  });

  it('cancels a run waiting for an interactive client tool', async () => {
    const transport: AgentTransport = {
      async startRun(_request: RunStartRequest) {
        return streamOf([
          createEvent('RUN_STARTED', {}),
          createEvent('TOOL_CALL_END', {
            toolCallId: 'tool-1',
            toolId: 'client:deleteDraft',
            toolName: 'deleteDraft',
            modelName: 'client__deleteDraft',
            toolRuntime: 'client',
            executionPolicy: 'client_interactive',
            args: {
              draftId: 'draft-1'
            }
          }),
          createEvent('RUN_FINISHED', {
            finishReason: 'awaiting_client_tool',
            pendingToolCallId: 'tool-1',
            pendingToolCallIds: ['tool-1']
          })
        ]);
      },
      async resume() {
        return streamOf([]);
      },
      async cancelRun(request) {
        return createEvent('RUN_FINISHED', {
          runId: request.runId,
          finishReason: 'cancelled',
          pendingToolCallIds: ['tool-1']
        } as never);
      }
    };

    const client = createAgentClient({ transport });
    await client.startRun({ messages: [] });
    await client.cancelRun();

    expect(client.getSnapshot().status).toBe('cancelled');
    expect(client.getSnapshot().events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      finishReason: 'cancelled'
    });
  });

  it('retries the last failed message without adding a duplicate user turn', async () => {
    const startRequests: RunStartRequest[] = [];
    const transport: AgentTransport = {
      async startRun(request: RunStartRequest) {
        startRequests.push(request);
        if (startRequests.length === 1) {
          return streamOf([
            createEvent('RUN_STARTED', {
              runId: request.runId
            } as never),
            createEvent('RUN_ERROR', {
              runId: request.runId,
              error: {
                code: 'provider_error',
                message: 'temporary failure',
                retryable: true
              }
            } as never)
          ]);
        }

        return streamOf([
          createEvent('RUN_STARTED', {
            runId: request.runId,
            threadId: request.threadId
          } as never),
          createEvent('TEXT_END', {
            runId: request.runId,
            textId: 'txt-1',
            text: 'Recovered'
          } as never),
          createEvent('RUN_FINISHED', {
            runId: request.runId,
            finishReason: 'completed'
          } as never)
        ]);
      },
      async resume() {
        return streamOf([]);
      }
    };

    const client = createAgentClient({ transport, threadId: 'thread-1' });
    await client.sendMessage('Try once');

    expect(client.getSnapshot().status).toBe('error');

    await client.retryLastRun();

    expect(startRequests).toHaveLength(2);
    expect(startRequests[0]?.runId).not.toBe(startRequests[1]?.runId);
    expect(startRequests[1]?.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(client.getSnapshot().status).toBe('finished');
    expect(client.getSnapshot().conversationMessages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(client.getSnapshot().conversationMessages.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: 'Recovered'
    });
  });
});

function createEvent<T extends CoreEvent['type']>(type: T, payload: Omit<Extract<CoreEvent, { type: T }>, 'type' | 'eventId' | 'runId' | 'messageId' | 'sequence' | 'timestamp'>): CoreEvent {
  return {
    type,
    eventId: `evt-${Math.random()}`,
    runId: 'run-1',
    messageId: 'msg-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    ...payload
  } as CoreEvent;
}

function streamOf(events: CoreEvent[]): AsyncIterable<CoreEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

class MemorySkillStore implements ClientSkillStore {
  private skills: Awaited<ReturnType<ClientSkillStore['listSkills']>> = [];

  async listSkills() {
    return this.skills;
  }

  async saveSkill(skill: Awaited<ReturnType<ClientSkillStore['listSkills']>>[number]) {
    this.skills = [
      ...this.skills.filter(existing => existing.id !== skill.id),
      skill
    ].sort((a, b) => a.id.localeCompare(b.id));
    return skill;
  }

  async deleteSkill(skillId: string) {
    this.skills = this.skills.filter(skill => skill.id !== skillId);
  }
}
