import type { CoreEvent } from '@mido/protocol-core';
import { gradeEvalCase, parseFixtureEvalCasesJsonl, runEvalSuite } from '@mido/evaluator';

describe('evaluator runner and deterministic graders', () => {
  it('grades text, event sequence, tool usage, status, and error expectations', () => {
    const result = gradeEvalCase({
      caseId: 'mixed-case',
      events: createMixedEvents(),
      expectations: [
        {
          type: 'contains_text',
          text: 'hello'
        },
        {
          type: 'event_sequence',
          events: ['RUN_STARTED', 'TEXT_END', 'TOOL_CALL_START', 'RUN_ERROR']
        },
        {
          type: 'tool_called',
          toolName: 'lookup'
        },
        {
          type: 'tool_not_called',
          toolName: 'delete_file'
        },
        {
          type: 'run_status',
          status: 'error'
        },
        {
          type: 'error_code',
          code: 'tool_policy_denied'
        }
      ]
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports deterministic grader failures', () => {
    const result = gradeEvalCase({
      caseId: 'bad-case',
      events: createMixedEvents(),
      expectations: [
        {
          type: 'exact_text',
          text: 'different'
        },
        {
          type: 'tool_not_called',
          toolName: 'lookup'
        }
      ]
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      'Expected assistant text to equal "different"',
      'Expected tool "lookup" not to be called'
    ]);
  });

  it('runs a suite through an injected case runner and returns artifacts', async () => {
    const suite = await runEvalSuite({
      suiteId: 'local-fixture',
      createdAt: '2026-05-28T00:00:00.000Z',
      cases: [
        {
          id: 'completed-text',
          name: 'Completed text',
          expectations: [
            {
              type: 'run_status',
              status: 'completed'
            },
            {
              type: 'contains_text',
              text: 'done'
            }
          ]
        },
        {
          id: 'denied-tool',
          name: 'Denied tool',
          expectations: [
            {
              type: 'error_code',
              code: 'tool_policy_denied'
            }
          ]
        }
      ],
      runCase: async evalCase => ({
        events: evalCase.id === 'completed-text' ? createCompletedTextEvents() : createMixedEvents(),
        metadata: {
          adapterKind: 'fixture',
          sdkVersion: '0.1.0',
          gitSha: 'abc123'
        }
      })
    });

    expect(suite.report).toMatchObject({
      suiteId: 'local-fixture',
      totalCases: 2,
      passedCases: 2,
      failedCaseCount: 0,
      successRate: 1
    });
    expect(suite.results[0]?.artifact.schemaVersion).toBe('mido.run-artifact.v1');
    expect(suite.results[0]?.artifact.manifest.adapterKind).toBe('fixture');
    expect(suite.markdown).toContain('# Eval Suite: local-fixture');
  });

  it('parses fixture eval cases from JSONL', () => {
    const jsonl = [
      JSON.stringify({
        id: 'fixture-text',
        name: 'Fixture text',
        expectations: [
          {
            type: 'run_status',
            status: 'completed'
          }
        ],
        events: createCompletedTextEvents()
      }),
      '',
      JSON.stringify({
        id: 'fixture-deny',
        expectations: [
          {
            type: 'error_code',
            code: 'tool_policy_denied'
          }
        ],
        events: createMixedEvents()
      })
    ].join('\n');

    const cases = parseFixtureEvalCasesJsonl(jsonl);

    expect(cases).toHaveLength(2);
    expect(cases[0]?.id).toBe('fixture-text');
    expect(cases[0]?.events).toHaveLength(3);
    expect(cases[1]?.expectations[0]).toEqual({
      type: 'error_code',
      code: 'tool_policy_denied'
    });
  });
});

function createCompletedTextEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-1',
      runId: 'run-completed',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z'
    },
    {
      type: 'TEXT_END',
      eventId: 'evt-2',
      runId: 'run-completed',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      textId: 'text-1',
      text: 'done'
    },
    {
      type: 'RUN_FINISHED',
      eventId: 'evt-3',
      runId: 'run-completed',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      finishReason: 'completed'
    }
  ];
}

function createMixedEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-1',
      runId: 'run-mixed',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z'
    },
    {
      type: 'TEXT_END',
      eventId: 'evt-2',
      runId: 'run-mixed',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      textId: 'text-1',
      text: 'hello'
    },
    {
      type: 'TOOL_CALL_START',
      eventId: 'evt-3',
      runId: 'run-mixed',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      toolCallId: 'tool-call-1',
      toolId: 'tool-1',
      toolName: 'lookup',
      modelName: 'lookup',
      toolRuntime: 'server',
      executionPolicy: 'server'
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-4',
      runId: 'run-mixed',
      messageId: 'msg-2',
      sequence: 4,
      timestamp: '2026-05-28T00:00:03.000Z',
      error: {
        code: 'tool_policy_denied',
        message: 'Denied'
      }
    }
  ];
}
