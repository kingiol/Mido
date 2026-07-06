import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { JSONSchema } from '@mido-agent/protocol-core';

import {
  createBrowserAutomationTools,
  createMemoryTools,
  createSearchAndRetrievalTools,
  createWorkspaceTools,
  InMemoryMemoryStore,
  InMemoryRetrievalStore
} from './index.js';

describe('workspace tools', () => {
  it('documents model-visible input parameters', () => {
    const tools = [
      ...createWorkspaceTools({ roots: ['/tmp/project'] }),
      ...createMemoryTools(),
      ...createSearchAndRetrievalTools(),
      ...createBrowserAutomationTools({
        open: () => ({}),
        snapshot: () => ({}),
        click: () => ({}),
        type: () => ({}),
        wait: () => ({}),
        screenshot: () => ({}),
        extract: () => ({})
      })
    ];

    expectToolInputSchemasToBeDocumented(tools);
  });

  it('reads files only inside the allowed workspace roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mido-workspace-'));
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf8');

    const tools = createWorkspaceTools({ roots: [root] });
    const readFileTool = tools.find(tool => tool.name === 'workspace_read_file');

    await expect(readFileTool?.execute?.({ path: 'notes.txt' })).resolves.toMatchObject({
      path: 'notes.txt',
      content: 'hello workspace',
      truncated: false
    });
    await expect(readFileTool?.execute?.({ path: '../outside.txt' })).rejects.toThrow('outside allowed workspace roots');
  });

  it('rejects symlinks that resolve outside the allowed workspace roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mido-workspace-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside.txt');
    await mkdir(root);
    await writeFile(outside, 'outside secret', 'utf8');
    await symlink(outside, join(root, 'link.txt'));

    const tools = createWorkspaceTools({ roots: [root] });
    const readFileTool = tools.find(tool => tool.name === 'workspace_read_file');

    await expect(readFileTool?.execute?.({ path: 'link.txt' })).rejects.toThrow('outside allowed workspace roots');
  });

  it('rejects command cwd symlinks that resolve outside the allowed workspace roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mido-workspace-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'outside-link'));

    const tools = createWorkspaceTools({ roots: [root], commandAllowlist: [process.execPath] });
    const commandTool = tools.find(tool => tool.name === 'workspace_run_command');

    await expect(
      commandTool?.execute?.({
        command: process.execPath,
        args: ['-e', 'console.log(process.cwd())'],
        cwd: 'outside-link'
      })
    ).rejects.toThrow('outside allowed workspace roots');
  });

  it('marks write and command tools with high-risk policy metadata', () => {
    const tools = createWorkspaceTools({ roots: ['/tmp/project'] });

    expect(tools.find(tool => tool.name === 'workspace_apply_patch')?.metadata?.policy).toMatchObject({
      risk: 'high',
      effects: ['write'],
      scopes: ['workspace:file:write']
    });
    expect(tools.find(tool => tool.name === 'workspace_run_command')?.executionPolicy).toBe('client_interactive');
    expect(tools.find(tool => tool.name === 'workspace_run_command')?.metadata?.policy).toMatchObject({
      risk: 'high',
      effects: ['execute'],
      scopes: ['workspace:command:run']
    });
  });
});

function expectToolInputSchemasToBeDocumented(tools: Array<{ name: string; inputSchema: JSONSchema }>) {
  for (const tool of tools) {
    const schema = asSchemaObject(tool.inputSchema, `${tool.name}.inputSchema`);
    expect(schema.type, `${tool.name}.inputSchema.type`).toBe('object');

    if (!('properties' in schema)) {
      expect(schema.additionalProperties, `${tool.name}.inputSchema.additionalProperties`).toBe(false);
      continue;
    }

    expectPropertiesToBeDocumented(schema.properties, `${tool.name}.inputSchema.properties`);
  }
}

function expectPropertiesToBeDocumented(properties: unknown, path: string) {
  expect(isRecord(properties), `${path} should be an object`).toBe(true);
  for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
    const propertySchema = asSchemaObject(property, `${path}.${name}`);
    expect(typeof propertySchema.description, `${path}.${name}.description`).toBe('string');
    expect(String(propertySchema.description).trim().length, `${path}.${name}.description`).toBeGreaterThan(0);
    expectNestedPropertiesToBeDocumented(propertySchema, `${path}.${name}`);
  }
}

function expectNestedPropertiesToBeDocumented(schema: Record<string, unknown>, path: string) {
  if (isRecord(schema.properties)) {
    expectPropertiesToBeDocumented(schema.properties, `${path}.properties`);
  }

  if (isRecord(schema.items)) {
    const items = schema.items as Record<string, unknown>;
    if (isRecord(items.properties)) {
      expectPropertiesToBeDocumented(items.properties, `${path}.items.properties`);
    }
  }
}

