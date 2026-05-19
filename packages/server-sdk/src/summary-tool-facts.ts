import type { AgentMessage, JsonObject, ToolResultPart } from '@mido/protocol-core';

export interface SummaryToolFact {
  messageId: string;
  toolCallId: string;
  toolName: string;
  text: string;
}

export function extractSummaryToolFacts(messages: AgentMessage[]): SummaryToolFact[] {
  return messages.flatMap(message => {
    if (message.role !== 'tool') {
      return [];
    }

    return message.content.flatMap(part => {
      if (part.type !== 'tool-result') {
        return [];
      }

      const text = summarizeToolResult(part);
      return text
        ? [
            {
              messageId: message.id,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              text
            }
          ]
        : [];
    });
  });
}

function summarizeToolResult(part: ToolResultPart): string | undefined {
  if (part.isError) {
    return `${part.toolName} failed: ${stringifyCompact(part.output)}`;
  }

  if (typeof part.output !== 'object' || part.output === null || Array.isArray(part.output)) {
    return `${part.toolName} returned: ${String(part.output)}`;
  }

  const output = part.output as JsonObject;
  const path = typeof output.path === 'string' ? output.path : undefined;
  const summary = typeof output.summary === 'string' ? output.summary : undefined;
  const message = typeof output.message === 'string' ? output.message : undefined;
  const id = typeof output.id === 'string' ? output.id : undefined;

  if (path && summary) {
    return `${part.toolName} returned path ${path}: ${summary}`;
  }

  if (summary) {
    return `${part.toolName} returned summary: ${summary}`;
  }

  if (message) {
    return `${part.toolName} returned message: ${message}`;
  }

  if (id) {
    return `${part.toolName} returned id: ${id}`;
  }

  return undefined;
}

function stringifyCompact(value: unknown): string {
  return JSON.stringify(value);
}
