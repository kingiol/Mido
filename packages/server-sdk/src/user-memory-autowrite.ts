import type { AgentMessage, JsonObject, ToolResultPart } from '@mido/protocol-core';

import type {
  UserMemoryEntry,
  UserMemoryStatus,
  UserMemoryStore,
  UserMemoryType
} from './user-memory.js';

export type UserMemoryCandidateSourceKind =
  | 'user_statement'
  | 'user_correction'
  | 'tool_result'
  | 'assistant_summary';

export interface UserMemoryCandidate {
  type: UserMemoryType;
  sourceKind: UserMemoryCandidateSourceKind;
  text: string;
  confidence: number;
  importance: number;
  reason?: string;
  sourceThreadId?: string;
  sourceRunId?: string;
  metadata?: JsonObject;
}

export interface UserMemoryExtractionOptions {
  since?: string;
  sourceMessageIds?: ReadonlySet<string>;
  sourceRunId?: string;
  sourceThreadId?: string;
  limit?: number;
}

export interface UserMemoryCandidateEvaluationContext {
  userKey: string;
  existingMemories?: UserMemoryEntry[];
}

export interface UserMemoryAutowriteDecision {
  action: 'write' | 'skip';
  type: UserMemoryType;
  status: UserMemoryStatus;
  sourceKind: UserMemoryCandidateSourceKind;
  text: string;
  confidence: number;
  importance: number;
  reason?: string;
  supersedeTargetIds: string[];
}

export interface ApplyUserMemoryAutowritesOptions {
  existingMemorySearchLimit?: number;
}

const DEFAULT_AUTOWRITE_CANDIDATE_LIMIT = 8;
const DEFAULT_EXISTING_MEMORY_SEARCH_LIMIT = 20;
const ALL_MEMORY_STATUSES: UserMemoryStatus[] = ['active', 'pending', 'superseded', 'expired'];
const MIN_WRITE_CONFIDENCE = 0.2;
const ACTIVE_CONFIDENCE_THRESHOLD = 0.8;
const ACTIVE_IMPORTANCE_THRESHOLD = 0.6;

const TOPIC_STOP_WORDS = new Set([
  'about',
  'actually',
  'after',
  'also',
  'and',
  'changed',
  'does',
  'from',
  'have',
  'into',
  'longer',
  'moved',
  'not',
  'now',
  'onto',
  'prefer',
  'prefers',
  'switched',
  'that',
  'the',
  'their',
  'this',
  'user',
  'uses',
  'using',
  'with'
]);

