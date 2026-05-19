import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
} from '@mido/protocol-core';

export interface SessionStore {
  saveCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
  loadCheckpoint(runId: string): Promise<RunCheckpoint | null>;
  deleteCheckpoint(runId: string): Promise<void>;
  heartbeat(runId: string): Promise<void>;
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
  saveThread(thread: ThreadSnapshot): Promise<void>;
  loadThread(threadId: string): Promise<StoredThread | null>;
}

export interface EventStoreQuery {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

export interface EventStore {
  appendEvent(event: CoreEvent): Promise<void>;
  loadEvents(query: EventStoreQuery): Promise<CoreEvent[]>;
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

export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, StoredCheckpoint>();
  private readonly ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.entries.set(checkpoint.runId, {
      checkpoint: structuredClone(checkpoint),
      expiresAt: Date.now() + this.ttlMs
    });
  }

  async loadCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const entry = this.entries.get(runId);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(runId);
      return null;
    }

    return structuredClone(entry.checkpoint);
  }

  async deleteCheckpoint(runId: string): Promise<void> {
    this.entries.delete(runId);
  }

  async heartbeat(runId: string): Promise<void> {
    const entry = this.entries.get(runId);
    if (!entry) {
      return;
    }

    entry.expiresAt = Date.now() + this.ttlMs;
    entry.checkpoint.updatedAt = nowIso();
  }
}

export class RedisSessionStore implements SessionStore {
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;

  constructor(client: RedisClientType, options: SessionStoreOptions = {}) {
    this.client = client;
    this.ttlSeconds = Math.ceil((options.ttlMs ?? 5 * 60 * 1000) / 1000);
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    await this.client.set(this.key(checkpoint.runId), JSON.stringify(checkpoint), {
      EX: this.ttlSeconds
    });
  }

  async loadCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const raw = await this.client.get(this.key(runId));
    return raw ? (JSON.parse(raw) as RunCheckpoint) : null;
  }

  async deleteCheckpoint(runId: string): Promise<void> {
    await this.client.del(this.key(runId));
  }

  async heartbeat(runId: string): Promise<void> {
    await this.client.expire(this.key(runId), this.ttlSeconds);
  }

  private key(runId: string): string {
    return `mido:run:${runId}`;
  }
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, StoredThread>();

  async saveThread(thread: ThreadSnapshot): Promise<void> {
    const existing = this.threads.get(thread.threadId);
    this.threads.set(thread.threadId, {
      ...structuredClone(thread),
      createdAt: existing?.createdAt ?? nowIso()
    });
  }

  async loadThread(threadId: string): Promise<StoredThread | null> {
    const thread = this.threads.get(threadId);
    return thread ? structuredClone(thread) : null;
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly eventsByRunId = new Map<string, CoreEvent[]>();

  async appendEvent(event: CoreEvent): Promise<void> {
    const events = this.eventsByRunId.get(event.runId) ?? [];
    events.push(structuredClone(event));
    this.eventsByRunId.set(event.runId, events);
  }

  async loadEvents(query: EventStoreQuery): Promise<CoreEvent[]> {
    const events = (this.eventsByRunId.get(query.runId) ?? [])
      .filter(event => query.afterSequence === undefined || event.sequence > query.afterSequence)
      .sort((left, right) => left.sequence - right.sequence);

    const limited = query.limit === undefined ? events : events.slice(-query.limit);
    return structuredClone(limited);
  }
}

export class FileSystemThreadStore implements ThreadStore {
  private readonly rootDir: string;

  constructor(options: FileSystemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async saveThread(thread: ThreadSnapshot): Promise<void> {
    const filePath = this.threadPath(thread.threadId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await this.loadThread(thread.threadId);
    const stored: StoredThread = {
      ...thread,
      createdAt: existing?.createdAt ?? nowIso()
    };
    await writeJsonAtomically(filePath, stored);
  }

  async loadThread(threadId: string): Promise<StoredThread | null> {
    try {
      const raw = await readFile(this.threadPath(threadId), 'utf8');
      return JSON.parse(raw) as StoredThread;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  private threadPath(threadId: string): string {
    return path.join(this.rootDir, 'threads', encodePathSegment(threadId), 'snapshot.json');
  }
}

export class FileSystemEventStore implements EventStore {
  private readonly rootDir: string;
  private readonly runThreads = new Map<string, string>();

  constructor(options: FileSystemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async appendEvent(event: CoreEvent): Promise<void> {
    const threadId = await this.getThreadIdForEvent(event);
    const filePath = this.eventPath(threadId, event.runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async loadEvents(query: EventStoreQuery): Promise<CoreEvent[]> {
    try {
      const threadId = await this.resolveThreadId(query.runId);
      if (!threadId) {
        return [];
      }

      const raw = await readFile(this.eventPath(threadId, query.runId), 'utf8');
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

  private async getThreadIdForEvent(event: CoreEvent): Promise<string> {
    if (event.type === 'RUN_STARTED' && event.threadId) {
      this.runThreads.set(event.runId, event.threadId);
      return event.threadId;
    }

    const threadId = await this.resolveThreadId(event.runId);
    if (threadId) {
      return threadId;
    }

    throw new Error(`Cannot persist event for run "${event.runId}" before its thread id is known`);
  }

  private async resolveThreadId(runId: string): Promise<string | undefined> {
    const cached = this.runThreads.get(runId);
    if (cached) {
      return cached;
    }

    const discovered = await this.findThreadIdForRun(runId);
    if (discovered) {
      this.runThreads.set(runId, discovered);
    }

    return discovered;
  }

  private async findThreadIdForRun(runId: string): Promise<string | undefined> {
    try {
      const threadEntries = await readdir(path.join(this.rootDir, 'threads'), { withFileTypes: true });
      for (const entry of threadEntries) {
        if (!entry.isDirectory()) {
          continue;
        }

        try {
          await readFile(this.eventPath(decodePathSegment(entry.name), runId), 'utf8');
          return decodePathSegment(entry.name);
        } catch (error) {
          if (!isMissingFileError(error)) {
            throw error;
          }
        }
      }

      return undefined;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private eventPath(threadId: string, runId: string): string {
    return path.join(this.rootDir, 'threads', encodePathSegment(threadId), 'runs', encodePathSegment(runId), 'events.jsonl');
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

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
