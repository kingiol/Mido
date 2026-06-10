import { createHash } from 'node:crypto';

import { nowIso, type AgentMessage, type JsonObject } from '@mido/protocol-core';

import { getStorageScopeHash, normalizeStorageScope, type StorageScope } from './store.js';

export type UserMemoryType = 'semantic' | 'episodic' | 'procedural';
export type UserMemoryStatus = 'active' | 'pending' | 'superseded' | 'expired';

export interface UserMemoryEntry {
  id: string;
  type: UserMemoryType;
  userKey: string;
  text: string;
  reason?: string;
  sourceThreadId?: string;
  sourceRunId?: string;
  confidence: number;
  importance: number;
  contentHash: string;
  status: UserMemoryStatus;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
  tags?: string[];
  metadata?: JsonObject;
}

export interface UserMemorySearchResult extends UserMemoryEntry {
  score: number;
}

export interface UserMemorySearchInput {
  userKey: string;
  query: string;
  types?: UserMemoryType[];
  limit?: number;
  minConfidence?: number;
  includeExpired?: boolean;
  statuses?: UserMemoryStatus[];
}

export interface UserMemoryWriteInput {
  id?: string;
  type?: UserMemoryType;
  status?: UserMemoryStatus;
  text: string;
  reason?: string;
  sourceThreadId?: string;
  sourceRunId?: string;
  confidence?: number;
  importance?: number;
  expiresAt?: string;
  supersededBy?: string;
  tags?: string[];
  metadata?: JsonObject;
}

export interface UserMemoryUpdateInput {
  text?: string;
  status?: UserMemoryStatus;
  reason?: string;
  sourceThreadId?: string;
  sourceRunId?: string;
  confidence?: number;
  importance?: number;
  expiresAt?: string;
  supersededBy?: string;
  tags?: string[];
  metadata?: JsonObject;
}

export interface UserMemoryStats {
  total: number;
  active: number;
  pending: number;
  expired: number;
  superseded: number;
}

export interface UserMemoryStore {
  deriveUserKey(scope?: StorageScope): string;
  search(input: UserMemorySearchInput): Promise<UserMemorySearchResult[]>;
  read(userKey: string, id: string): Promise<UserMemoryEntry | undefined>;
  write(userKey: string, input: UserMemoryWriteInput): Promise<UserMemoryEntry>;
  delete(userKey: string, id: string): Promise<boolean>;
  update?(userKey: string, id: string, patch: UserMemoryUpdateInput): Promise<UserMemoryEntry | undefined>;
  deleteAllForUser?(userKey: string): Promise<number>;
  stats?(userKey: string): Promise<UserMemoryStats>;
}

export interface UserMemoryContextOptions {
  limit?: number;
  query?: string;
}

export const DEFAULT_USER_MEMORY_SEARCH_LIMIT = 5;

export function deriveUserMemoryKey(scope?: StorageScope): string {
  const normalized = normalizeStorageScope(scope);
  return `scope:${getStorageScopeHash(normalized)}`;
}

