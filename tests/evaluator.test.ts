import type { AgentMessage, CoreEvent, ToolDefinition } from '@mido/protocol-core';
import {
  aggregateEvalSuite,
  buildRunArtifact,
  calculateRunMetrics,
  hashMessages,
  hashToolManifest,
  renderEvalReport
} from '@mido/evaluator';

const baseTimestamp = '2026-05-28T00:00:00.000Z';

describe('evaluator metrics and artifacts', () => {
  it('calculates run metrics from core events', () => {
    const metrics = calculateRunMetrics(createCompletedToolRunEvents());

    expect(metrics.runId).toBe('run-metrics');
    expect(metrics.threadId).toBe('thread-1');
    expect(metrics.status).toBe('completed');
    expect(metrics.efficiency).toMatchObject({
      durationMs: 5000,
      eventCount: 6,
      modelCallCount: 1,
      toolCallCount: 1,
      retryCount: 0
    });
    expect(metrics.cost).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      missingUsageCount: 0
    });
    expect(metrics.robustness.toolErrorCount).toBe(0);
    expect(metrics.safety.policyDeniedCount).toBe(0);
  });

  it('counts missing usage, provider errors, tool errors, and safety events', () => {
    const metrics = calculateRunMetrics(createErrorRunEvents());

    expect(metrics.status).toBe('error');
    expect(metrics.cost.missingUsageCount).toBe(1);
    expect(metrics.robustness).toMatchObject({
      retryableErrorCount: 1,
      providerErrorCount: 1,
      toolErrorCount: 1,
      timeoutCount: 1
    });
    expect(metrics.safety).toMatchObject({
      policyDeniedCount: 1,
      confirmationRequiredCount: 1,
      privateNetworkBlockedCount: 1,
      unsafeToolAttemptCount: 1
    });
  });

  it('builds stable hashes for request messages and tool manifests', () => {
    const messages = createMessages('hello');
    const tool = {
      toolId: 'tool-1',
      name: 'lookup',
      modelName: 'lookup',
      description: 'Look up a value',
      inputSchema: {
        type: 'object'
      },
      resultSchema: {
        type: 'object'
      },
      executionPolicy: 'server',
      execute: async () => ({ ok: true })
    } as ToolDefinition & { execute?: () => Promise<unknown> };
    const alternateTool = {
      ...tool,
      execute: async () => ({ ok: false })
    } as ToolDefinition & { execute?: () => Promise<unknown> };

    expect(hashMessages(messages)).toBe(hashMessages(createMessages('hello')));
    expect(hashMessages(messages)).not.toBe(hashMessages(createMessages('goodbye')));
    expect(hashToolManifest([tool])).toBe(
      hashToolManifest([alternateTool])
    );
  });

  it('builds a run artifact without sensitive payloads by default', () => {
    const events = createCompletedToolRunEvents();
    const artifact = buildRunArtifact({
      events,
      request: {
        messages: createMessages('hello')
      },
      tools: [
        {
          toolId: 'tool-1',
          name: 'lookup',
          modelName: 'lookup',
          description: 'Look up a value',
          inputSchema: {
            type: 'object'
          },
          resultSchema: {
            type: 'object'
          },
          executionPolicy: 'server'
        }
      ],
      model: {
        provider: 'fixture',
        model: 'fixture-model'
      },
      adapterKind: 'fixture',
      sdkVersion: '0.1.0',
      git: {
        sha: 'abc123'
      },
      skillRefs: ['client-smoke@local'],
      createdAt: baseTimestamp
    });

    expect(artifact.schemaVersion).toBe('mido.run-artifact.v1');
    expect(artifact.request).toBeUndefined();
    expect(artifact.manifest).toMatchObject({
      runId: 'run-metrics',
      threadId: 'thread-1',
      createdAt: baseTimestamp,
      sdkVersion: '0.1.0',
      gitSha: 'abc123',
      provider: 'fixture',
      model: 'fixture-model',
      adapterKind: 'fixture',
      skillDigestList: ['client-smoke@local']
    });
    expect(artifact.manifest.requestHash).toMatch(/^sha256:/);
    expect(artifact.manifest.toolManifestHash).toMatch(/^sha256:/);
    expect(artifact.trace.status).toBe('completed');
    expect(artifact.metrics.cost.totalTokens).toBe(15);
  });

  it('includes request payload only when explicitly requested', () => {
    const request = {
      messages: createMessages('hello')
    };
    const artifact = buildRunArtifact({
      events: createCompletedToolRunEvents(),
      request,
      includePayload: true,
      createdAt: baseTimestamp
    });

    expect(artifact.request).toEqual(request);
  });

  it('aggregates suite results and renders markdown', () => {
    const passingMetrics = calculateRunMetrics(createCompletedToolRunEvents());
    const failingMetrics = calculateRunMetrics(createErrorRunEvents());
    const report = aggregateEvalSuite({
      suiteId: 'harness-smoke',
      createdAt: baseTimestamp,
      results: [
        {
          caseId: 'text-only',
          name: 'Text only',
          passed: true,
          metrics: passingMetrics,
          errors: []
        },
        {
          caseId: 'policy-deny',
          name: 'Policy deny',
          passed: false,
          metrics: failingMetrics,
          errors: ['Expected completed run']
        }
      ]
    });

    expect(report).toMatchObject({
      suiteId: 'harness-smoke',
      totalCases: 2,
      passedCases: 1,
      failedCaseCount: 1,
      successRate: 0.5
    });
    expect(report.aggregate.cost.totalTokens).toBe(15);
    expect(report.failedCases).toEqual([
      {
        caseId: 'policy-deny',
        name: 'Policy deny',
        errors: ['Expected completed run']
      }
    ]);

    const markdown = renderEvalReport(report);
    expect(markdown).toContain('# Eval Suite: harness-smoke');
    expect(markdown).toContain('Success Rate');
    expect(markdown).toContain('policy-deny');
  });
});

