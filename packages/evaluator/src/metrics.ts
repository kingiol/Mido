import { buildRunTrace, type CoreEvent, type JsonObject, type JsonValue } from '@mido/protocol-core';

import type {
  EvalCaseResult,
  EvalSuiteAggregateMetrics,
  EvalSuiteReport,
  AggregateEvalSuiteInput,
  RunMetricOptions,
  RunMetrics
} from './types.js';

export function calculateRunMetrics(events: CoreEvent[], options: RunMetricOptions = {}): RunMetrics {
  const trace = buildRunTrace(events);
  const inputTokens = sumNumbers(trace.modelCalls.map(call => call.usage?.inputTokens));
  const outputTokens = sumNumbers(trace.modelCalls.map(call => call.usage?.outputTokens));
  const totalTokens = sumNumbers(
    trace.modelCalls.map(call => call.usage?.totalTokens ?? sumOptional(call.usage?.inputTokens, call.usage?.outputTokens))
  );
  const runErrors = events.filter(event => event.type === 'RUN_ERROR');
  const retryableErrorCount = runErrors.filter(event => event.error.retryable === true || event.trace?.attributes?.retryable === true).length;
  const providerRunErrorCount = runErrors.filter(event => event.trace?.attributes?.source === 'provider').length;
  const modelErrorCount = trace.modelCalls.filter(call => call.status === 'error').length;
  const policyDeniedCount = runErrors.filter(event => isPolicyDeniedCode(event.error.code)).length;
  const confirmationRequiredCount = runErrors.filter(event => isConfirmationRequiredCode(event.error.code)).length;
  const privateNetworkBlockedCount = runErrors.filter(event => isPrivateNetworkBlocked(event.error.code, event.error.message)).length;
  const unsafeToolAttemptCount = runErrors.filter(event => isUnsafeToolAttempt(event.error.code, event.error.message)).length;
  const toolErrorCount = trace.toolCalls.filter(call => call.status === 'error').length;
  const retryCount = countRetryAttempts(events);
  const recoveredErrorCount = countRecoveredErrors(events);
  const timeoutCount = countTimeouts(events);

  return {
    runId: trace.runId,
    threadId: trace.threadId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    efficiency: {
      durationMs: trace.durationMs,
      eventCount: trace.eventCount,
      modelCallCount: trace.modelCalls.length,
      toolCallCount: trace.toolCalls.length,
      retryCount,
      contextEstimate: options.contextEstimate
    },
    cost: {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd: options.estimatedCostUsd,
      missingUsageCount: trace.modelCalls.filter(call => !hasUsage(call.usage)).length
    },
    robustness: {
      retryableErrorCount,
      toolErrorCount,
      providerErrorCount: providerRunErrorCount > 0 ? providerRunErrorCount : modelErrorCount,
      recoveredErrorCount,
      timeoutCount
    },
    safety: {
      policyDeniedCount,
      confirmationRequiredCount,
      unsafeToolAttemptCount,
      privateNetworkBlockedCount
    }
  };
}

export function aggregateEvalSuite(input: AggregateEvalSuiteInput): EvalSuiteReport {
  const totalCases = input.results.length;
  const passedCases = input.results.filter(result => result.passed).length;
  const failedCasesList = input.results
    .filter(result => !result.passed)
    .map(result => ({
      caseId: result.caseId,
      name: result.name,
      errors: result.errors
    }));

  return {
    suiteId: input.suiteId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    totalCases,
    passedCases,
    failedCaseCount: totalCases - passedCases,
    successRate: totalCases === 0 ? 0 : passedCases / totalCases,
    aggregate: aggregateMetrics(input.results),
    results: input.results,
    failedCases: failedCasesList
  };
}

