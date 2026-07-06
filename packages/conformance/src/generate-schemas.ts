import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coreProtocolSchemas } from '@mido-agent/protocol-core';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const outputDir = path.resolve(currentDir, '../schemas');

async function main() {
  await mkdir(outputDir, { recursive: true });

  await Promise.all(
    Object.entries(coreProtocolSchemas).map(async ([name, schema]) => {
      const outputPath = path.join(outputDir, `${name}.schema.json`);
      await writeFile(outputPath, JSON.stringify(schema, null, 2));
    })
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
