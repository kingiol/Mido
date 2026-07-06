import { readFile, stat } from 'node:fs/promises';

import type { JsonObject } from '@mido-agent/protocol-core';

import { createTool } from '../tool.js';
import type { CreateWorkspaceToolsOptions, ToolkitToolDefinition } from '../types.js';
import { readOptionalNumber, readOptionalString, readRequiredString } from '../validation.js';
import { resolveExistingWorkspacePath, walkDirectory, type WorkspaceRoot } from './paths.js';

const DEFAULT_MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_SEARCH_FILE_BYTES = 256_000;

export function createWorkspaceSearchTool(roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): ToolkitToolDefinition {
  const policy = options.executionPolicy ?? {};

  return createTool({
    name: 'workspace_search',
    description: 'Search file paths and text content inside allowed workspace roots.',
    executionPolicy: policy.read ?? 'client_auto',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to find in workspace-relative paths, file contents, or both.' },
        path: { type: 'string', description: 'Workspace-relative directory path to search. Defaults to the workspace root.' },
        root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
        mode: {
          type: 'string',
          description: 'Search mode: "path" matches filenames, "content" matches file text, and "both" does both.',
          enum: ['path', 'content', 'both']
        },
        limit: { type: 'number', description: 'Maximum number of matches to return. Defaults to the configured search limit and is capped at 500.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: { risk: 'low', effects: ['read'], scopes: ['workspace:file:read'] },
    execute: async args => searchWorkspace(args, roots, options)
  });
}

async function searchWorkspace(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const query = readRequiredString(args.query, 'query');
  const mode = readOptionalString(args.mode, 'mode') ?? 'both';
  const resolvedPath = await resolveExistingWorkspacePath(args, roots);
  const limit = Math.min(readOptionalNumber(args.limit, 'limit') ?? options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS, 500);
  const maxFileBytes = options.maxSearchFileBytes ?? DEFAULT_MAX_SEARCH_FILE_BYTES;
  const results: JsonObject[] = [];

  await walkDirectory(resolvedPath, 50, async item => {
    if (results.length >= limit || !item.dirent.isFile()) {
      return;
    }

    if ((mode === 'path' || mode === 'both') && item.relativePath.toLowerCase().includes(query.toLowerCase())) {
      results.push({ path: item.relativePath, matchType: 'path' });
    }

    if (results.length >= limit || mode === 'path') {
      return;
    }

    const fileStat = await stat(item.absolutePath);
    if (fileStat.size > maxFileBytes) {
      return;
    }

    const content = await readFile(item.absolutePath, 'utf8').catch(() => undefined);
    if (!content) {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < limit; index += 1) {
      if (lines[index]?.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          path: item.relativePath,
          matchType: 'content',
          lineNumber: index + 1,
          line: lines[index].slice(0, 500)
        });
      }
    }
  });

  return {
    root: resolvedPath.root.path,
    query,
    results,
    truncated: results.length >= limit
  };
}
