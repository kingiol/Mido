import { randomUUID } from 'node:crypto';

import type { JsonObject } from '@mido/protocol-core';

import { createStableId, createTool, objectSchema, rankByText } from './tool.js';
import type { CreateMemoryToolsOptions, MemoryEntry, MemorySearchResult, MemoryStore, ToolkitToolDefinition } from './types.js';
import { readOptionalJsonObject, readOptionalNumber, readOptionalString, readRequiredString } from './validation.js';

export function createMemoryTools(options: CreateMemoryToolsOptions = {}): ToolkitToolDefinition[] {
  const store = options.store ?? new InMemoryMemoryStore();
  const policy = options.executionPolicy ?? {};

  return [
    createTool({
      name: 'memory_list_scopes',
      description: 'List available long-term memory scopes.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: { type: 'object', additionalProperties: false },
      policy: { risk: 'low', effects: ['read'], scopes: ['memory:read'] },
      execute: async () => ({ scopes: await store.listScopes() })
    }),
    createTool({
      name: 'memory_search',
      description: 'Search long-term memory entries inside a scope.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Memory namespace to search, such as a project, user, or application scope.' },
          query: { type: 'string', description: 'Natural-language search query for matching memory text.' },
          limit: { type: 'number', description: 'Maximum number of matching memory entries to return. Defaults to 10.' }
        },
        required: ['scope', 'query'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['memory:read'] },
      execute: async args => ({
        scope: readRequiredString(args.scope, 'scope'),
        entries: await store.search(readRequiredString(args.scope, 'scope'), readRequiredString(args.query, 'query'), {
          limit: readOptionalNumber(args.limit, 'limit')
        })
      })
    }),
    createTool({
      name: 'memory_read',
      description: 'Read a long-term memory entry by id inside a scope.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Memory namespace containing the entry.' },
          id: { type: 'string', description: 'Memory entry id returned by memory_search or memory_write.' }
        },
        required: ['scope', 'id'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['memory:read'] },
      execute: async args => {
        const scope = readRequiredString(args.scope, 'scope');
        const id = readRequiredString(args.id, 'id');
        const entry = await store.read(scope, id);
        if (!entry) {
          throw new Error(`Memory entry "${id}" was not found in scope "${scope}"`);
        }

        return entry;
      }
    }),
    createTool({
      name: 'memory_write',
      description: 'Write a long-term memory entry inside a scope.',
      executionPolicy: policy.write ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Memory namespace to write into, such as a project, user, or application scope.' },
          text: { type: 'string', description: 'Durable memory text to store for future retrieval.' },
          reason: { type: 'string', description: 'Short explanation of why this memory should be stored.' },
          sourceRunId: { type: 'string', description: 'Optional run id that produced this memory.' },
          confidence: { type: 'number', description: 'Optional confidence score for the memory, usually between 0 and 1.' },
          metadata: { ...objectSchema, description: 'Optional structured metadata to store with the memory entry.' }
        },
        required: ['scope', 'text', 'reason'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['write'], scopes: ['memory:write'] },
      execute: async args =>
        store.write({
          scope: readRequiredString(args.scope, 'scope'),
          text: readRequiredString(args.text, 'text'),
          reason: readOptionalString(args.reason, 'reason'),
          sourceRunId: readOptionalString(args.sourceRunId, 'sourceRunId'),
          confidence: readOptionalNumber(args.confidence, 'confidence'),
          metadata: readOptionalJsonObject(args.metadata, 'metadata')
        })
    }),
    createTool({
      name: 'memory_delete',
      description: 'Delete a long-term memory entry inside a scope.',
      executionPolicy: policy.delete ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Memory namespace containing the entry to delete.' },
          id: { type: 'string', description: 'Memory entry id to delete.' }
        },
        required: ['scope', 'id'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['delete'], scopes: ['memory:delete'] },
      execute: async args => {
        const scope = readRequiredString(args.scope, 'scope');
        const id = readRequiredString(args.id, 'id');
        return { deleted: await store.delete(scope, id), id, scope };
      }
    })
  ];
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  listScopes(): string[] {
    return [...new Set([...this.entries.values()].map(entry => entry.scope))].sort();
  }

  search(scope: string, query: string, options: { limit?: number } = {}): MemorySearchResult[] {
    return rankByText([...this.entries.values()].filter(entry => entry.scope === scope), query, entry => entry.text)
      .slice(0, options.limit ?? 10)
      .map(({ item, score }) => ({ ...item, score }));
  }

  read(scope: string, id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    return entry?.scope === scope ? entry : undefined;
  }

  write(input: {
    scope: string;
    text: string;
    reason?: string;
    sourceRunId?: string;
    confidence?: number;
    metadata?: JsonObject;
  }): MemoryEntry {
    const now = new Date().toISOString();
    const id = createStableId('mem', `${input.scope}:${input.text}:${now}:${randomUUID()}`);
    const entry: MemoryEntry = {
      id,
      scope: input.scope,
      text: input.text,
      reason: input.reason,
      sourceRunId: input.sourceRunId,
      confidence: input.confidence,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    };
    this.entries.set(id, entry);
    return entry;
  }

  delete(scope: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.scope !== scope) {
      return false;
    }

    return this.entries.delete(id);
  }
}
