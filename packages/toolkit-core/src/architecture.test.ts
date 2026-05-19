import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createBrowserAutomationTools } from './browser.js';
import { createMemoryTools, InMemoryMemoryStore } from './memory.js';
import { createSearchAndRetrievalTools, InMemoryRetrievalStore } from './search-retrieval.js';
import { createWorkspaceTools } from './workspace.js';

describe('toolkit-core module architecture', () => {
  it('keeps each capability toolkit in its own module', () => {
    expect(createWorkspaceTools({ roots: ['/tmp/project'] }).map(tool => tool.name)).toContain('workspace_read_file');
    expect(createSearchAndRetrievalTools({ store: new InMemoryRetrievalStore() }).map(tool => tool.name)).toContain('retrieval_query');
    expect(createMemoryTools({ store: new InMemoryMemoryStore() }).map(tool => tool.name)).toContain('memory_search');
    expect(
      createBrowserAutomationTools({
        open: () => ({}),
        snapshot: () => ({}),
        click: () => ({}),
        type: () => ({}),
        wait: () => ({}),
        screenshot: () => ({}),
        extract: () => ({})
      }).map(tool => tool.name)
    ).toContain('browser_snapshot');
  });

  it('publishes capability-specific subpath exports', async () => {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      exports: Record<string, unknown>;
      scripts: Record<string, string>;
    };

    expect(Object.keys(packageJson.exports)).toEqual(
      expect.arrayContaining(['.', './browser', './memory', './search-retrieval', './workspace'])
    );
    expect(packageJson.scripts.build).toContain('src/browser.ts');
    expect(packageJson.scripts.build).toContain('src/workspace.ts');
  });

  it('keeps workspace implementation split by responsibility', async () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const modules = ['tools.ts', 'paths.ts', 'files.ts', 'search.ts', 'command.ts'];

    await Promise.all(modules.map(module => expect(readFile(join(srcDir, 'workspace', module), 'utf8')).resolves.toBeTruthy()));
  });
});
