import { roundTripAgUiEvent } from '@mido-agent/conformance';
import type { CoreEvent } from '@mido-agent/protocol-core';

describe('protocol-agui', () => {
  it('round-trips core events without losing identifiers', () => {
    const sourceEvent: CoreEvent = {
      type: 'TOOL_CALL_END',
      eventId: 'evt-1',
      runId: 'run-1',
      messageId: 'msg-1',
      sequence: 4,
      timestamp: new Date().toISOString(),
      toolCallId: 'tool-1',
      toolId: 'client:confirm',
      toolName: 'confirm',
      modelName: 'client__confirm',
      toolRuntime: 'client',
      executionPolicy: 'client_interactive',
      timeoutMs: 30000,
      args: {
        approved: false
      }
    };

    const result = roundTripAgUiEvent(sourceEvent);
    expect(result).toEqual(sourceEvent);
  });

  it('round-trips reasoning events', () => {
    const sourceEvent: CoreEvent = {
      type: 'REASONING_DELTA',
      eventId: 'evt-1',
      runId: 'run-1',
      messageId: 'msg-1',
      sequence: 2,
      timestamp: new Date().toISOString(),
      reasoningId: 'rsn-1',
      delta: 'Thinking.'
    };

    const result = roundTripAgUiEvent(sourceEvent);
    expect(result).toEqual(sourceEvent);
  });
});
