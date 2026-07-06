import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RedisClientType } from 'redis';

import {
  nowIso,
  stableStringify,
  type AgentMessage,
  type CoreEvent,
  type JsonObject,
  type RunCheckpoint,
  type ToolResultEnvelope
} from '@mido-agent/protocol-core';

export interface StorageScope {
  segments: string[];
}

export const DEFAULT_STORAGE_SCOPE: StorageScope = { segments: ['default'] };

export function normalizeStorageScope(scope?: StorageScope): StorageScope {
  if (!scope) {
    return { segments: [...DEFAULT_STORAGE_SCOPE.segments] };
  }

  if (!Array.isArray(scope.segments) || scope.segments.length === 0) {
    throw new Error('Storage scope must include at least one segment');
  }

  const segments = scope.segments.map((segment, index) => {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new Error(`Storage scope segment at index ${index} must be a non-empty string`);
    }

    return segment;
  });

  return { segments };
}

export function getStorageScopeHash(scope?: StorageScope): string {
  const normalized = normalizeStorageScope(scope);
  return createHash('sha256').update(JSON.stringify(normalized.segments)).digest('hex').slice(0, 32);
}

export function getStorageScopeId(scope?: StorageScope): string {
  return `scp_${getStorageScopeHash(scope)}`;
}

export interface SessionStore {
  saveCheckpoint(scope: StorageScope, checkpoint: RunCheckpoint): Promise<void>;
  loadCheckpoint(scope: StorageScope, runId: string): Promise<RunCheckpoint | null>;
  deleteCheckpoint(scope: StorageScope, runId: string): Promise<void>;
  heartbeat(scope: StorageScope, runId: string): Promise<void>;
}

export interface ThreadSnapshot {
  threadId: string;
  messages: AgentMessage[];
  messageIndex?: Record<string, ThreadMessageIndexEntry>;
  lifecycle?: ThreadLifecycle;
  state: JsonObject;
  metadata?: JsonObject;
  updatedAt: string;
}

export interface ThreadLifecycle {
  userState: ThreadUserState;
  contextState: ThreadContextState;
}

export type ThreadUserState =
  | { state: 'active' }
  | {
      state: 'archived';
      archivedAt: string;
      archivedBy?: string;
    };

export type ThreadContextState =
  | { state: 'ok' }
  | {
      state: 'frozen';
      reason: 'context_budget_exhausted';
      frozenAt: string;
      frozenByRunId: string;
      estimatedInputTokens: number;
      maxInputTokens: number;
      lastSummaryMessageId?: string;
    };

export interface ThreadMessageIndexEntry {
  createdByRunId?: string;
  triggeredRunId?: string;
}

export interface StoredThread extends ThreadSnapshot {
  createdAt: string;
}

export interface ThreadStore {
  saveThread(scope: StorageScope, thread: ThreadSnapshot): Promise<void>;
  loadThread(scope: StorageScope, threadId: string): Promise<StoredThread | null>;
}

export interface EventStoreQuery {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

export interface EventStore {
  appendEvent(scope: StorageScope, event: CoreEvent): Promise<void>;
  loadEvents(scope: StorageScope, query: EventStoreQuery): Promise<CoreEvent[]>;
}

export interface SessionStoreOptions {
  ttlMs?: number;
}

export interface FileSystemStoreOptions {
  rootDir: string;
}

interface StoredCheckpoint {
  checkpoint: RunCheckpoint;
  expiresAt: number;
}

interface RunIndexEntry {
  runId: string;
  threadId: string;
  createdAt: string;
}

interface ScopeMetadata {
  scopeId: string;
  scopeHash: string;
  createdAt: string;
}

export class InMemorySessionStore implements SessionStore {
  private readonly entriesByScope = new Map<string, Map<string, StoredCheckpoint>>();
  private readonly ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  }

  async saveCheckpoint(scope: StorageScope, checkpoint: RunCheckpoint): Promise<void>;
  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
  async saveCheckpoint(scopeOrCheckpoint: StorageScope | RunCheckpoint, maybeCheckpoint?: RunCheckpoint): Promise<void> {
    const { scope, checkpoint } = resolveScopeAndValue(scopeOrCheckpoint, maybeCheckpoint);
    this.getEntries(scope).set(checkpoint.runId, {
      checkpoint: structuredClone(checkpoint),
      expiresAt: Date.now() + this.ttlMs
    });
  }

  async loadCheckpoint(scope: StorageScope, runId: string): Promise<RunCheckpoint | null>;
  async loadCheckpoint(runId: string): Promise<RunCheckpoint | null>;
  async loadCheckpoint(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<RunCheckpoint | null> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    const entries = this.getEntries(scope);
    const entry = entries.get(runId);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      entries.delete(runId);
      return null;
    }

