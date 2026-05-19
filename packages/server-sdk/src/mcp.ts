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

import type { AgentRunner, ServerToolRuntimeDefinition, ToolExecutionContext } from './runner.js';

export type { McpHttpClientConnection, McpHttpClientOptions, McpToolClient };
export type {
  McpManagedConnection,
  McpManagedConnectionState,
  McpManagedConnectionStatus,
  McpManagedConnectionStatusListener,
  McpManagedHttpClientOptions
};
export type McpServerToolMappingOptions = McpToolMappingOptions;

export interface RegisterManagedMcpHttpServerToolsResult {
  connection: McpManagedConnection;
  tools: ReturnType<AgentRunner['registerTool']>[];
}

export interface McpServerToolRefreshResult {
  tools: ServerToolRuntimeDefinition[];
  added: ServerToolRuntimeDefinition[];
  updated: ServerToolRuntimeDefinition[];
  removed: ServerToolRuntimeDefinition[];
  unchanged: ServerToolRuntimeDefinition[];
  raw: McpToolRefreshResult;
}

export { connectMcpHttpClient, createManagedMcpConnection, createManagedMcpHttpConnection, McpConnectionUnavailableError };

export async function createMcpServerTools(client: McpToolClient, options: McpServerToolMappingOptions = {}): Promise<ServerToolRuntimeDefinition[]> {
  const tools = await listMcpToolsForMapping(client);
  return tools.map(tool => createMcpServerTool(client, tool, options));
}

export async function registerManagedMcpHttpServerTools(
  runner: Pick<AgentRunner, 'registerTool'>,
  options: McpManagedHttpClientOptions & McpServerToolMappingOptions
): Promise<RegisterManagedMcpHttpServerToolsResult> {
  const connection = createManagedMcpHttpConnection({
    ...options,
    clientName: options.clientName ?? 'mido-server-sdk'
  });
  await connection.connect();
  const definitions = await createMcpServerTools(connection, options);
  const registered = definitions.map(definition => runner.registerTool(definition));

  return {
    connection,
    tools: registered
  };
}

export async function refreshMcpServerTools(
  connection: McpManagedConnection,
  options: McpServerToolMappingOptions = {}
): Promise<McpServerToolRefreshResult> {
  const raw = await connection.refreshTools();

  return {
    tools: raw.tools.map(tool => createMcpServerTool(connection, tool, options)),
    added: raw.added.map(tool => createMcpServerTool(connection, tool, options)),
    updated: raw.updated.map(tool => createMcpServerTool(connection, tool, options)),
    removed: raw.removed.map(tool => createMcpServerTool(connection, tool, options)),
    unchanged: raw.unchanged.map(tool => createMcpServerTool(connection, tool, options)),
    raw
  };
}

function createMcpServerTool(client: McpToolClient, tool: McpTool, options: McpServerToolMappingOptions): ServerToolRuntimeDefinition {
  return {
    ...mapMcpToolBase(tool, 'server', options),
    executionPolicy: 'server',
    execute: async (args: JsonObject, _context: ToolExecutionContext) => toJsonValue(await client.callTool({
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
