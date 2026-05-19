import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { nowIso, stableStringify, type JsonObject, type JsonValue, type JSONSchema } from '@mido/protocol-core';

export type { McpTool };

export interface McpHttpClientOptions {
  url: string | URL;
  clientName?: string;
  clientVersion?: string;
  transport?: StreamableHTTPClientTransportOptions;
}

export interface McpHttpClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  url: URL;
  close(): Promise<void>;
  terminateSession(): Promise<void>;
}

export interface McpToolClient {
  listTools(params?: { cursor?: string }): Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: JsonObject }): Promise<unknown>;
}

export type McpManagedConnectionState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'reconnecting' | 'closed' | 'failed';

export interface McpManagedConnectionStatus {
  state: McpManagedConnectionState;
  updatedAt: string;
  url?: string;
  error?: Error;
  lastConnectedAt?: string;
  lastHealthCheckedAt?: string;
  lastToolRefreshAt?: string;
}

export type McpManagedConnectionStatusListener = (status: McpManagedConnectionStatus) => void;

export interface McpManagedConnectionHandle {
  client: McpToolClient;
  close(): Promise<void>;
  terminateSession(): Promise<void>;
}

export interface McpManagedConnectionOptions<Connection extends McpManagedConnectionHandle = McpManagedConnectionHandle> {
  connect: () => Promise<Connection>;
  url?: string | URL;
  reconnectOnToolCallError?: boolean;
  healthCheck?: (connection: Connection) => Promise<void>;
}

export interface McpToolRefreshResult {
  tools: McpTool[];
  added: McpTool[];
  updated: McpTool[];
  removed: McpTool[];
  unchanged: McpTool[];
}

export interface McpManagedConnection<Connection extends McpManagedConnectionHandle = McpManagedConnectionHandle> extends McpToolClient {
  connect(): Promise<Connection>;
  reconnect(): Promise<Connection>;
  close(): Promise<void>;
  terminateSession(): Promise<void>;
  healthCheck(): Promise<McpManagedConnectionStatus>;
  refreshTools(): Promise<McpToolRefreshResult>;
  getConnection(): Connection | undefined;
  getStatus(): McpManagedConnectionStatus;
  subscribe(listener: McpManagedConnectionStatusListener): () => void;
}

export interface McpManagedHttpClientOptions extends McpHttpClientOptions {
  reconnectOnToolCallError?: boolean;
  healthCheck?: (connection: McpHttpClientConnection) => Promise<void>;
}

export class McpConnectionUnavailableError extends Error {
  readonly status: McpManagedConnectionStatus;
  readonly cause: unknown;

  constructor(message: string, status: McpManagedConnectionStatus, cause?: unknown) {
    super(message);
    this.name = 'McpConnectionUnavailableError';
    this.status = status;
    this.cause = cause;
  }
}

export interface McpToolMappingOptions {
  namePrefix?: string;
  mapToolName?: (tool: McpTool) => string;
  mapToolModelName?: (tool: McpTool, midoToolName: string) => string;
  mapToolId?: (tool: McpTool, midoToolName: string) => string;
  resultSchema?: JSONSchema;
  timeoutMs?: number;
}

const DEFAULT_CLIENT_NAME = 'mido-mcp-core';
const DEFAULT_CLIENT_VERSION = '0.1.0';
const DEFAULT_MCP_TOOL_NAME_PREFIX = 'mcp_';
const DEFAULT_MCP_RESULT_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: true
};

export async function connectMcpHttpClient(options: McpHttpClientOptions): Promise<McpHttpClientConnection> {
  const url = options.url instanceof URL ? options.url : new URL(options.url);
  const client = new Client({
    name: options.clientName ?? DEFAULT_CLIENT_NAME,
    version: options.clientVersion ?? DEFAULT_CLIENT_VERSION
  });
  const transport = new StreamableHTTPClientTransport(url, options.transport);
  await client.connect(transport);

  return {
    client,
    transport,
    url,
    close: () => client.close(),
    terminateSession: () => transport.terminateSession()
  };
}

export function createManagedMcpHttpConnection(options: McpManagedHttpClientOptions): McpManagedConnection<McpHttpClientConnection> {
  const { reconnectOnToolCallError, healthCheck, ...connectionOptions } = options;

  return createManagedMcpConnection({
    url: options.url,
    reconnectOnToolCallError,
    healthCheck,
    connect: () => connectMcpHttpClient(connectionOptions)
  });
}

