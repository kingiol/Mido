import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createManagedMcpConnection,
  createManagedMcpHttpClientTools,
  createManagedMcpHttpConnection,
  refreshMcpClientTools,
  registerManagedMcpHttpClientTools
} from '@mido/client-web';
import type { SearchWebProvider } from '../packages/toolkit-core/src/index.js';

import { createDemoToolkitTools } from '../apps/web-demo/demo-toolkit.js';

describe('web demo MCP lifecycle wiring', () => {
  it('uses managed MCP registration in the browser demo', async () => {
    const source = await readFile(new URL('../apps/web-demo/src/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('registerManagedMcpHttpClientTools');
    expect(source).not.toContain('registerMcpHttpClientTools');
  });

  it('uses managed MCP registration in the server demo', async () => {
    const source = await readFile(new URL('../apps/web-demo/server.ts', import.meta.url), 'utf8');

    expect(source).toContain('registerManagedMcpHttpServerTools');
    expect(source).not.toContain('registerMcpHttpServerTools');
  });

  it('lets the browser demo proxy target a custom API server port', async () => {
    const source = await readFile(new URL('../apps/web-demo/vite.config.ts', import.meta.url), 'utf8');

    expect(source).toContain('MIDO_DEMO_API_TARGET');
  });

  it('registers toolkit-core server tools in the demo', async () => {
    const source = await readFile(new URL('../apps/web-demo/server.ts', import.meta.url), 'utf8');

    expect(source).toContain('registerDemoToolkitTools');
    expect(source).toContain('buildDemoSystemPrompt(amapMcp, demoToolkit)');
  });

  it('registers server multi-agent tools in the demo', async () => {
    const source = await readFile(new URL('../apps/web-demo/server.ts', import.meta.url), 'utf8');

    expect(source).toContain('createAgentTool');
    expect(source).toContain('createAgentWorkflowTool');
    expect(source).toContain('demoResearchAgent');
    expect(source).toContain('runAgentWorkflow');
    expect(source).toContain('registerDemoAgentTools(runner)');
  });

  it('creates a safe demo toolkit surface for the server agent loop', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(testDir, '..');
    const tools = createDemoToolkitTools({ projectRoot });
    const names = tools.map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'workspace_list',
      'workspace_search',
      'workspace_read_file',
      'workspace_stat',
      'search_web',
      'fetch_url',
      'read_document',
      'retrieval_index',
      'retrieval_query',
      'memory_list_scopes',
      'memory_search',
      'memory_read',
      'memory_write',
      'memory_delete'
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      'workspace_apply_patch',
      'workspace_write_file',
      'workspace_run_command',
      'browser_open'
    ]));
    expect(new Set(names).size).toBe(names.length);
    expect(tools.every(tool => tool.executionPolicy === 'server')).toBe(true);
    expect(tools.every(tool => typeof tool.execute === 'function')).toBe(true);
  });

  it('wires demo search_web to the configured search provider', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(testDir, '..');
    const requests: unknown[] = [];
    const searchProvider: SearchWebProvider = async request => {
      requests.push(request);
      return {
        results: [
          {
            title: 'Mido search result',
            url: 'https://example.com/mido-search',
            snippet: `result for ${request.query}`,
            source: 'test'
          }
        ]
      };
    };
    const tools = createDemoToolkitTools({ projectRoot, searchProvider });
    const search = tools.find(tool => tool.name === 'search_web');

    await expect(search?.execute?.({ query: 'mido sdk', limit: 2, recencyDays: 7 }, {
      runId: 'run-demo-search',
      state: {},
      messages: []
    })).resolves.toMatchObject({
      results: [
        {
          title: 'Mido search result',
          url: 'https://example.com/mido-search',
          snippet: 'result for mido sdk',
          source: 'test'
        }
      ]
    });
    expect(requests).toEqual([
      {
        query: 'mido sdk',
        limit: 2,
        recencyDays: 7
      }
    ]);
  });

  it('returns a fallback search result when the demo search provider gets an empty response', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(testDir, '..');
    const tools = createDemoToolkitTools({
      projectRoot,
      fetch: async () => new Response('', { status: 202 })
    });
    const search = tools.find(tool => tool.name === 'search_web');

    await expect(search?.execute?.({ query: 'mido sdk', limit: 1 }, {
      runId: 'run-demo-search-fallback',
      state: {},
      messages: []
    })).resolves.toMatchObject({
      results: [
        {
          title: 'Search DuckDuckGo for "mido sdk"',
          url: 'https://duckduckgo.com/?q=mido+sdk',
          source: 'duckduckgo',
          metadata: {
            reason: 'empty response'
          }
        }
      ]
    });
  });

  it('adds toolkit quick prompts to the browser demo', async () => {
    const source = await readFile(new URL('../apps/web-demo/src/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('Toolkit Workspace');
    expect(source).toContain('workspace_search');
    expect(source).toContain('Toolkit Search');
    expect(source).toContain('search_web');
    expect(source).toContain('Toolkit Memory');
    expect(source).toContain('memory_write');
  });

  it('exports managed MCP helpers from client-web', () => {
    expect(typeof createManagedMcpConnection).toBe('function');
    expect(typeof createManagedMcpHttpClientTools).toBe('function');
    expect(typeof createManagedMcpHttpConnection).toBe('function');
    expect(typeof refreshMcpClientTools).toBe('function');
    expect(typeof registerManagedMcpHttpClientTools).toBe('function');
  });
});