    return structuredClone(entry.checkpoint);
  }

  async deleteCheckpoint(scope: StorageScope, runId: string): Promise<void>;
  async deleteCheckpoint(runId: string): Promise<void>;
  async deleteCheckpoint(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<void> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    this.getEntries(scope).delete(runId);
  }

  async heartbeat(scope: StorageScope, runId: string): Promise<void>;
  async heartbeat(runId: string): Promise<void>;
  async heartbeat(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<void> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    const entry = this.getEntries(scope).get(runId);
    if (!entry) {
      return;
    }

    entry.expiresAt = Date.now() + this.ttlMs;
    entry.checkpoint.updatedAt = nowIso();
  }

  private getEntries(scope: StorageScope): Map<string, StoredCheckpoint> {
    const scopeKey = getStorageScopeId(scope);
    const existing = this.entriesByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const created = new Map<string, StoredCheckpoint>();
    this.entriesByScope.set(scopeKey, created);
    return created;
  }
}

export class RedisSessionStore implements SessionStore {
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;

  constructor(client: RedisClientType, options: SessionStoreOptions = {}) {
    this.client = client;
    this.ttlSeconds = Math.ceil((options.ttlMs ?? 5 * 60 * 1000) / 1000);
  }

  async saveCheckpoint(scope: StorageScope, checkpoint: RunCheckpoint): Promise<void>;
  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
  async saveCheckpoint(scopeOrCheckpoint: StorageScope | RunCheckpoint, maybeCheckpoint?: RunCheckpoint): Promise<void> {
    const { scope, checkpoint } = resolveScopeAndValue(scopeOrCheckpoint, maybeCheckpoint);
    await this.client.set(this.key(scope, checkpoint.runId), JSON.stringify(checkpoint), {
      EX: this.ttlSeconds
    });
  }

  async loadCheckpoint(scope: StorageScope, runId: string): Promise<RunCheckpoint | null>;
  async loadCheckpoint(runId: string): Promise<RunCheckpoint | null>;
  async loadCheckpoint(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<RunCheckpoint | null> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    const raw = await this.client.get(this.key(scope, runId));
    return raw ? (JSON.parse(raw) as RunCheckpoint) : null;
  }

  async deleteCheckpoint(scope: StorageScope, runId: string): Promise<void>;
  async deleteCheckpoint(runId: string): Promise<void>;
  async deleteCheckpoint(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<void> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    await this.client.del(this.key(scope, runId));
  }

  async heartbeat(scope: StorageScope, runId: string): Promise<void>;
  async heartbeat(runId: string): Promise<void>;
  async heartbeat(scopeOrRunId: StorageScope | string, maybeRunId?: string): Promise<void> {
    const { scope, runId } = resolveScopeAndRunId(scopeOrRunId, maybeRunId);
    await this.client.expire(this.key(scope, runId), this.ttlSeconds);
  }

  private key(scope: StorageScope, runId: string): string {
    return `mido:scope:${getStorageScopeHash(scope)}:session:${runId}`;
  }
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly threadsByScope = new Map<string, Map<string, StoredThread>>();

  async saveThread(scope: StorageScope, thread: ThreadSnapshot): Promise<void>;
  async saveThread(thread: ThreadSnapshot): Promise<void>;
  async saveThread(scopeOrThread: StorageScope | ThreadSnapshot, maybeThread?: ThreadSnapshot): Promise<void> {
    const { scope, value: thread } = resolveScopeAndNamedValue(scopeOrThread, maybeThread);
    const threads = this.getThreads(scope);
    const existing = threads.get(thread.threadId);
    threads.set(thread.threadId, {
      ...structuredClone(thread),
      createdAt: existing?.createdAt ?? nowIso()
    });
  }

  async loadThread(scope: StorageScope, threadId: string): Promise<StoredThread | null>;
  async loadThread(threadId: string): Promise<StoredThread | null>;
  async loadThread(scopeOrThreadId: StorageScope | string, maybeThreadId?: string): Promise<StoredThread | null> {
    const { scope, id: threadId } = resolveScopeAndId(scopeOrThreadId, maybeThreadId);
    const thread = this.getThreads(scope).get(threadId);
    return thread ? structuredClone(thread) : null;
  }

