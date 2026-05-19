import { createManagedMcpConnection, type McpManagedConnectionStatus, type McpTool, type McpToolClient } from '@mido/mcp-core';

function makeTool(name: string, description: string): McpTool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object'
    }
  };
}

describe('mcp-core managed connection', () => {
  it('reconnects once when a tool call fails on a stale connection', async () => {
    const closed: string[] = [];
    const statuses: McpManagedConnectionStatus['state'][] = [];
    let connectCount = 0;

    const firstClient: McpToolClient & { ping(): Promise<unknown> } = {
      async ping() {
        throw new Error('connection is stale');
      },
      async listTools() {
        return {
          tools: [makeTool('lookup', 'Lookup')]
        };
      },
      async callTool() {
        throw new Error('session expired');
      }
    };
    const secondClient: McpToolClient = {
      async listTools() {
        return {
          tools: [makeTool('lookup', 'Lookup')]
        };
      },
      async callTool(params) {
        return {
          ok: true,
          name: params.name,
          arguments: params.arguments
        };
      }
    };

    const manager = createManagedMcpConnection({
      url: 'https://mcp.example.test/mcp',
      connect: async () => {
        connectCount += 1;
        const id = `connection-${connectCount}`;
        return {
          client: connectCount === 1 ? firstClient : secondClient,
          close: async () => {
            closed.push(id);
          },
          terminateSession: async () => {}
        };
      }
    });

    manager.subscribe(status => {
      statuses.push(status.state);
    });

    await manager.connect();
    const result = await manager.callTool({
      name: 'lookup',
      arguments: {
        city: 'Hangzhou'
      }
    });

    expect(result).toEqual({
      ok: true,
      name: 'lookup',
      arguments: {
        city: 'Hangzhou'
      }
    });
    expect(connectCount).toBe(2);
    expect(closed).toEqual(['connection-1']);
    expect(manager.getStatus().state).toBe('ready');
    expect(statuses).toEqual(['connecting', 'ready', 'degraded', 'reconnecting', 'ready']);
  });

  it('does not retry when a tool call fails but the connection is still healthy', async () => {
    let connectCount = 0;
    let callCount = 0;
    const client: McpToolClient & { ping(): Promise<unknown> } = {
      async ping() {
        return {};
      },
      async listTools() {
        return {
          tools: [makeTool('lookup', 'Lookup')]
        };
      },
      async callTool() {
        callCount += 1;
        throw new Error('tool rejected the input');
      }
    };
    const manager = createManagedMcpConnection({
      url: 'https://mcp.example.test/mcp',
      connect: async () => {
        connectCount += 1;
        return {
          client,
          close: async () => {},
          terminateSession: async () => {}
        };
      }
    });

    await manager.connect();

    await expect(manager.callTool({
      name: 'lookup',
      arguments: {
        city: 'Hangzhou'
      }
    })).rejects.toThrow('tool rejected the input');
    expect(connectCount).toBe(1);
    expect(callCount).toBe(1);
    expect(manager.getStatus().state).toBe('ready');
  });

  it('returns a stable tool diff when refreshing remote tools', async () => {
    let snapshotIndex = 0;
    const snapshots = [
      [makeTool('lookup', 'Lookup v1'), makeTool('route', 'Route v1')],
      [makeTool('lookup', 'Lookup v2'), makeTool('nearby', 'Nearby v1')]
    ];
    const listRequests: Array<{ cursor?: string } | undefined> = [];

    const client: McpToolClient = {
      async listTools(params) {
        listRequests.push(params);
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

    const manager = createManagedMcpConnection({
      url: 'https://mcp.example.test/mcp',
      connect: async () => ({
        client,
        close: async () => {},
        terminateSession: async () => {}
      })
    });

    await manager.connect();
    const first = await manager.refreshTools();
    snapshotIndex = 1;
    const second = await manager.refreshTools();

    expect(first.added.map(tool => tool.name)).toEqual(['lookup', 'route']);
    expect(first.updated).toEqual([]);
    expect(first.removed).toEqual([]);
    expect(first.unchanged).toEqual([]);
    expect(second.added.map(tool => tool.name)).toEqual(['nearby']);
    expect(second.updated.map(tool => tool.name)).toEqual(['lookup']);
    expect(second.removed.map(tool => tool.name)).toEqual(['route']);
    expect(second.unchanged).toEqual([]);
    expect(second.tools.map(tool => tool.name)).toEqual(['lookup', 'nearby']);
    expect(listRequests).toEqual([undefined, { cursor: 'next' }, undefined, { cursor: 'next' }]);
  });
});
