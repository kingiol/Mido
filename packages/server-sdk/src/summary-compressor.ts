import { createId, nowIso, stableStringify, type AgentMessage } from '@mido-agent/protocol-core';

import type { SummaryToolFact } from './summary-tool-facts.js';
import { SUMMARY_COMPRESSOR_SYSTEM_PROMPT } from './prompts/summary-compressor.js';

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