function aggregateMetrics(results: EvalCaseResult[]): EvalSuiteAggregateMetrics {
  const durations = results.map(result => result.metrics.durationMs).filter(isNumber).sort((left, right) => left - right);

  return {
    efficiency: {
      eventCount: sumNumbers(results.map(result => result.metrics.efficiency.eventCount)),
      modelCallCount: sumNumbers(results.map(result => result.metrics.efficiency.modelCallCount)),
      toolCallCount: sumNumbers(results.map(result => result.metrics.efficiency.toolCallCount)),
      retryCount: sumNumbers(results.map(result => result.metrics.efficiency.retryCount)),
      averageDurationMs: durations.length === 0 ? undefined : sumNumbers(durations) / durations.length,
      p95DurationMs: percentile(durations, 0.95)
    },
    cost: {
      inputTokens: sumNumbers(results.map(result => result.metrics.cost.inputTokens)),
      outputTokens: sumNumbers(results.map(result => result.metrics.cost.outputTokens)),
      totalTokens: sumNumbers(results.map(result => result.metrics.cost.totalTokens)),
      estimatedCostUsd: optionalSum(results.map(result => result.metrics.cost.estimatedCostUsd)),
      missingUsageCount: sumNumbers(results.map(result => result.metrics.cost.missingUsageCount))
    },
    robustness: {
      retryableErrorCount: sumNumbers(results.map(result => result.metrics.robustness.retryableErrorCount)),
      toolErrorCount: sumNumbers(results.map(result => result.metrics.robustness.toolErrorCount)),
      providerErrorCount: sumNumbers(results.map(result => result.metrics.robustness.providerErrorCount)),
      recoveredErrorCount: sumNumbers(results.map(result => result.metrics.robustness.recoveredErrorCount)),
      timeoutCount: sumNumbers(results.map(result => result.metrics.robustness.timeoutCount))
    },
    safety: {
      policyDeniedCount: sumNumbers(results.map(result => result.metrics.safety.policyDeniedCount)),
      confirmationRequiredCount: sumNumbers(results.map(result => result.metrics.safety.confirmationRequiredCount)),
      unsafeToolAttemptCount: sumNumbers(results.map(result => result.metrics.safety.unsafeToolAttemptCount)),
      privateNetworkBlockedCount: sumNumbers(results.map(result => result.metrics.safety.privateNetworkBlockedCount))
    }
  };
}

function hasUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): boolean {
  return usage?.inputTokens !== undefined || usage?.outputTokens !== undefined || usage?.totalTokens !== undefined;
}

function sumNumbers(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function optionalSum(values: Array<number | undefined>): number | undefined {
  const present = values.filter(isNumber);
  return present.length === 0 ? undefined : sumNumbers(present);
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}

function percentile(sortedValues: number[], percentileValue: number): number | undefined {
  if (sortedValues.length === 0) {
    return undefined;
  }

  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function countRetryAttempts(events: CoreEvent[]): number {
  return events.filter(event => isPositiveNumber(event.trace?.attributes?.retryAttempt)).length;
}

function countRecoveredErrors(events: CoreEvent[]): number {
  return events.filter(event => event.trace?.attributes?.recovered === true || event.trace?.attributes?.retryRecovered === true).length;
}

function countTimeouts(events: CoreEvent[]): number {
  return events.filter(event => eventContainsTimeout(event)).length;
}

function eventContainsTimeout(event: CoreEvent): boolean {
  if (event.type === 'RUN_ERROR') {
    return includesToken(event.error.code, 'timeout') || includesToken(event.error.message, 'timeout') || includesToken(event.error.message, 'timed out');
  }

  if (event.type === 'TOOL_RESULT' && event.isError) {
    return jsonValueContains(event.output, 'timeout') || jsonValueContains(event.output, 'timed out');
  }

  return false;
}

function isPositiveNumber(value: JsonValue | undefined): boolean {
  return typeof value === 'number' && value > 0;
}

function isPolicyDeniedCode(code: string): boolean {
  return code === 'tool_policy_denied' || code === 'tool_policy_missing' || code.startsWith('tool_policy_deny');
}

function isConfirmationRequiredCode(code: string): boolean {
  return code.includes('confirmation_required') || code.includes('requires_confirmation');
}

function isPrivateNetworkBlocked(code: string, message: string): boolean {
  return includesToken(code, 'private_network') || includesToken(message, 'private network');
}

function isUnsafeToolAttempt(code: string, message: string): boolean {
  return isPolicyDeniedCode(code) || includesToken(code, 'unsafe') || includesToken(message, 'destructive');
}

function includesToken(value: string, token: string): boolean {
  return value.toLowerCase().includes(token);
}

function jsonValueContains(value: JsonValue, token: string): boolean {
  if (typeof value === 'string') {
    return includesToken(value, token);
  }

  if (Array.isArray(value)) {
    return value.some(item => jsonValueContains(item, token));
  }

  if (isJsonObject(value)) {
    return Object.values(value).some(item => jsonValueContains(item, token));
  }

  return false;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