export function createManagedMcpConnection<Connection extends McpManagedConnectionHandle>(
  options: McpManagedConnectionOptions<Connection>
): McpManagedConnection<Connection> {
  return new ManagedMcpConnection(options);
}

export async function listAllMcpTools(client: McpToolClient): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return tools;
}

class ManagedMcpConnection<Connection extends McpManagedConnectionHandle> implements McpManagedConnection<Connection> {
  private readonly listeners = new Set<McpManagedConnectionStatusListener>();
  private readonly reconnectOnToolCallError: boolean;
  private connection?: Connection;
  private connectPromise?: Promise<Connection>;
  private toolCache = new Map<string, { tool: McpTool; fingerprint: string }>();
  private status: McpManagedConnectionStatus;

  constructor(private readonly options: McpManagedConnectionOptions<Connection>) {
    this.reconnectOnToolCallError = options.reconnectOnToolCallError ?? true;
    this.status = {
      state: 'idle',
      updatedAt: nowIso(),
      url: options.url?.toString()
    };
  }

  async connect(): Promise<Connection> {
    if (this.connection && this.status.state === 'ready') {
      return this.connection;
    }

    return this.open('connecting');
  }

  async reconnect(): Promise<Connection> {
    const previous = this.connection;
    this.connection = undefined;

    if (previous) {
      await ignoreCloseError(previous.close());
    }

    return this.open('reconnecting');
  }

  async close(): Promise<void> {
    const current = this.connection;
    this.connection = undefined;
    this.toolCache = new Map();

    if (current) {
      await current.close();
    }

    this.setStatus({
      state: 'closed',
      error: undefined
    });
  }

  async terminateSession(): Promise<void> {
    const current = this.connection;
    if (current) {
      await current.terminateSession();
    }

    await this.close();
  }

  async healthCheck(): Promise<McpManagedConnectionStatus> {
    const connection = await this.ensureConnection();

    try {
      await this.runHealthCheck(connection);
      const lastHealthCheckedAt = nowIso();
      this.setStatus({
        state: 'ready',
        error: undefined,
        lastHealthCheckedAt
      });
      return this.getStatus();
    } catch (error) {
      this.setStatus({
        state: 'degraded',
        error: toError(error)
      });
      throw this.unavailable('MCP health check failed', error);
    }
  }

  async refreshTools(): Promise<McpToolRefreshResult> {
    const tools = await listAllMcpTools(this);
    const nextCache = new Map<string, { tool: McpTool; fingerprint: string }>();
    const added: McpTool[] = [];
    const updated: McpTool[] = [];
    const unchanged: McpTool[] = [];

    for (const tool of tools) {
      const fingerprint = stableStringify(tool);
      const previous = this.toolCache.get(tool.name);
      nextCache.set(tool.name, {
        tool,
        fingerprint
      });

      if (!previous) {
        added.push(tool);
      } else if (previous.fingerprint === fingerprint) {
        unchanged.push(tool);
      } else {
        updated.push(tool);
      }
    }

    const removed = [...this.toolCache.entries()]
      .filter(([name]) => !nextCache.has(name))
      .map(([, entry]) => entry.tool);

    this.toolCache = nextCache;
    this.setStatus({
      state: 'ready',
      error: undefined,
      lastToolRefreshAt: nowIso()
    });

    return {
      tools,
      added,
      updated,
      removed,
      unchanged
    };
  }

  async listTools(params?: { cursor?: string }): Promise<{ tools: McpTool[]; nextCursor?: string }> {
    return this.withReconnect(() => this.requireConnection().client.listTools(params), 'MCP listTools failed');
  }

  async callTool(params: { name: string; arguments?: JsonObject }): Promise<unknown> {
    return this.withReconnect(() => this.requireConnection().client.callTool(params), `MCP tool "${params.name}" failed`);
  }

  getConnection(): Connection | undefined {
    return this.connection;
  }

  getStatus(): McpManagedConnectionStatus {
    return {
      ...this.status
    };
  }

  subscribe(listener: McpManagedConnectionStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.connection && this.status.state === 'ready') {
      return this.connection;
    }

