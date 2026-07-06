import { stableStringify, type AgentMessage, type RunContextBudget, type ToolDefinition } from '@mido-agent/protocol-core';

export interface ContextBudgetInput {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  requestBudget?: RunContextBudget;
}

export interface ResolvedContextBudget {
  contextWindowTokens: number;
  reserveOutputTokens: number;
  maxInputTokens: number;
  triggerTokens: number;
  targetTokens: number;
}

export type SummaryTriggerDecision =
  | { shouldCreate: true }
  | {
      shouldCreate: false;
      reason:
        | 'missing_context_window'
        | 'under_budget'
        | 'missing_thread_store'
        | 'missing_thread_id'
        | 'resume_run'
        | 'pending_tool_results'
        | 'not_enough_messages';
    };

export function resolveRunContextBudget(input: ContextBudgetInput): ResolvedContextBudget | undefined {
  if (!input.contextWindowTokens || input.contextWindowTokens <= 0) {
    return undefined;
  }

  const reserveOutputTokens =
    input.requestBudget?.reserveOutputTokens ??
    input.maxOutputTokens ??
    Math.min(4096, Math.floor(input.contextWindowTokens * 0.2));
  const maxInputTokens =
    input.requestBudget?.maxInputTokens ??
    Math.floor((input.contextWindowTokens - reserveOutputTokens) * 0.95);
  const triggerRatio = input.requestBudget?.triggerRatio ?? 0.85;
  const targetRatio = input.requestBudget?.targetRatio ?? 0.55;

  return {
    contextWindowTokens: input.contextWindowTokens,
    reserveOutputTokens,
    maxInputTokens,
    triggerTokens: Math.floor(maxInputTokens * triggerRatio),
    targetTokens: Math.floor(maxInputTokens * targetRatio)
  };
}

export function shouldCreateSummaryMessage(input: {
  estimatedInputTokens: number;
  selectedMessageCount: number;
  hasThreadStore: boolean;
  hasThreadId: boolean;
  isResume: boolean;
  hasPendingToolResults: boolean;
  budget: ResolvedContextBudget | undefined;
}): SummaryTriggerDecision {
  if (!input.budget) {
    return { shouldCreate: false, reason: 'missing_context_window' };
  }

  if (input.estimatedInputTokens <= input.budget.triggerTokens) {
    return { shouldCreate: false, reason: 'under_budget' };
  }

  if (!input.hasThreadStore) {
    return { shouldCreate: false, reason: 'missing_thread_store' };
  }

  if (!input.hasThreadId) {
    return { shouldCreate: false, reason: 'missing_thread_id' };
  }

  if (input.isResume) {
    return { shouldCreate: false, reason: 'resume_run' };
  }

  if (input.hasPendingToolResults) {
    return { shouldCreate: false, reason: 'pending_tool_results' };
  }

  if (input.selectedMessageCount < 4) {
    return { shouldCreate: false, reason: 'not_enough_messages' };
  }

  return { shouldCreate: true };
}

export function estimateModelInputTokens(input: {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
}): number {
  const text = stableStringify({
    messages: input.messages,
    tools: input.tools ?? []
  });
  const chars = Array.from(text);
  const cjkChars = chars.filter(isCjkTokenLikeChar).length;
  const otherChars = chars.length - cjkChars;

  return Math.ceil(cjkChars + otherChars / 4);
}

function isCjkTokenLikeChar(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}
