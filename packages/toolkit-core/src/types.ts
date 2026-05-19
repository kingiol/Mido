import type { JsonObject, JsonValue, ToolDefinition, ToolExecutionPolicy } from '@mido/protocol-core';

export type ToolkitToolDefinition = ToolDefinition & {
  execute?: (args: JsonObject, context?: unknown) => Promise<JsonValue> | JsonValue;
};

export type ToolPolicyKind = 'read' | 'write' | 'delete' | 'execute' | 'interact';
export type ToolExecutionPolicyConfig = Partial<Record<ToolPolicyKind, ToolExecutionPolicy>>;

export interface CreateWorkspaceToolsOptions {
  roots: string[];
  defaultRoot?: string;
  executionPolicy?: ToolExecutionPolicyConfig;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxSearchResults?: number;
  maxSearchFileBytes?: number;
  maxListEntries?: number;
  commandAllowlist?: string[];
  envAllowlist?: string[];
  defaultCommandTimeoutMs?: number;
  maxCommandOutputBytes?: number;
}

export interface SearchWebRequest {
  query: string;
  limit?: number;
  recencyDays?: number;
}

export interface SearchWebResult {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
  fetchedAt?: string;
  metadata?: JsonObject;
}

export type SearchWebProvider = (request: SearchWebRequest) => Promise<{ results: SearchWebResult[] } | SearchWebResult[]>;

export interface DocumentReaderRequest {
  content: string;
  contentType?: string;
  source?: string;
  chunkSize?: number;
}

export interface DocumentChunk {
  text: string;
  index: number;
  source?: string;
  metadata?: JsonObject;
}

export type DocumentReader = (request: DocumentReaderRequest) => Promise<{ chunks: DocumentChunk[] } | DocumentChunk[]>;

export interface CreateSearchAndRetrievalToolsOptions {
  store?: RetrievalStore;
  searchProvider?: SearchWebProvider;
  documentReader?: DocumentReader;
  executionPolicy?: ToolExecutionPolicyConfig;
  fetch?: typeof fetch;
  allowPrivateNetworks?: boolean;
  maxFetchBytes?: number;
  defaultChunkSize?: number;
}

export interface RetrievalDocument {
  id?: string;
  text: string;
  source?: string;
  metadata?: JsonObject;
}

export interface RetrievalEntry {
  id: string;
  namespace: string;
  text: string;
  source?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface RetrievalQueryResult extends RetrievalEntry {
  score: number;
}

export interface RetrievalStore {
  index(namespace: string, documents: RetrievalDocument[]): Promise<RetrievalEntry[]> | RetrievalEntry[];
  query(namespace: string, query: string, options?: { limit?: number }): Promise<RetrievalQueryResult[]> | RetrievalQueryResult[];
  delete(namespace: string, ids?: string[]): Promise<{ deleted: number; namespace: string }> | { deleted: number; namespace: string };
}

export interface MemoryEntry {
  id: string;
  scope: string;
  text: string;
  reason?: string;
  sourceRunId?: string;
  confidence?: number;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
}

export interface MemoryStore {
  listScopes(): Promise<string[]> | string[];
  search(scope: string, query: string, options?: { limit?: number }): Promise<MemorySearchResult[]> | MemorySearchResult[];
  read(scope: string, id: string): Promise<MemoryEntry | undefined> | MemoryEntry | undefined;
  write(input: {
    scope: string;
    text: string;
    reason?: string;
    sourceRunId?: string;
    confidence?: number;
    metadata?: JsonObject;
  }): Promise<MemoryEntry> | MemoryEntry;
  delete(scope: string, id: string): Promise<boolean> | boolean;
}

export interface CreateMemoryToolsOptions {
  store?: MemoryStore;
  executionPolicy?: ToolExecutionPolicyConfig;
}

export interface BrowserAutomationAdapter {
  open(args: JsonObject): Promise<JsonValue> | JsonValue;
  snapshot(args: JsonObject): Promise<JsonValue> | JsonValue;
  click(args: JsonObject): Promise<JsonValue> | JsonValue;
  type(args: JsonObject): Promise<JsonValue> | JsonValue;
  wait(args: JsonObject): Promise<JsonValue> | JsonValue;
  screenshot(args: JsonObject): Promise<JsonValue> | JsonValue;
  extract(args: JsonObject): Promise<JsonValue> | JsonValue;
}

export interface CreateBrowserAutomationToolsOptions {
  executionPolicy?: ToolExecutionPolicyConfig;
}