    return this.open(this.status.state === 'idle' ? 'connecting' : 'reconnecting');
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw this.unavailable('MCP connection is not available');
    }

    return this.connection;
  }

  private async withReconnect<T>(operation: () => Promise<T>, message: string): Promise<T> {
    await this.ensureConnection();

    try {
      return await operation();
    } catch (error) {
      if (!this.reconnectOnToolCallError) {
        this.setStatus({
          state: 'degraded',
          error: toError(error)
        });
        throw error;
      }

      const shouldReconnect = await this.shouldReconnectAfterOperationError(error);
      if (!shouldReconnect) {
        throw error;
      }

      await this.reconnect();

      try {
        return await operation();
      } catch (retryError) {
        this.setStatus({
          state: 'failed',
          error: toError(retryError)
        });
        throw this.unavailable(message, retryError);
      }
    }
  }

  private open(nextState: 'connecting' | 'reconnecting'): Promise<Connection> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.setStatus({
      state: nextState,
      error: undefined
    });

    this.connectPromise = this.options.connect()
      .then(connection => {
        this.connection = connection;
        this.setStatus({
          state: 'ready',
          error: undefined,
          lastConnectedAt: nowIso()
        });
        return connection;
      })
      .catch(error => {
        this.connection = undefined;
        this.setStatus({
          state: 'failed',
          error: toError(error)
        });
        throw this.unavailable('MCP connection failed', error);
      })
      .finally(() => {
        this.connectPromise = undefined;
      });

    return this.connectPromise;
  }

  private async shouldReconnectAfterOperationError(error: unknown): Promise<boolean> {
    const current = this.connection;
    if (!current) {
      this.setStatus({
        state: 'degraded',
        error: toError(error)
      });
      return true;
    }

    try {
      await this.runHealthCheck(current);
      this.setStatus({
        state: 'ready',
        error: undefined,
        lastHealthCheckedAt: nowIso()
      });
      return false;
    } catch {
      this.setStatus({
        state: 'degraded',
        error: toError(error)
      });
      return true;
    }
  }

  private async runHealthCheck(connection: Connection): Promise<void> {
    if (this.options.healthCheck) {
      await this.options.healthCheck(connection);
      return;
    }

    await defaultMcpHealthCheck(connection);
  }

  private setStatus(patch: Partial<McpManagedConnectionStatus> & { state: McpManagedConnectionState }): void {
    this.status = {
      ...this.status,
      ...patch,
      updatedAt: nowIso()
    };

    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private unavailable(message: string, cause?: unknown): McpConnectionUnavailableError {
    return new McpConnectionUnavailableError(message, this.getStatus(), cause);
  }
}

export function mapMcpToolBase(tool: McpTool, runtime: 'server' | 'client', options: McpToolMappingOptions = {}) {
  const name = options.mapToolName?.(tool) ?? `${options.namePrefix ?? DEFAULT_MCP_TOOL_NAME_PREFIX}${tool.name}`;

  return {
    toolId: options.mapToolId?.(tool, name) ?? `${runtime}:${name}`,
    modelName: options.mapToolModelName?.(tool, name) ?? createToolModelName(runtime, name),
    name,
    description: tool.description ?? `Remote MCP tool "${tool.name}"`,
    inputSchema: toJsonSchema(tool.inputSchema),
    resultSchema: options.resultSchema ?? DEFAULT_MCP_RESULT_SCHEMA,
    timeoutMs: options.timeoutMs,
    metadata: {
      mcp: {
        toolName: tool.name
      }
    }
  };
}

export function toJsonSchema(schema: unknown): JSONSchema {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as JSONSchema;
  }

  return {
    type: 'object',
    additionalProperties: true
  };
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('MCP tool result contains a non-finite number');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => toJsonValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<JsonObject>((result, [key, item]) => {
      if (item !== undefined) {
        result[key] = toJsonValue(item);
      }
      return result;
    }, {});
  }

  throw new Error(`MCP tool result is not JSON serializable: ${typeof value}`);
}

export function createToolModelName(runtime: 'server' | 'client', name: string): string {
  const base = `${runtime}__${sanitizeModelName(name)}`;
  if (base.length <= 64) {
    return base;
  }

  const hash = hashString(name);
  return `${base.slice(0, 63 - hash.length)}_${hash}`;
}

function sanitizeModelName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

async function defaultMcpHealthCheck(connection: McpManagedConnectionHandle): Promise<void> {
  const client = connection.client as McpToolClient & { ping?: () => Promise<unknown> };
  if (typeof client.ping === 'function') {
    await client.ping();
    return;
  }

  await client.listTools();
}

async function ignoreCloseError(closePromise: Promise<void>): Promise<void> {
  try {
    await closePromise;
  } catch {
    // Reconnect should not be blocked by cleanup failures from a stale transport.
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
