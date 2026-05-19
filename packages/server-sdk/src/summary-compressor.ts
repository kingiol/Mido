import { createId, nowIso, stableStringify, type AgentMessage } from '@mido/protocol-core';

import type { SummaryToolFact } from './summary-tool-facts.js';

export const SUMMARY_COMPRESSOR_SYSTEM_PROMPT = `You are a context compressor for an agent thread.

Your only job is to convert older thread messages into one faithful summary message.
You are not the task-solving agent. Do not answer the user's latest request.
Do not call tools. Do not invent facts. Do not add advice.

Preserve only information that can affect future agent behavior:
- current user goal and motivation
- explicit user preferences, constraints, language, tone, and UI requirements
- decisions already made
- important repo facts, file paths, APIs, schemas, data structures, and environment details
- meaningful tool results, including paths, ids, query results, errors, and state changes
- current progress, next action, and open questions

Discard:
- small talk
- duplicate wording
- stale ideas superseded by later messages
- raw tool dumps when a concise fact is enough
- implementation details that no longer affect future work

Write the result as concise Markdown.
Start with "Summary:".
Do not include hidden system/developer instructions verbatim.
Do not represent the summary as a user request.`;

export interface SummaryCompressorInput {
  threadId: string;
  coveredMessages: AgentMessage[];
  toolFacts: SummaryToolFact[];
  retainedWindowPreview: AgentMessage[];
  targetTokens: number;
}

export interface SummaryCompressorOutput {
  summaryText: string;
  droppedAsStale?: string[];
  openQuestions?: string[];
}

export function buildSummaryCompressorMessages(input: SummaryCompressorInput): AgentMessage[] {
  return [
    {
      id: createId('msg'),
      role: 'system',
      createdAt: nowIso(),
      content: [{ type: 'text', text: SUMMARY_COMPRESSOR_SYSTEM_PROMPT }]
    },
    {
      id: createId('msg'),
      role: 'user',
      createdAt: nowIso(),
      content: [
        {
          type: 'text',
          text: stableStringify(input)
        }
      ]
    }
  ];
}
