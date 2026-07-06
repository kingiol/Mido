import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CoreEvent } from '@mido-agent/protocol-core';

import { aggregateEvalSuite, calculateRunMetrics } from './metrics.js';
import { renderEvalReport } from './report.js';
import type { EvaluateEventStoreInput, EventStoreEvaluationResult, EventStoreEvaluationRun } from './types.js';

export async function evaluateEventStore(input: EvaluateEventStoreInput): Promise<EventStoreEvaluationResult> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const suiteId = input.suiteId ?? 'mido-store';
  const eventPaths = await findEventFiles(input.rootDir);
  const runs = await Promise.all(
    eventPaths.map(async eventPath => evaluateEventFile(input.rootDir, eventPath, Boolean(input.includeEvents)))
  );
  const report = aggregateEvalSuite({
    suiteId,
    createdAt,
    results: runs.map(run => ({
      caseId: run.caseId,
      name: run.runId,
      passed: run.metrics.status !== 'unknown' && run.metrics.efficiency.eventCount > 0,
      metrics: run.metrics,
      errors: run.metrics.status === 'unknown' || run.metrics.efficiency.eventCount === 0 ? ['No evaluatable events found'] : []
    }))
  });

  return {
    suiteId,
    createdAt,
    rootDir: input.rootDir,
    runs,
    report,
    markdown: renderEvalReport(report)
  };
}

async function evaluateEventFile(rootDir: string, eventPath: string, includeEvents: boolean): Promise<EventStoreEvaluationRun> {
  const events = parseEventJsonl(await readFile(eventPath, 'utf8'));
  const metrics = calculateRunMetrics(events);

  return {
    caseId: path.relative(rootDir, eventPath),
    eventPath,
    runId: metrics.runId,
    threadId: metrics.threadId,
    status: metrics.status,
    metrics,
    events: includeEvents ? events : undefined
  };
}

async function findEventFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  await walk(rootDir, found);
  return found.sort();
}

async function walk(currentPath: string, found: string[]): Promise<void> {
  const entries = await readdir(currentPath, {
    withFileTypes: true
  });

  await Promise.all(
    entries.map(async entry => {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, found);
        return;
      }

      if (entry.isFile() && entry.name === 'events.jsonl') {
        found.push(nextPath);
      }
    })
  );
}

function parseEventJsonl(content: string): CoreEvent[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as CoreEvent)
    .sort((left, right) => left.sequence - right.sequence);
}