function createMessages(text: string): AgentMessage[] {
  return [
    {
      id: 'msg-user',
      role: 'user',
      createdAt: baseTimestamp,
      content: [
        {
          type: 'text',
          text
        }
      ]
    }
  ];
}

function createCompletedToolRunEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-1',
      runId: 'run-metrics',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z',
      threadId: 'thread-1',
      trace: {
        traceId: 'trace-1',
        spanId: 'run-metrics',
        name: 'RUN_STARTED',
        kind: 'run'
      }
    },
    {
      type: 'MODEL_CALL_START',
      eventId: 'evt-2',
      runId: 'run-metrics',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      modelCallId: 'model-1',
      provider: 'fixture',
      model: 'fixture-model'
    },
    {
      type: 'MODEL_CALL_END',
      eventId: 'evt-3',
      runId: 'run-metrics',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      modelCallId: 'model-1',
      status: 'completed',
      provider: 'fixture',
      model: 'fixture-model',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    },
    {
      type: 'TOOL_CALL_START',
      eventId: 'evt-4',
      runId: 'run-metrics',
      messageId: 'msg-2',
      sequence: 4,
      timestamp: '2026-05-28T00:00:03.000Z',
      toolCallId: 'tool-call-1',
      toolId: 'tool-1',
      toolName: 'lookup',
      modelName: 'lookup',
      toolRuntime: 'server',
      executionPolicy: 'server'
    },
    {
      type: 'TOOL_RESULT',
      eventId: 'evt-5',
      runId: 'run-metrics',
      messageId: 'msg-2',
      sequence: 5,
      timestamp: '2026-05-28T00:00:04.000Z',
      toolCallId: 'tool-call-1',
      toolId: 'tool-1',
      toolName: 'lookup',
      modelName: 'lookup',
      toolRuntime: 'server',
      output: {
        ok: true
      }
    },
    {
      type: 'RUN_FINISHED',
      eventId: 'evt-6',
      runId: 'run-metrics',
      messageId: 'msg-2',
      sequence: 6,
      timestamp: '2026-05-28T00:00:05.000Z',
      finishReason: 'completed'
    }
  ];
}

function createErrorRunEvents(): CoreEvent[] {
  return [
    {
      type: 'RUN_STARTED',
      eventId: 'evt-e1',
      runId: 'run-errors',
      messageId: 'msg-1',
      sequence: 1,
      timestamp: '2026-05-28T00:00:00.000Z'
    },
    {
      type: 'MODEL_CALL_START',
      eventId: 'evt-e2',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 2,
      timestamp: '2026-05-28T00:00:01.000Z',
      modelCallId: 'model-1',
      provider: 'fixture',
      model: 'fixture-model'
    },
    {
      type: 'MODEL_CALL_END',
      eventId: 'evt-e3',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 3,
      timestamp: '2026-05-28T00:00:02.000Z',
      modelCallId: 'model-1',
      status: 'error',
      provider: 'fixture',
      model: 'fixture-model'
    },
    {
      type: 'TOOL_RESULT',
      eventId: 'evt-e4',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 4,
      timestamp: '2026-05-28T00:00:03.000Z',
      toolCallId: 'tool-call-1',
      toolName: 'fetch_url',
      modelName: 'fetch_url',
      toolRuntime: 'server',
      isError: true,
      output: {
        code: 'tool_timeout',
        message: 'Timed out while fetching private network URL'
      }
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-e5',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 5,
      timestamp: '2026-05-28T00:00:04.000Z',
      trace: {
        traceId: 'run-errors',
        spanId: 'msg-2',
        name: 'RUN_ERROR',
        kind: 'run',
        attributes: {
          source: 'provider'
        }
      },
      error: {
        code: 'rate_limit',
        message: 'Provider rate limited the request',
        retryable: true
      }
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-e6',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 6,
      timestamp: '2026-05-28T00:00:05.000Z',
      error: {
        code: 'tool_policy_denied',
        message: 'Tool policy denied destructive action'
      }
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-e7',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 7,
      timestamp: '2026-05-28T00:00:06.000Z',
      error: {
        code: 'tool_policy_confirmation_required',
        message: 'Tool requires confirmation'
      }
    },
    {
      type: 'RUN_ERROR',
      eventId: 'evt-e8',
      runId: 'run-errors',
      messageId: 'msg-2',
      sequence: 8,
      timestamp: '2026-05-28T00:00:07.000Z',
      error: {
        code: 'private_network_blocked',
        message: 'Private network access blocked'
      }
    }
  ];
}
