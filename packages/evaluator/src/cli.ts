import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseFixtureEvalCasesJsonl } from './fixtures.js';
import { runEvalSuite } from './runner.js';
import type { FixtureEvalCase } from './types.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  const fixtureFiles = files.length > 0 ? files : ['docs/evals/harness-smoke.jsonl', 'docs/evals/harness-safety.jsonl'];
  const cases = await readFixtureCases(fixtureFiles);
  const createdAt = new Date().toISOString();
  const git = await readGitMetadata();
  const suiteId = fixtureFiles.length === 1 ? path.basename(fixtureFiles[0] ?? 'harness-local', '.jsonl') : 'harness-local';

  const suite = await runEvalSuite({
    suiteId,
    cases,
    createdAt,
    runCase: evalCase => {
      const fixture = evalCase as FixtureEvalCase;
      return {
        events: fixture.events,
        request: fixture.request ?? (fixture.requestMessages ? { messages: fixture.requestMessages } : undefined),
        tools: fixture.tools,
        model: fixture.model ?? {
          provider: 'fixture',
          model: 'fixture-model'
        },
        modelCapabilities: fixture.modelCapabilities,
        metadata: {
          adapterKind: 'fixture',
          sdkVersion: '0.1.0',
          gitSha: git.sha,
          gitBranch: git.branch,
          skillRefs: fixture.skillRefs
        }
      };
    }
  });

  const outputDir = path.resolve(process.cwd(), 'artifacts/evals');
  await mkdir(outputDir, { recursive: true });

  const timestamp = createdAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `${suiteId}-${timestamp}.json`);
  const markdownPath = path.join(outputDir, `${suiteId}-${timestamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(suite, null, 2)}\n`);
  await writeFile(markdownPath, suite.markdown);

  console.log(suite.markdown);
  console.log(`Wrote JSON report: ${jsonPath}`);
  console.log(`Wrote Markdown report: ${markdownPath}`);

  if (suite.report.failedCaseCount > 0) {
    process.exitCode = 1;
  }
}

async function readFixtureCases(files: string[]): Promise<FixtureEvalCase[]> {
  const suites = await Promise.all(
    files.map(async file => {
      const content = await readFile(path.resolve(process.cwd(), file), 'utf8');
      return parseFixtureEvalCasesJsonl(content);
    })
  );

  return suites.flat();
}

async function readGitMetadata(): Promise<{ sha?: string; branch?: string }> {
  const [sha, branch] = await Promise.all([readGitValue(['rev-parse', 'HEAD']), readGitValue(['rev-parse', '--abbrev-ref', 'HEAD'])]);
  return {
    sha,
    branch
  };
}

async function readGitValue(args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: process.cwd()
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