  private getThreads(scope: StorageScope): Map<string, StoredThread> {
    const scopeKey = getStorageScopeId(scope);
    const existing = this.threadsByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const created = new Map<string, StoredThread>();
    this.threadsByScope.set(scopeKey, created);
    return created;
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly eventsByScope = new Map<string, Map<string, CoreEvent[]>>();

  async appendEvent(scope: StorageScope, event: CoreEvent): Promise<void>;
  async appendEvent(event: CoreEvent): Promise<void>;
  async appendEvent(scopeOrEvent: StorageScope | CoreEvent, maybeEvent?: CoreEvent): Promise<void> {
    const { scope, value: event } = resolveScopeAndNamedValue(scopeOrEvent, maybeEvent);
    const eventsByRunId = this.getEventsByRunId(scope);
    const events = eventsByRunId.get(event.runId) ?? [];
    events.push(structuredClone(event));
    eventsByRunId.set(event.runId, events);
  }

  async loadEvents(scope: StorageScope, query: EventStoreQuery): Promise<CoreEvent[]>;
  async loadEvents(query: EventStoreQuery): Promise<CoreEvent[]>;
  async loadEvents(scopeOrQuery: StorageScope | EventStoreQuery, maybeQuery?: EventStoreQuery): Promise<CoreEvent[]> {
    const { scope, value: query } = resolveScopeAndNamedValue(scopeOrQuery, maybeQuery);
    const events = (this.getEventsByRunId(scope).get(query.runId) ?? [])
      .filter(event => query.afterSequence === undefined || event.sequence > query.afterSequence)
      .sort((left, right) => left.sequence - right.sequence);

    const limited = query.limit === undefined ? events : events.slice(-query.limit);
    return structuredClone(limited);
  }

  private getEventsByRunId(scope: StorageScope): Map<string, CoreEvent[]> {
    const scopeKey = getStorageScopeId(scope);
    const existing = this.eventsByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const created = new Map<string, CoreEvent[]>();
    this.eventsByScope.set(scopeKey, created);
    return created;
  }
}

export class FileSystemThreadStore implements ThreadStore {
  private readonly rootDir: string;

