import {
  connectMcpHttpClient,
  createManagedMcpConnection,
  createManagedMcpHttpConnection,
  listAllMcpTools,
  mapMcpToolBase,
  toJsonValue,
  McpConnectionUnavailableError,
  type McpHttpClientConnection,
  type McpHttpClientOptions,
  type McpManagedConnection,
  type McpManagedConnectionState,
  type McpManagedConnectionStatus,
  type McpManagedConnectionStatusListener,
  type McpManagedHttpClientOptions,
  type McpToolRefreshResult,
  type McpTool,
  type McpToolClient,
  type McpToolMappingOptions
} from '@mido/mcp-core';
import type { JsonObject } from '@mido/protocol-core';

import type { AgentClient, ClientToolExecutionContext, NormalizedRegisteredClientTool, RegisteredClientTool } from './index.js';

export type { McpHttpClientConnection, McpHttpClientOptions, McpToolClient };
export type {
  McpManagedConnection,
  McpManagedConnectionState,
  McpManagedConnectionStatus,
  McpManagedConnectionStatusListener,
  McpManagedHttpClientOptions
};
export type McpClientToolMappingOptions = McpToolMappingOptions;

export interface CreateManagedMcpHttpClientToolsResult {
  connection: McpManagedConnection;
  tools: RegisteredClientTool[];
}

export interface RegisterManagedMcpHttpClientToolsResult {
  connection: McpManagedConnection;
  tools: NormalizedRegisteredClientTool[];
}

export interface McpClientToolRefreshResult {
  tools: RegisteredClientTool[];
  added: NormalizedRegisteredClientTool[];
  updated: NormalizedRegisteredClientTool[];
  removed: RegisteredClientTool[];
  unchanged: RegisteredClientTool[];
  raw: McpToolRefreshResult;
}

export { connectMcpHttpClient, createManagedMcpConnection, createManagedMcpHttpConnection, McpConnectionUnavailableError };

export async function createMcpClientTools(client: McpToolClient, options: McpClientToolMappingOptions = {}): Promise<RegisteredClientTool[]> {
  const tools = await listMcpToolsForMapping(client);
  return tools.map(tool => createMcpClientTool(client, tool, options));
}

export async function createManagedMcpHttpClientTools(
  options: McpManagedHttpClientOptions & McpClientToolMappingOptions
): Promise<CreateManagedMcpHttpClientToolsResult> {
  const connection = createManagedMcpHttpConnection({
    ...options,
    clientName: options.clientName ?? 'mido-client-core'
  });
  await connection.connect();
  const tools = await createMcpClientTools(connection, options);

  return {
    connection,
    tools
  };
}

export async function registerManagedMcpHttpClientTools(
  agentClient: Pick<AgentClient, 'registerClientTool'>,
  options: McpManagedHttpClientOptions & McpClientToolMappingOptions
): Promise<RegisterManagedMcpHttpClientToolsResult> {
  const connection = createManagedMcpHttpConnection({
    ...options,
    clientName: options.clientName ?? 'mido-client-core'
  });
  await connection.connect();
  const definitions = await createMcpClientTools(connection, options);
  const registered = definitions.map(definition => agentClient.registerClientTool(definition));

  return {
    connection,
    tools: registered
  };
}

export async function refreshMcpClientTools(
  agentClient: Pick<AgentClient, 'registerClientTool' | 'unregisterClientTool'>,
  connection: McpManagedConnection,
  options: McpClientToolMappingOptions = {}
): Promise<McpClientToolRefreshResult> {
  const raw = await connection.refreshTools();
  const tools = raw.tools.map(tool => createMcpClientTool(connection, tool, options));
  const added = raw.added.map(tool => agentClient.registerClientTool(createMcpClientTool(connection, tool, options)));
  const updated = raw.updated.map(tool => agentClient.registerClientTool(createMcpClientTool(connection, tool, options)));
  const removed = raw.removed.map(tool => createMcpClientTool(connection, tool, options));
  const unchanged = raw.unchanged.map(tool => createMcpClientTool(connection, tool, options));

  for (const definition of removed) {
    if (definition.toolId) {
      agentClient.unregisterClientTool(definition.toolId);
    }
  }

  return {
    tools,
    added,
    updated,
    removed,
    unchanged,
    raw
  };
}

function createMcpClientTool(client: McpToolClient, tool: McpTool, options: McpClientToolMappingOptions): RegisteredClientTool {
  return {
    ...mapMcpToolBase(tool, 'client', options),
    executionPolicy: 'client_auto',
    execute: async (args: JsonObject, _context: ClientToolExecutionContext) => toJsonValue(await client.callTool({
      name: tool.name,
      arguments: args
    }))
  };
}

async function listMcpToolsForMapping(client: McpToolClient): Promise<McpTool[]> {
  if (isManagedMcpConnection(client)) {
    return (await client.refreshTools()).tools;
  }

  return listAllMcpTools(client);
}

function isManagedMcpConnection(client: McpToolClient): client is McpManagedConnection {
  return typeof (client as Partial<McpManagedConnection>).refreshTools === 'function';
}
