import type { EvalSuiteReport } from './types.js';

export function renderEvalReport(report: EvalSuiteReport): string {
  const lines = [
    `# Eval Suite: ${report.suiteId}`,
    '',
    `Generated: ${report.createdAt}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Runs | ${report.totalCases} |`,
    `| Passed | ${report.passedCases} |`,
    `| Failed | ${report.failedCaseCount} |`,
    `| Success Rate | ${formatPercent(report.successRate)} |`,
    `| P95 Duration | ${formatDuration(report.aggregate.efficiency.p95DurationMs)} |`,
    `| Model Calls | ${report.aggregate.efficiency.modelCallCount} |`,
    `| Tool Calls | ${report.aggregate.efficiency.toolCallCount} |`,
    `| Total Tokens | ${report.aggregate.cost.totalTokens} |`,
    `| Missing Usage | ${report.aggregate.cost.missingUsageCount} |`,
    `| Tool Errors | ${report.aggregate.robustness.toolErrorCount} |`,
    `| Provider Errors | ${report.aggregate.robustness.providerErrorCount} |`,
    `| Policy Denied | ${report.aggregate.safety.policyDeniedCount} |`,
    `| Confirmation Required | ${report.aggregate.safety.confirmationRequiredCount} |`,
    `| Private Network Blocked | ${report.aggregate.safety.privateNetworkBlockedCount} |`,
    ''
  ];

  if (report.failedCases.length === 0) {
    lines.push('## Failed Cases', '', 'None.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Failed Cases', '');
  for (const failure of report.failedCases) {
    const label = failure.name ? `${failure.caseId} (${failure.name})` : failure.caseId;
    lines.push(`- ${label}: ${failure.errors.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${Math.round(value)}ms`;
}