  constructor(options: FileSystemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async saveThread(scope: StorageScope, thread: ThreadSnapshot): Promise<void>;
  async saveThread(thread: ThreadSnapshot): Promise<void>;
  async saveThread(scopeOrThread: StorageScope | ThreadSnapshot, maybeThread?: ThreadSnapshot): Promise<void> {
    const { scope, value: thread } = resolveScopeAndNamedValue(scopeOrThread, maybeThread);
    await ensureScopeMetadata(this.rootDir, scope);
    const filePath = this.threadPath(scope, thread.threadId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await this.loadThread(scope, thread.threadId);
    const stored: StoredThread = {
      ...thread,
      createdAt: existing?.createdAt ?? nowIso()
    };
    await writeJsonAtomically(filePath, stored);
  }

  async loadThread(scope: StorageScope, threadId: string): Promise<StoredThread | null>;
  async loadThread(threadId: string): Promise<StoredThread | null>;
  async loadThread(scopeOrThreadId: StorageScope | string, maybeThreadId?: string): Promise<StoredThread | null> {
    const { scope, id: threadId } = resolveScopeAndId(scopeOrThreadId, maybeThreadId);
    try {
      const raw = await readFile(this.threadPath(scope, threadId), 'utf8');
      return JSON.parse(raw) as StoredThread;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  private threadPath(scope: StorageScope, threadId: string): string {
    return path.join(getScopeRoot(this.rootDir, scope), 'threads', encodePathSegment(threadId), 'snapshot.json');
  }
}

export class FileSystemEventStore implements EventStore {
  private readonly rootDir: string;
  private readonly runThreads = new Map<string, string>();

  constructor(options: FileSystemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async appendEvent(scope: StorageScope, event: CoreEvent): Promise<void>;
  async appendEvent(event: CoreEvent): Promise<void>;
  async appendEvent(scopeOrEvent: StorageScope | CoreEvent, maybeEvent?: CoreEvent): Promise<void> {
    const { scope, value: event } = resolveScopeAndNamedValue(scopeOrEvent, maybeEvent);
    await ensureScopeMetadata(this.rootDir, scope);
    const threadId = await this.getThreadIdForEvent(scope, event);
    const filePath = this.eventPath(scope, threadId, event.runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async loadEvents(scope: StorageScope, query: EventStoreQuery): Promise<CoreEvent[]>;
  async loadEvents(query: EventStoreQuery): Promise<CoreEvent[]>;
  async loadEvents(scopeOrQuery: StorageScope | EventStoreQuery, maybeQuery?: EventStoreQuery): Promise<CoreEvent[]> {
    const { scope, value: query } = resolveScopeAndNamedValue(scopeOrQuery, maybeQuery);
    try {
      const threadId = await this.resolveThreadId(scope, query.runId);
      if (!threadId) {
        return [];
      }

      const raw = await readFile(this.eventPath(scope, threadId, query.runId), 'utf8');
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as CoreEvent)
        .filter(event => query.afterSequence === undefined || event.sequence > query.afterSequence)
        .sort((left, right) => left.sequence - right.sequence);

      return query.limit === undefined ? events : events.slice(-query.limit);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }
  }

  private async getThreadIdForEvent(scope: StorageScope, event: CoreEvent): Promise<string> {
    if (event.type === 'RUN_STARTED' && event.threadId) {
      this.runThreads.set(this.runThreadKey(scope, event.runId), event.threadId);
      await this.writeRunIndex(scope, event.runId, event.threadId);
      return event.threadId;
    }

    const threadId = await this.resolveThreadId(scope, event.runId);
    if (threadId) {
      return threadId;
    }

    throw new Error(`Cannot persist event for run "${event.runId}" before its thread id is known`);
  }

  private async resolveThreadId(scope: StorageScope, runId: string): Promise<string | undefined> {
    const cached = this.runThreads.get(this.runThreadKey(scope, runId));
    if (cached) {
      return cached;
    }

    try {
      const raw = await readFile(this.runIndexPath(scope, runId), 'utf8');
      const index = JSON.parse(raw) as RunIndexEntry;
      this.runThreads.set(this.runThreadKey(scope, runId), index.threadId);
      return index.threadId;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private async writeRunIndex(scope: StorageScope, runId: string, threadId: string): Promise<void> {
    const filePath = this.runIndexPath(scope, runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readJsonIfExists<RunIndexEntry>(filePath);
    await writeJsonAtomically(filePath, {
      runId,
      threadId,
      createdAt: existing?.createdAt ?? nowIso()
    } satisfies RunIndexEntry);
  }

  private runIndexPath(scope: StorageScope, runId: string): string {
    return path.join(getScopeRoot(this.rootDir, scope), 'run-index', `${encodePathSegment(runId)}.json`);
  }

  private eventPath(scope: StorageScope, threadId: string, runId: string): string {
    return path.join(
      getScopeRoot(this.rootDir, scope),
      'threads',
      encodePathSegment(threadId),
      'runs',
      encodePathSegment(runId),
      'events.jsonl'
    );
  }

  private runThreadKey(scope: StorageScope, runId: string): string {
    return `${getStorageScopeId(scope)}:${runId}`;
  }
}

export function isDuplicateToolResult(existing: ToolResultEnvelope[], candidate: ToolResultEnvelope): boolean {
  return existing.some(
    result =>
      result.toolCallId === candidate.toolCallId &&
      stableStringify(result.output) === stableStringify(candidate.output) &&
      Boolean(result.isError) === Boolean(candidate.isError)
  );
}

function resolveScopeAndValue<T>(scopeOrValue: StorageScope | T, maybeValue?: T): { scope: StorageScope; checkpoint: T } {
  if (maybeValue !== undefined) {
    return {
      scope: normalizeStorageScope(scopeOrValue as StorageScope),
      checkpoint: maybeValue
    };
  }

  return {
    scope: normalizeStorageScope(),
    checkpoint: scopeOrValue as T
  };
}

function resolveScopeAndNamedValue<T>(scopeOrValue: StorageScope | T, maybeValue?: T): { scope: StorageScope; value: T } {
  if (maybeValue !== undefined) {
    return {
      scope: normalizeStorageScope(scopeOrValue as StorageScope),
      value: maybeValue
    };
  }

  return {
    scope: normalizeStorageScope(),
    value: scopeOrValue as T
  };
}

function resolveScopeAndRunId(scopeOrRunId: StorageScope | string, maybeRunId?: string): { scope: StorageScope; runId: string } {
  if (maybeRunId !== undefined) {
    return {
      scope: normalizeStorageScope(scopeOrRunId as StorageScope),
      runId: maybeRunId
    };
  }

  return {
    scope: normalizeStorageScope(),
    runId: scopeOrRunId as string
  };
}

function resolveScopeAndId(scopeOrId: StorageScope | string, maybeId?: string): { scope: StorageScope; id: string } {
  if (maybeId !== undefined) {
    return {
      scope: normalizeStorageScope(scopeOrId as StorageScope),
      id: maybeId
    };
  }

  return {
    scope: normalizeStorageScope(),
    id: scopeOrId as string
  };
}

async function ensureScopeMetadata(rootDir: string, scope: StorageScope): Promise<void> {
  const normalized = normalizeStorageScope(scope);
  const scopeRoot = getScopeRoot(rootDir, normalized);
  await mkdir(scopeRoot, { recursive: true });
  const filePath = path.join(scopeRoot, 'scope.json');
  const existing = await readJsonIfExists<ScopeMetadata>(filePath);
  if (existing) {
    return;
  }

  await writeJsonAtomically(filePath, {
    scopeId: getStorageScopeId(normalized),
    scopeHash: getStorageScopeHash(normalized),
    createdAt: nowIso()
  } satisfies ScopeMetadata);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function getScopeRoot(rootDir: string, scope: StorageScope): string {
  return path.join(rootDir, 'scopes', getStorageScopeId(scope));
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
