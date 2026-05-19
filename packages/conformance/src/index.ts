import { fromAgUiEvent, toAgUiEvent } from '@mido/protocol-agui';
import { coreProtocolSchemas, type CoreEvent } from '@mido/protocol-core';

export interface ConformanceScenario {
  id: string;
  description: string;
  expectedSequence: CoreEvent['type'][];
}

export const conformanceScenarios: ConformanceScenario[] = [
  {
    id: 'text-only',
    description: 'Assistant streams text and finishes without tool usage.',
    expectedSequence: ['RUN_STARTED', 'TEXT_START', 'TEXT_DELTA', 'TEXT_END', 'RUN_FINISHED']
  },
  {
    id: 'server-tool',
    description: 'Assistant calls a server tool, receives the result, and then finishes.',
    expectedSequence: [
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_RESULT',
      'RUN_FINISHED'
    ]
  },
  {
    id: 'client-auto-tool',
    description: 'Assistant pauses for a client auto tool and resumes after the client submits a tool result.',
    expectedSequence: [
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'RUN_FINISHED',
      'TOOL_RESULT',
      'RUN_FINISHED'
    ]
  },
  {
    id: 'client-interactive-tool',
    description: 'Assistant waits for interactive UI confirmation before continuing.',
    expectedSequence: [
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'RUN_FINISHED',
      'TOOL_RESULT',
      'TEXT_START',
      'TEXT_DELTA',
      'TEXT_END',
      'RUN_FINISHED'
    ]
  }
];

export function roundTripAgUiEvent(event: CoreEvent): CoreEvent {
  return fromAgUiEvent(toAgUiEvent(event));
}

export const schemaBundle = coreProtocolSchemas;