export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly entriesByUserKey = new Map<string, Map<string, UserMemoryEntry>>();

  deriveUserKey(scope?: StorageScope): string {
    return deriveUserMemoryKey(scope);
  }

  async search(input: UserMemorySearchInput): Promise<UserMemorySearchResult[]> {
    const entries = this.entriesByUserKey.get(input.userKey);
    if (!entries) {
      return [];
    }

    const now = nowIso();
    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const types = new Set(input.types ?? ['semantic', 'episodic']);
    const statuses = new Set(input.statuses ?? (input.includeExpired ? ['active', 'expired'] : ['active']));
    const minConfidence = input.minConfidence ?? 0;
    const candidates = [...entries.values()].filter(entry => {
      if (!types.has(entry.type)) {
        return false;
      }

      if (!statuses.has(entry.status)) {
        return false;
      }

      if (entry.confidence < minConfidence) {
        return false;
      }

      return input.includeExpired || !isExpired(entry, now);
    });
    const ranked = rankUserMemory(candidates, query)
      .slice(0, input.limit ?? DEFAULT_USER_MEMORY_SEARCH_LIMIT)
      .map(({ entry, score }) => {
        entry.lastAccessedAt = now;
        return {
          ...cloneEntry(entry),
          score
        };
      });

    return ranked;
  }

  async read(userKey: string, id: string): Promise<UserMemoryEntry | undefined> {
    const entry = this.entriesByUserKey.get(userKey)?.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  async write(userKey: string, input: UserMemoryWriteInput): Promise<UserMemoryEntry> {
    const text = normalizeMemoryText(input.text);
    if (!text) {
      throw new Error('User memory text must be non-empty');
    }

    const type = input.type ?? 'semantic';
    const entries = this.getWritableEntries(userKey);
    const contentHash = createContentHash(text);
    const existing = [...entries.values()].find(entry => entry.type === type && entry.contentHash === contentHash);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, clamp01(input.confidence ?? existing.confidence));
      existing.importance = Math.max(existing.importance, clamp01(input.importance ?? existing.importance));
      existing.reason = input.reason ?? existing.reason;
      existing.sourceRunId = input.sourceRunId ?? existing.sourceRunId;
      existing.sourceThreadId = input.sourceThreadId ?? existing.sourceThreadId;
      existing.expiresAt = input.expiresAt ?? existing.expiresAt;
      existing.tags = mergeTags(existing.tags, input.tags);
      existing.metadata = input.metadata ? cloneJsonObject(input.metadata) : existing.metadata;
      existing.status = mergeMemoryStatus(existing.status, input.status ?? existing.status);
      existing.supersededBy = input.supersededBy ?? existing.supersededBy;
      existing.updatedAt = nowIso();
      return cloneEntry(existing);
    }

    const createdAt = nowIso();
    const entry: UserMemoryEntry = {
      id: input.id ?? createMemoryId(userKey, type, contentHash),
      type,
      userKey,
      text,
      reason: input.reason,
      sourceThreadId: input.sourceThreadId,
      sourceRunId: input.sourceRunId,
      confidence: clamp01(input.confidence ?? 1),
      importance: clamp01(input.importance ?? 0.5),
      contentHash,
      status: input.status ?? 'active',
      supersededBy: input.supersededBy,
      createdAt,
      updatedAt: createdAt,
      expiresAt: input.expiresAt,
      tags: normalizeTags(input.tags),
      metadata: cloneJsonObject(input.metadata)
    };
    entries.set(entry.id, entry);
    return cloneEntry(entry);
  }

  async delete(userKey: string, id: string): Promise<boolean> {
    return this.entriesByUserKey.get(userKey)?.delete(id) ?? false;
  }

  async update(userKey: string, id: string, patch: UserMemoryUpdateInput): Promise<UserMemoryEntry | undefined> {
    const entry = this.entriesByUserKey.get(userKey)?.get(id);
    if (!entry) {
      return undefined;
    }

    if (patch.text !== undefined) {
      const nextText = normalizeMemoryText(patch.text);
      if (!nextText) {
        throw new Error('User memory text must be non-empty');
      }
      entry.text = nextText;
      entry.contentHash = createContentHash(entry.text);
    }
    if (patch.status !== undefined) {
      entry.status = patch.status;
    }
    entry.reason = patch.reason ?? entry.reason;
    entry.sourceRunId = patch.sourceRunId ?? entry.sourceRunId;
    entry.sourceThreadId = patch.sourceThreadId ?? entry.sourceThreadId;
    entry.confidence = Math.max(entry.confidence, clamp01(patch.confidence ?? entry.confidence));
    entry.importance = Math.max(entry.importance, clamp01(patch.importance ?? entry.importance));
    entry.expiresAt = patch.expiresAt ?? entry.expiresAt;
    entry.supersededBy = patch.supersededBy ?? entry.supersededBy;
    entry.tags = mergeTags(entry.tags, patch.tags);
    entry.metadata = patch.metadata ? cloneJsonObject(patch.metadata) : entry.metadata;
    entry.updatedAt = nowIso();
    return cloneEntry(entry);
  }

  async deleteAllForUser(userKey: string): Promise<number> {
    const count = this.entriesByUserKey.get(userKey)?.size ?? 0;
    this.entriesByUserKey.delete(userKey);
    return count;
  }

  async stats(userKey: string): Promise<UserMemoryStats> {
    const now = nowIso();
    const entries = [...(this.entriesByUserKey.get(userKey)?.values() ?? [])];
    return {
      total: entries.length,
      active: entries.filter(entry => entry.status === 'active' && !isExpired(entry, now)).length,
      pending: entries.filter(entry => entry.status === 'pending').length,
      expired: entries.filter(entry => entry.status === 'expired' || isExpired(entry, now)).length,
      superseded: entries.filter(entry => entry.status === 'superseded').length
    };
  }

  private getWritableEntries(userKey: string): Map<string, UserMemoryEntry> {
    const existing = this.entriesByUserKey.get(userKey);
    if (existing) {
      return existing;
    }

    const entries = new Map<string, UserMemoryEntry>();
    this.entriesByUserKey.set(userKey, entries);
    return entries;
  }
}

