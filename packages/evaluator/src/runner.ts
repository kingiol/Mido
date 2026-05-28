import { aggregateEvalSuite, calculateRunMetrics } from './metrics.js';
import { buildRunArtifact } from './artifact.js';
import { gradeEvalCase } from './graders.js';
import { renderEvalReport } from './report.js';
import type { EvalCaseResult, RunEvalSuiteInput, RunEvalSuiteResult } from './types.js';

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<RunEvalSuiteResult> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const results: RunEvalSuiteResult['results'] = [];

  for (const evalCase of input.cases) {
    const output = await input.runCase(evalCase);
    const metrics = calculateRunMetrics(output.events);
    const grade = gradeEvalCase({
      caseId: evalCase.id,
      events: output.events,
      expectations: evalCase.expectations
    });
    const artifact = buildRunArtifact({
      events: output.events,
      request: output.request ?? evalCase.request,
      tools: output.tools,
      model: output.model,
      modelCapabilities: output.modelCapabilities,
      adapterKind: output.metadata?.adapterKind,
      sdkVersion: output.metadata?.sdkVersion,
      git: {
        sha: output.metadata?.gitSha,
        branch: output.metadata?.gitBranch
      },
      systemPrompt: output.metadata?.systemPrompt,
      skillRefs: output.metadata?.skillRefs,
      includePayload: input.includePayload,
      createdAt,
      metrics
    });

    results.push({
      caseId: evalCase.id,
      name: evalCase.name,
      passed: grade.passed,
      metrics,
      errors: grade.errors,
      artifact
    });
  }

  const report = aggregateEvalSuite({
    suiteId: input.suiteId,
    createdAt,
    results: results.map(toReportResult)
  });

  return {
    suiteId: input.suiteId,
    createdAt,
    results,
    report,
    markdown: renderEvalReport(report)
  };
}

function toReportResult(result: RunEvalSuiteResult['results'][number]): EvalCaseResult {
  return {
    caseId: result.caseId,
    name: result.name,
    passed: result.passed,
    metrics: result.metrics,
    errors: result.errors,
    artifact: result.artifact
  };
}