function asSchemaObject(value: unknown, path: string): Record<string, unknown> {
  expect(isRecord(value), `${path} should be an object schema`).toBe(true);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('memory tools', () => {
  it('writes, searches, reads, and deletes scoped memory entries', async () => {
    const store = new InMemoryMemoryStore();
    const tools = createMemoryTools({ store });
    const write = tools.find(tool => tool.name === 'memory_write');
    const search = tools.find(tool => tool.name === 'memory_search');
    const read = tools.find(tool => tool.name === 'memory_read');
    const remove = tools.find(tool => tool.name === 'memory_delete');

    const written = await write?.execute?.({
      scope: 'project:mido',
      text: 'Prefer provider-neutral tool packages.',
      reason: 'project convention',
      sourceRunId: 'run_1'
    });

    expect(written).toMatchObject({ scope: 'project:mido', text: 'Prefer provider-neutral tool packages.' });
    const entryId = (written as { id: string }).id;

    await expect(search?.execute?.({ scope: 'project:mido', query: 'provider neutral' })).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: entryId })]
    });
    await expect(read?.execute?.({ scope: 'project:mido', id: entryId })).resolves.toMatchObject({
      id: entryId,
      text: 'Prefer provider-neutral tool packages.'
    });
    await expect(remove?.execute?.({ scope: 'project:mido', id: entryId })).resolves.toEqual({
      deleted: true,
      id: entryId,
      scope: 'project:mido'
    });
  });
});

describe('search and retrieval tools', () => {
  it('uses adapters for web search and indexes retrievable documents', async () => {
    const store = new InMemoryRetrievalStore();
    const tools = createSearchAndRetrievalTools({
      store,
      searchProvider: async ({ query }) => ({
        results: [
          {
            title: 'Mido docs',
            url: 'https://example.com/mido',
            snippet: `result for ${query}`,
            fetchedAt: '2026-05-07T00:00:00.000Z'
          }
        ]
      })
    });
    const search = tools.find(tool => tool.name === 'search_web');
    const index = tools.find(tool => tool.name === 'retrieval_index');
    const query = tools.find(tool => tool.name === 'retrieval_query');

    await expect(search?.execute?.({ query: 'tool policy' })).resolves.toMatchObject({
      results: [expect.objectContaining({ title: 'Mido docs' })]
    });
    await index?.execute?.({
      namespace: 'docs',
      documents: [
        {
          id: 'roadmap',
          text: 'Browser automation and workspace tools need policy metadata.',
          source: 'docs/agent-capability-roadmap.md'
        }
      ]
    });

    await expect(query?.execute?.({ namespace: 'docs', query: 'workspace policy' })).resolves.toMatchObject({
      results: [expect.objectContaining({ id: 'roadmap', score: expect.any(Number) })]
    });
  });

  it('blocks private-network URL fetches before calling the fetch adapter', async () => {
    const calls: string[] = [];
    const tools = createSearchAndRetrievalTools({
      fetch: async input => {
        calls.push(String(input));
        return new Response('ok');
      }
    });
    const fetchUrl = tools.find(tool => tool.name === 'fetch_url');

    await expect(fetchUrl?.execute?.({ url: 'http://[::1]/' })).rejects.toThrow('private-network URL');
    await expect(fetchUrl?.execute?.({ url: 'http://169.254.169.254/' })).rejects.toThrow('private-network URL');
    await expect(fetchUrl?.execute?.({ url: 'http://0.0.0.0/' })).rejects.toThrow('private-network URL');
    expect(calls).toEqual([]);
  });
});

describe('browser automation tools', () => {
  it('wraps browser adapters with interactive tool definitions', async () => {
    const calls: string[] = [];
    const tools = createBrowserAutomationTools({
      open: async ({ url }) => {
        calls.push(`open:${url}`);
        return { pageId: 'page_1', url, title: 'Example' };
      },
      snapshot: async () => ({ pageId: 'page_1', url: 'https://example.com', title: 'Example', text: 'Hello' }),
      click: async ({ target }) => {
        calls.push(`click:${target}`);
        return { clicked: true };
      },
      type: async ({ target, text }) => {
        calls.push(`type:${target}:${text}`);
        return { typed: true };
      },
      wait: async () => ({ waited: true }),
      screenshot: async () => ({ mimeType: 'image/png', data: 'base64' }),
      extract: async () => ({ data: { value: 'hello' } })
    });
    const open = tools.find(tool => tool.name === 'browser_open');
    const click = tools.find(tool => tool.name === 'browser_click');

    await expect(open?.execute?.({ url: 'https://example.com' })).resolves.toMatchObject({ title: 'Example' });
    await expect(click?.execute?.({ target: 'button[name=save]' })).resolves.toEqual({ clicked: true });
    expect(calls).toEqual(['open:https://example.com', 'click:button[name=save]']);
    expect(click?.executionPolicy).toBe('client_interactive');
    expect(click?.metadata?.policy).toMatchObject({
      risk: 'high',
      effects: ['click'],
      scopes: ['browser:page:interact']
    });
  });
});
