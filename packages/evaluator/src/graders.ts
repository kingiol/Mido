import { buildRunTrace, type CoreEvent, type JsonObject, type JsonValue } from '@mido-agent/protocol-core';

import type { EvalCaseGradeInput, EvalCaseGradeResult, EvalExpectation } from './types.js';

export function gradeEvalCase(input: EvalCaseGradeInput): EvalCaseGradeResult {
  const errors = input.expectations.flatMap(expectation => gradeExpectation(input.events, expectation));

  return {
    caseId: input.caseId,
    passed: errors.length === 0,
    errors
  };
}

function gradeExpectation(events: CoreEvent[], expectation: EvalExpectation): string[] {
  switch (expectation.type) {
    case 'run_status': {
      const trace = buildRunTrace(events);
      return trace.status === expectation.status ? [] : [`Expected run status "${expectation.status}" but got "${trace.status}"`];
    }
    case 'exact_text': {
      const text = collectAssistantText(events);
      return text === expectation.text ? [] : [`Expected assistant text to equal "${expectation.text}"`];
    }
    case 'contains_text': {
      const text = collectAssistantText(events);
      return text.includes(expectation.text) ? [] : [`Expected assistant text to contain "${expectation.text}"`];
    }
    case 'event_sequence': {
      const actual = events.map(event => event.type);
      return containsSubsequence(actual, expectation.events)
        ? []
        : [`Expected event sequence ${expectation.events.join(' -> ')}`];
    }
    case 'tool_called': {
      return events.some(event => event.type === 'TOOL_CALL_START' && event.toolName === expectation.toolName)
        ? []
        : [`Expected tool "${expectation.toolName}" to be called`];
    }
    case 'tool_not_called': {
      return events.some(event => event.type === 'TOOL_CALL_START' && event.toolName === expectation.toolName)
        ? [`Expected tool "${expectation.toolName}" not to be called`]
        : [];
    }
    case 'error_code': {
      return collectErrorCodes(events).includes(expectation.code) ? [] : [`Expected error code "${expectation.code}"`];
    }
  }
}

function collectAssistantText(events: CoreEvent[]): string {
  const endedText = events.filter(event => event.type === 'TEXT_END').map(event => event.text).join('');
  if (endedText) {
    return endedText;
  }

  return events.filter(event => event.type === 'TEXT_DELTA').map(event => event.delta).join('');
}

function collectErrorCodes(events: CoreEvent[]): string[] {
  return events.flatMap(event => {
    if (event.type === 'RUN_ERROR') {
      return [event.error.code];
    }

    if (event.type === 'TOOL_RESULT' && event.isError) {
      const code = readErrorCode(event.output);
      return code ? [code] : [];
    }

    return [];
  });
}

function readErrorCode(value: JsonValue): string | undefined {
  if (isJsonObject(value) && typeof value.code === 'string') {
    return value.code;
  }

  return undefined;
}

function containsSubsequence(actual: CoreEvent['type'][], expected: CoreEvent['type'][]): boolean {
  let cursor = 0;
  for (const eventType of actual) {
    if (eventType === expected[cursor]) {
      cursor += 1;
    }

    if (cursor === expected.length) {
      return true;
    }
  }

  return expected.length === 0;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

