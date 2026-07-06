import type { AgentMessage, CoreEvent, JsonObject, JsonValue, RunStartRequest, RunTraceSummary, ToolDefinition } from '@mido-agent/protocol-core';

export interface RunMetrics {
  runId?: string;
  threadId?: string;
  status: RunTraceSummary['status'];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  efficiency: RunEfficiencyMetrics;
  cost: RunCostMetrics;
  robustness: RunRobustnessMetrics;
  safety: RunSafetyMetrics;
}

export interface RunEfficiencyMetrics {
  durationMs?: number;
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
  retryCount: number;
  contextEstimate?: number;
}

export interface RunCostMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  missingUsageCount: number;
}

export interface RunRobustnessMetrics {
  retryableErrorCount: number;
  toolErrorCount: number;
  providerErrorCount: number;
  recoveredErrorCount: number;
  timeoutCount: number;
}

export interface RunSafetyMetrics {
  policyDeniedCount: number;
  confirmationRequiredCount: number;
  unsafeToolAttemptCount: number;
  privateNetworkBlockedCount: number;
}

export interface RunMetricOptions {
  estimatedCostUsd?: number;
  contextEstimate?: number;
}

export interface EvalCase {
  id: string;
  name?: string;
  description?: string;
  request?: Partial<RunStartRequest> | JsonObject;
  expectations: EvalExpectation[];
  metadata?: JsonObject;
}

export type EvalExpectation =
  | { type: 'run_status'; status: RunTraceSummary['status'] }
  | { type: 'exact_text'; text: string }
  | { type: 'contains_text'; text: string }
  | { type: 'event_sequence'; events: CoreEvent['type'][] }
  | { type: 'tool_called'; toolName: string }
  | { type: 'tool_not_called'; toolName: string }
  | { type: 'error_code'; code: string };

export interface EvalCaseGradeInput {
  caseId: string;
  events: CoreEvent[];
  expectations: EvalExpectation[];
}

export interface EvalCaseGradeResult {
  caseId: string;
  passed: boolean;
  errors: string[];
}

export interface EvalCaseResult {
  caseId: string;
  name?: string;
  passed: boolean;
  metrics: RunMetrics;
  errors: string[];
  artifact?: EvalRunArtifact;
}

export interface EvalSuiteReport {
  suiteId: string;
  createdAt: string;
  totalCases: number;
  passedCases: number;
  failedCaseCount: number;
  successRate: number;
  aggregate: EvalSuiteAggregateMetrics;
  results: EvalCaseResult[];
  failedCases: EvalSuiteFailedCase[];
}

export interface EvalSuiteFailedCase {
  caseId: string;
  name?: string;
  errors: string[];
}

export interface EvalSuiteAggregateMetrics {
  efficiency: {
    eventCount: number;
    modelCallCount: number;
    toolCallCount: number;
    retryCount: number;
    averageDurationMs?: number;
    p95DurationMs?: number;
  };
  cost: RunCostMetrics;
  robustness: RunRobustnessMetrics;
  safety: RunSafetyMetrics;
}

export interface AggregateEvalSuiteInput {
  suiteId: string;
  createdAt?: string;
  results: EvalCaseResult[];
}

export interface RunArtifactManifest {
  runId?: string;
  threadId?: string;
  traceId?: string;
  createdAt: string;
  sdkVersion?: string;
  gitSha?: string;
  gitBranch?: string;
  provider?: string;
  model?: string;
  adapterKind?: string;
  requestHash: string;
  eventTraceHash: string;
  toolManifestHash: string;
  systemPromptHash?: string;
  modelCapabilitiesHash?: string;
  skillDigestList: string[];
}

export interface EvalRunArtifact {
  schemaVersion: 'mido.run-artifact.v1';
  manifest: RunArtifactManifest;
  trace: RunTraceSummary;
  metrics: RunMetrics;
  events: CoreEvent[];
  request?: unknown;
  tools?: ToolDefinition[];
  modelCapabilities?: unknown;
}

export interface BuildRunArtifactInput {
  events: CoreEvent[];
  request?: unknown;
  tools?: ToolDefinition[];
  model?: {
    provider?: string;
    model?: string;
  };
  modelCapabilities?: unknown;
  adapterKind?: string;
  sdkVersion?: string;
  git?: {
    sha?: string;
    branch?: string;
  };
  systemPrompt?: unknown;
  skillRefs?: string[];
  includePayload?: boolean;
  createdAt?: string;
  metrics?: RunMetrics;
}

export interface EvalCaseRunOutput {
  events: CoreEvent[];
  request?: unknown;
  tools?: ToolDefinition[];
  model?: {
    provider?: string;
    model?: string;
  };
  modelCapabilities?: unknown;
  metadata?: {
    adapterKind?: string;
    sdkVersion?: string;
    gitSha?: string;
    gitBranch?: string;
    skillRefs?: string[];
    systemPrompt?: unknown;
  };
}

export type EvalCaseRunner = (evalCase: EvalCase) => Promise<EvalCaseRunOutput> | EvalCaseRunOutput;

export interface RunEvalSuiteInput {
  suiteId: string;
  cases: EvalCase[];
  runCase: EvalCaseRunner;
  createdAt?: string;
  includePayload?: boolean;
}

export interface RunEvalSuiteResult {
  suiteId: string;
  createdAt: string;
  results: Array<EvalCaseResult & { artifact: EvalRunArtifact }>;
  report: EvalSuiteReport;
  markdown: string;
}

export interface FixtureEvalCase extends EvalCase {
  events: CoreEvent[];
  tools?: ToolDefinition[];
  model?: {
    provider?: string;
    model?: string;
  };
  skillRefs?: string[];
  requestMessages?: AgentMessage[];
  modelCapabilities?: JsonValue;
}

export interface EvaluateEventStoreInput {
  rootDir: string;
  suiteId?: string;
  createdAt?: string;
  includeEvents?: boolean;
}

export interface EventStoreEvaluationRun {
  caseId: string;
  eventPath: string;
  runId?: string;
  threadId?: string;
  status: RunTraceSummary['status'];
  metrics: RunMetrics;
  events?: CoreEvent[];
}

export interface EventStoreEvaluationResult {
  suiteId: string;
  createdAt: string;
  rootDir: string;
  runs: EventStoreEvaluationRun[];
  report: EvalSuiteReport;
  markdown: string;
}