export function extractUserMemoryCandidates(
  messages: AgentMessage[],
  options: UserMemoryExtractionOptions = {}
): UserMemoryCandidate[] {
  const bestCandidatesByKey = new Map<string, UserMemoryCandidate>();
  const candidates: UserMemoryCandidate[] = [];
  const limit = options.limit ?? DEFAULT_AUTOWRITE_CANDIDATE_LIMIT;

  for (const message of messages) {
    if (candidates.length >= limit) {
      break;
    }

    if (!shouldInspectMessage(message, options)) {
      continue;
    }

    const extracted = extractCandidatesFromMessage(message, options);
    for (const candidate of extracted) {
      const key = `${candidate.type}:${candidate.text.toLowerCase()}`;
      const existing = bestCandidatesByKey.get(key);
      if (!existing || isBetterCandidate(candidate, existing)) {
        bestCandidatesByKey.set(key, candidate);
      }
    }
  }

  for (const candidate of bestCandidatesByKey.values()) {
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

export function evaluateUserMemoryCandidate(
  candidate: UserMemoryCandidate,
  context: UserMemoryCandidateEvaluationContext
): UserMemoryAutowriteDecision {
  const text = normalizeMemoryCandidateText(candidate.text);
  const confidence = clamp01(candidate.confidence);
  const importance = clamp01(candidate.importance);

  if (!text || confidence < MIN_WRITE_CONFIDENCE) {
    return {
      action: 'skip',
      type: candidate.type,
      status: 'pending',
      sourceKind: candidate.sourceKind,
      text,
      confidence,
      importance,
      reason: candidate.reason,
      supersedeTargetIds: []
    };
  }

  const status = chooseWriteStatus(candidate, confidence, importance);
  const supersedeTargetIds =
    candidate.sourceKind === 'user_correction'
      ? findSupersedeTargetIds(text, candidate.type, context.existingMemories ?? [])
      : [];

  return {
    action: 'write',
    type: candidate.type,
    status,
    sourceKind: candidate.sourceKind,
    text,
    confidence,
    importance,
    reason: candidate.reason,
    supersedeTargetIds
  };
}

export async function applyUserMemoryAutowrites(
  store: UserMemoryStore,
  userKey: string,
  candidates: UserMemoryCandidate[],
  options: ApplyUserMemoryAutowritesOptions = {}
): Promise<UserMemoryEntry[]> {
  const written: UserMemoryEntry[] = [];

  for (const candidate of candidates) {
    const existingMemories = await searchExistingMemories(store, userKey, candidate, options);
    const decision = evaluateUserMemoryCandidate(candidate, {
      userKey,
      existingMemories
    });

    if (decision.action === 'skip') {
      continue;
    }

    const entry = await store.write(userKey, {
      type: decision.type,
      status: decision.status,
      text: decision.text,
      reason: candidate.reason ?? decision.reason,
      sourceRunId: candidate.sourceRunId,
      sourceThreadId: candidate.sourceThreadId,
      confidence: decision.confidence,
      importance: decision.importance,
      tags: ['autowrite', candidate.sourceKind],
      metadata: {
        ...(candidate.metadata ?? {}),
        sourceKind: candidate.sourceKind,
        autonomousWrite: true
      }
    });

    await supersedeMemories(store, userKey, entry.id, decision.supersedeTargetIds);
    written.push(entry);
  }

  return written;
}

function shouldInspectMessage(message: AgentMessage, options: UserMemoryExtractionOptions): boolean {
  const hasScopedSource = Boolean(options.since || options.sourceMessageIds?.size);
  if (!hasScopedSource) {
    return true;
  }

  if (options.sourceMessageIds?.has(message.id)) {
    return true;
  }

  return Boolean(options.since && message.createdAt >= options.since);
}

function extractCandidatesFromMessage(message: AgentMessage, options: UserMemoryExtractionOptions): UserMemoryCandidate[] {
  if (message.role === 'user') {
    return message.content
      .filter(part => part.type === 'text')
      .flatMap(part => extractUserTextCandidates(part.text, options));
  }

  if (message.role === 'tool') {
    return message.content.flatMap(part => {
      if (part.type !== 'tool-result') {
        return [];
      }

      const candidate = createToolResultCandidate(part, options);
      return candidate ? [candidate] : [];
    });
  }

  return [];
}

function extractUserTextCandidates(text: string, options: UserMemoryExtractionOptions): UserMemoryCandidate[] {
  return splitSentences(text)
    .map(sentence => createUserStatementCandidate(sentence, options))
    .filter((candidate): candidate is UserMemoryCandidate => Boolean(candidate));
}

function createUserStatementCandidate(
  sentence: string,
  options: UserMemoryExtractionOptions
): UserMemoryCandidate | undefined {
  const correction = matchFirstPersonPattern(sentence, [
    { regex: /^actually,\s*I (?:have )?(?:changed|moved|switched) to\s+(.+?)([.!?])?$/i, prefix: 'User switched to ' },
    { regex: /^I (?:have )?(?:changed|moved|switched) to\s+(.+?)([.!?])?$/i, prefix: 'User switched to ' },
    { regex: /^I no longer use\s+(.+?)([.!?])?$/i, prefix: 'User no longer uses ' }
  ]);
  if (correction) {
    return {
      type: 'semantic',
      sourceKind: 'user_correction',
      text: correction,
      confidence: 0.96,
      importance: 0.9,
      reason: 'user correction',
      sourceRunId: options.sourceRunId,
      sourceThreadId: options.sourceThreadId
    };
  }

  const preference = matchFirstPersonPattern(sentence, [
    { regex: /^I prefer\s+(.+?)([.!?])?$/i, prefix: 'User prefers ' },
    { regex: /^I usually prefer\s+(.+?)([.!?])?$/i, prefix: 'User usually prefers ' }
  ]);
  if (preference) {
    return {
      type: 'semantic',
      sourceKind: 'user_statement',
      text: preference,
      confidence: 0.93,
      importance: 0.85,
      reason: 'preference stated by user',
      sourceRunId: options.sourceRunId,
      sourceThreadId: options.sourceThreadId
    };
  }

  const stableFact = matchFirstPersonPattern(sentence, [
    { regex: /^I use\s+(.+?)([.!?])?$/i, prefix: 'User uses ' },
    { regex: /^I work with\s+(.+?)([.!?])?$/i, prefix: 'User works with ' },
    { regex: /^I'm using\s+(.+?)([.!?])?$/i, prefix: 'User is using ' }
  ]);
  if (stableFact) {
    return {
      type: 'semantic',
      sourceKind: 'user_statement',
      text: stableFact,
      confidence: 0.88,
      importance: 0.75,
      reason: 'stable fact stated by user',
      sourceRunId: options.sourceRunId,
      sourceThreadId: options.sourceThreadId
    };
  }

  return undefined;
}

function createToolResultCandidate(
  part: ToolResultPart,
  options: UserMemoryExtractionOptions
): UserMemoryCandidate | undefined {
  if (part.isError) {
    return undefined;
  }

  const text = summarizeToolResult(part);
  if (!text) {
    return undefined;
  }

  return {
    type: 'episodic',
    sourceKind: 'tool_result',
    text,
    confidence: 0.62,
    importance: 0.5,
    reason: 'tool result',
    sourceRunId: options.sourceRunId,
    sourceThreadId: options.sourceThreadId,
    metadata: createToolResultMetadata(part)
  };
}

function createToolResultMetadata(part: ToolResultPart): JsonObject {
  return {
    toolCallId: part.toolCallId,
    ...(part.toolId ? { toolId: part.toolId } : {}),
    toolName: part.toolName
  };
}

function matchFirstPersonPattern(
  sentence: string,
  patterns: Array<{ regex: RegExp; prefix: string }>
): string | undefined {
  for (const pattern of patterns) {
    const match = sentence.match(pattern.regex);
    if (!match) {
      continue;
    }

    return normalizeMemoryCandidateText(`${pattern.prefix}${match[1]?.trim() ?? ''}${match[2] ?? '.'}`);
  }

  return undefined;
}

function summarizeToolResult(part: ToolResultPart): string | undefined {
  if (typeof part.output !== 'object' || part.output === null || Array.isArray(part.output)) {
    return normalizeMemoryCandidateText(`${part.toolName} returned: ${String(part.output)}`);
  }

  const output = part.output as JsonObject;
  const path = typeof output.path === 'string' ? output.path : undefined;
  const summary = typeof output.summary === 'string' ? output.summary : undefined;
  const message = typeof output.message === 'string' ? output.message : undefined;
  const id = typeof output.id === 'string' ? output.id : undefined;

  if (path && summary) {
    return normalizeMemoryCandidateText(`${part.toolName} returned path ${path}: ${summary}`);
  }

  if (summary) {
    return normalizeMemoryCandidateText(`${part.toolName} returned summary: ${summary}`);
  }

  if (message) {
    return normalizeMemoryCandidateText(`${part.toolName} returned message: ${message}`);
  }

  if (id) {
    return normalizeMemoryCandidateText(`${part.toolName} returned id: ${id}`);
  }

  return undefined;
}

function chooseWriteStatus(
  candidate: UserMemoryCandidate,
  confidence: number,
  importance: number
): UserMemoryStatus {
  if (candidate.sourceKind === 'tool_result' || candidate.sourceKind === 'assistant_summary') {
    return 'pending';
  }

  if (hasSensitiveMarker(candidate.text)) {
    return 'pending';
  }

  return confidence >= ACTIVE_CONFIDENCE_THRESHOLD && importance >= ACTIVE_IMPORTANCE_THRESHOLD ? 'active' : 'pending';
}

async function searchExistingMemories(
  store: UserMemoryStore,
  userKey: string,
  candidate: UserMemoryCandidate,
  options: ApplyUserMemoryAutowritesOptions
): Promise<UserMemoryEntry[]> {
  const text = normalizeMemoryCandidateText(candidate.text);
  if (!text) {
    return [];
  }

  try {
    return await store.search({
      userKey,
      query: text,
      types: [candidate.type],
      statuses: ALL_MEMORY_STATUSES,
      includeExpired: true,
      limit: options.existingMemorySearchLimit ?? DEFAULT_EXISTING_MEMORY_SEARCH_LIMIT
    });
  } catch {
    return [];
  }
}

async function supersedeMemories(
  store: UserMemoryStore,
  userKey: string,
  supersededBy: string,
  targetIds: string[]
): Promise<void> {
  if (!store.update || targetIds.length === 0) {
    return;
  }

  for (const targetId of targetIds) {
    if (targetId === supersededBy) {
      continue;
    }

    await store.update(userKey, targetId, {
      status: 'superseded',
      supersededBy
    });
  }
}

function findSupersedeTargetIds(
  candidateText: string,
  candidateType: UserMemoryType,
  memories: UserMemoryEntry[]
): string[] {
  return memories
    .filter(memory => memory.type === candidateType)
    .filter(memory => memory.status === 'active' || memory.status === 'pending')
    .filter(memory => memory.text !== candidateText)
    .map(memory => ({
      memory,
      score: calculateTopicOverlap(candidateText, memory.text)
    }))
    .filter(result => result.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.memory.updatedAt.localeCompare(left.memory.updatedAt);
    })
    .map(result => result.memory.id);
}

function calculateTopicOverlap(left: string, right: string): number {
  const leftTerms = new Set(extractTopicTerms(left));
  const rightTerms = extractTopicTerms(right);
  if (leftTerms.size === 0 || rightTerms.length === 0) {
    return 0;
  }

  const matches = rightTerms.filter(term => leftTerms.has(term)).length;
  return matches / Math.max(leftTerms.size, rightTerms.length);
}

function extractTopicTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .map(term => normalizeTopicTerm(term.trim()))
    .filter(term => term.length >= 4 && !TOPIC_STOP_WORDS.has(term));
}

function normalizeTopicTerm(term: string): string {
  return term
    .replace(/ments?$/u, '')
    .replace(/ings?$/u, '')
    .replace(/ers?$/u, '')
    .replace(/s$/u, '');
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '\n')
    .match(/[^.!?\n]+[.!?]?/g)
    ?.map(sentence => sentence.trim().replace(/\s+/g, ' '))
    .filter(Boolean) ?? [];
}

function normalizeMemoryCandidateText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }

  return /[.!?]$/u.test(normalized) ? normalized : `${normalized}.`;
}

function isBetterCandidate(candidate: UserMemoryCandidate, existing: UserMemoryCandidate): boolean {
  const leftPriority = getSourceKindPriority(candidate.sourceKind);
  const rightPriority = getSourceKindPriority(existing.sourceKind);
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority;
  }

  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence;
  }

  if (candidate.importance !== existing.importance) {
    return candidate.importance > existing.importance;
  }

  return false;
}

function getSourceKindPriority(sourceKind: UserMemoryCandidateSourceKind): number {
  switch (sourceKind) {
    case 'user_correction':
      return 3;
    case 'user_statement':
      return 2;
    case 'assistant_summary':
      return 1;
    case 'tool_result':
      return 0;
  }
}

function hasSensitiveMarker(text: string): boolean {
  return Boolean(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text) ||
      /\b(?:api[_-]?key|secret|token|password|credit card|ssn)\b/iu.test(text) ||
      /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/u.test(text)
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
