import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluateEventStore } from './store.js';

interface StoreCliOptions {
  rootDir: string;
  outDir: string;
  suiteId: string;
  includeEvents: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await evaluateEventStore({
    rootDir: path.resolve(process.cwd(), options.rootDir),
    suiteId: options.suiteId,
    includeEvents: options.includeEvents
  });
  const outputDir = path.resolve(process.cwd(), options.outDir);
  await mkdir(outputDir, { recursive: true });

  const timestamp = result.createdAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `${result.suiteId}-${timestamp}.json`);
  const markdownPath = path.join(outputDir, `${result.suiteId}-${timestamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(markdownPath, result.markdown);

  console.log(result.markdown);
  console.log(`Scanned ${result.runs.length} event files from ${result.rootDir}`);
  console.log(`Wrote JSON report: ${jsonPath}`);
  console.log(`Wrote Markdown report: ${markdownPath}`);

  if (result.report.failedCaseCount > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): StoreCliOptions {
  const options: StoreCliOptions = {
    rootDir: '.mido-store',
    outDir: 'artifacts/evals',
    suiteId: 'mido-store',
    includeEvents: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--include-events') {
      options.includeEvents = true;
      continue;
    }

    if (arg === '--out-dir') {
      options.outDir = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--suite-id') {
      options.suiteId = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg?.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (arg) {
      options.rootDir = arg;
    }
  }

  return options;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

