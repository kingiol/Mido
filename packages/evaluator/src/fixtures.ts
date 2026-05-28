import type { CoreEvent } from '@mido/protocol-core';

import type { EvalExpectation, FixtureEvalCase } from './types.js';

export function parseFixtureEvalCasesJsonl(jsonl: string): FixtureEvalCase[] {
  return jsonl
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line, index) => parseFixtureEvalCase(line, index + 1));
}

function parseFixtureEvalCase(line: string, lineNumber: number): FixtureEvalCase {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid eval fixture on line ${lineNumber}: expected object`);
  }

  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error(`Invalid eval fixture on line ${lineNumber}: missing id`);
  }

  if (!Array.isArray(parsed.events)) {
    throw new Error(`Invalid eval fixture on line ${lineNumber}: missing events`);
  }

  if (!Array.isArray(parsed.expectations)) {
    throw new Error(`Invalid eval fixture on line ${lineNumber}: missing expectations`);
  }

  return {
    ...parsed,
    id: parsed.id,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    expectations: parsed.expectations as EvalExpectation[],
    events: parsed.events as CoreEvent[]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

