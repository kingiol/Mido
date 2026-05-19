import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue, JSONSchema, ToolExecutionPolicy } from '@mido/protocol-core';

import type { ToolkitToolDefinition } from './types.js';
import { toJsonValue } from './validation.js';

export const objectSchema: JSONSchema = {
  type: 'object',
  additionalProperties: true
};

export interface CreateToolOptions {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  executionPolicy: ToolExecutionPolicy;
  policy: JsonObject;
  resultSchema?: JSONSchema;
  timeoutMs?: number;
  execute?: (args: JsonObject, context?: unknown) => Promise<unknown> | unknown;
}

export function createTool(options: CreateToolOptions): ToolkitToolDefinition {
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    resultSchema: options.resultSchema ?? objectSchema,
    executionPolicy: options.executionPolicy,
    timeoutMs: options.timeoutMs,
    metadata: {
      policy: options.policy,
      toolkit: {
        package: '@mido/toolkit-core'
      }
    },
    execute: options.execute
      ? async (args, context) => toJsonValue(await options.execute?.(args, context))
      : undefined
  };
}

export function rankByText<T>(items: T[], query: string, getText: (item: T) => string): Array<{ item: T; score: number }> {
  const terms = tokenize(query);
  return items
    .map(item => {
      const text = getText(item).toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(result => result.score > 0 || terms.length === 0)
    .sort((left, right) => right.score - left.score);
}

export function createStableId(prefix: string, input: string): string {
  return `${prefix}_${createHash('sha256').update(input).digest('hex').slice(0, 16)}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .map(term => term.trim())
    .filter(Boolean);
}