export async function buildUserMemoryContext(
  store: UserMemoryStore | undefined,
  userKey: string | undefined,
  messages: AgentMessage[],
  options: UserMemoryContextOptions = {}
): Promise<string | undefined> {
  if (!store || !userKey) {
    return undefined;
  }

  try {
    const query = options.query ?? extractRecentUserText(messages);
    if (!query.trim()) {
      return undefined;
    }

    const memories = await store.search({
      userKey,
      query,
      limit: options.limit ?? DEFAULT_USER_MEMORY_SEARCH_LIMIT
    });
    if (memories.length === 0) {
      return undefined;
    }

    return formatUserMemoryContext(memories);
  } catch {
    return undefined;
  }
}

function formatUserMemoryContext(memories: UserMemorySearchResult[]): string {
  const lines = [
    '## User Memory (persisted across sessions)',
    '',
    'The following facts about the user were learned from previous conversations. Use them only when relevant.',
    "If a memory conflicts with what the user just told you, trust the user's latest statement.",
    '',
    ...memories.map(memory => formatMemoryLine(memory))
  ];

  return lines.join('\n');
}

function formatMemoryLine(memory: UserMemorySearchResult): string {
  const parts = [
    `type: ${memory.type}`,
    `confidence: ${formatNumber(memory.confidence)}`,
    `updated: ${formatDate(memory.updatedAt)}`
  ];
  if (memory.sourceThreadId) {
    parts.push(`source: ${memory.sourceThreadId}`);
  }

  return `- ${memory.text} (${parts.join(', ')})`;
}

function extractRecentUserText(messages: AgentMessage[]): string {
  return messages
    .filter(message => message.role === 'user')
    .slice(-3)
    .flatMap(message => message.content)
    .filter(part => part.type === 'text')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n');
}

function rankUserMemory(entries: UserMemoryEntry[], query: string): Array<{ entry: UserMemoryEntry; score: number }> {
  const terms = tokenize(query);
  return entries
    .map(entry => {
      const textTerms = tokenize(entry.text);
      const textScore = terms.length === 0 ? 1 : calculateTermScore(textTerms, terms);
      const score = textScore * 0.7 + entry.importance * 0.2 + entry.confidence * 0.1;
      return { entry, score, textScore };
    })
    .filter(result => terms.length === 0 || result.textScore > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
    });
}

function calculateTermScore(textTerms: string[], queryTerms: string[]): number {
  const matches = queryTerms.filter(term => textTerms.some(textTerm => isTermMatch(textTerm, term))).length;
  return matches / queryTerms.length;
}

function isTermMatch(textTerm: string, queryTerm: string): boolean {
  if (textTerm === queryTerm) {
    return true;
  }

  if (queryTerm.length < 4) {
    return false;
  }

  return textTerm.startsWith(queryTerm) || queryTerm.startsWith(textTerm);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .map(term => term.trim())
    .filter(Boolean);
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function createContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function createMemoryId(userKey: string, type: UserMemoryType, contentHash: string): string {
  const typePrefix = type.slice(0, 3);
  const hash = createHash('sha256').update(`${userKey}:${type}:${contentHash}`).digest('hex').slice(0, 16);
  return `mem_${typePrefix}_${hash}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function isExpired(entry: UserMemoryEntry, now: string): boolean {
  return Boolean(entry.expiresAt && entry.expiresAt <= now);
}

function mergeTags(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  return normalizeTags([...(left ?? []), ...(right ?? [])]);
}

function mergeMemoryStatus(current: UserMemoryStatus, incoming: UserMemoryStatus): UserMemoryStatus {
  const priority: Record<UserMemoryStatus, number> = {
    active: 3,
    pending: 2,
    expired: 1,
    superseded: 0
  };

  return priority[incoming] > priority[current] ? incoming : current;
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((tags ?? []).map(tag => tag.trim()).filter(Boolean))].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function cloneEntry(entry: UserMemoryEntry): UserMemoryEntry {
  return {
    ...entry,
    tags: entry.tags ? [...entry.tags] : undefined,
    metadata: cloneJsonObject(entry.metadata)
  };
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject | undefined {
  return value ? structuredClone(value) as JsonObject : undefined;
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}
