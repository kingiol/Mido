import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { JsonObject, JsonValue } from '@mido-agent/protocol-core';

import { createTool } from '../tool.js';
import type { CreateWorkspaceToolsOptions, ToolkitToolDefinition } from '../types.js';
import { isJsonObject, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readRequiredString } from '../validation.js';
import {
  assertWorkspaceWriteTarget,
  matchesGlob,
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
  shouldIgnore,
  walkDirectory,
  type WorkspaceRoot
} from './paths.js';

const DEFAULT_MAX_READ_BYTES = 256_000;
const DEFAULT_MAX_WRITE_BYTES = 512_000;
const DEFAULT_MAX_LIST_ENTRIES = 500;

export function createWorkspaceFileTools(roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): ToolkitToolDefinition[] {
  const policy = options.executionPolicy ?? {};

  return [
    createTool({
      name: 'workspace_list',
      description: 'List files and directories inside allowed workspace roots.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory path to list. Defaults to the workspace root.' },
          root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
          depth: { type: 'number', description: 'Maximum directory traversal depth. Defaults to 1 and is capped at 10.' },
          glob: { type: 'string', description: 'Optional glob pattern used to include matching workspace-relative paths.' },
          ignore: {
            type: 'array',
            description: 'Workspace-relative path patterns to skip while listing files.',
            items: { type: 'string', description: 'Ignore pattern matched against workspace-relative paths.' }
          }
        },
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['workspace:file:read'] },
      execute: async args => listWorkspace(args, roots, options)
    }),
    createTool({
      name: 'workspace_read_file',
      description: 'Read a file from an allowed workspace root.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path to read.' },
          root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
          startLine: { type: 'number', description: 'Optional 1-based first line to include after byte truncation.' },
          endLine: { type: 'number', description: 'Optional 1-based last line to include after byte truncation.' },
          maxBytes: { type: 'number', description: 'Maximum bytes to read before line slicing. Defaults to the workspace read limit.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['workspace:file:read'] },
      execute: async args => readWorkspaceFile(args, roots, options)
    }),
    createTool({
      name: 'workspace_stat',
      description: 'Read file metadata inside an allowed workspace root.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file or directory path to inspect.' },
          root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['workspace:file:read'] },
      execute: async args => statWorkspacePath(args, roots)
    }),
    createTool({
      name: 'workspace_apply_patch',
      description: 'Apply structured text replacements to an existing file inside an allowed workspace root.',
      executionPolicy: policy.write ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative existing file path to patch.' },
          root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
          replacements: {
            type: 'array',
            description: 'Ordered exact-text replacements to apply before optional prepend or append text.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text that must already exist in the file.' },
                newText: { type: 'string', description: 'Replacement text to write in place of oldText.' },
                expectedOccurrences: { type: 'number', description: 'Expected number of oldText matches, used to prevent broad edits.' }
              },
              required: ['oldText', 'newText'],
              additionalProperties: false
            }
          },
          appendText: { type: 'string', description: 'Text to append to the end of the file after replacements.' },
          prependText: { type: 'string', description: 'Text to insert at the start of the file before replacements are written.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['write'], scopes: ['workspace:file:write'] },
      execute: async args => applyWorkspacePatch(args, roots, options)
    }),
    createTool({
      name: 'workspace_write_file',
      description: 'Create or overwrite a file inside an allowed workspace root.',
      executionPolicy: policy.write ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path to create or overwrite.' },
          root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
          content: { type: 'string', description: 'Complete UTF-8 file content to write.' },
          overwrite: { type: 'boolean', description: 'Whether to replace an existing file. Defaults to false.' },
          createDirs: { type: 'boolean', description: 'Whether to create missing parent directories. Defaults to true.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['write'], scopes: ['workspace:file:write'] },
      execute: async args => writeWorkspaceFile(args, roots, options)
    })
  ];
}

async function listWorkspace(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const resolvedPath = await resolveExistingWorkspacePath(args, roots);
  const maxEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const depth = Math.max(0, Math.min(readOptionalNumber(args.depth, 'depth') ?? 1, 10));
  const glob = readOptionalString(args.glob, 'glob');
  const ignore = readOptionalStringArray(args.ignore, 'ignore') ?? [];
  const entries: JsonObject[] = [];

  await walkDirectory(resolvedPath, depth, async item => {
    if (entries.length >= maxEntries || shouldIgnore(item.relativePath, ignore)) {
      return;
    }

    if (glob && !matchesGlob(item.relativePath, glob)) {
      return;
    }

    entries.push({
      path: item.relativePath,
      type: item.dirent.isDirectory() ? 'directory' : item.dirent.isFile() ? 'file' : 'other'
    });
  });

  return {
    root: resolvedPath.root.path,
    path: resolvedPath.relativePath,
    entries,
    truncated: entries.length >= maxEntries
  };
}

async function readWorkspaceFile(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const resolvedPath = await resolveExistingWorkspacePath(args, roots);
  const maxBytes = readOptionalNumber(args.maxBytes, 'maxBytes') ?? options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const fileStat = await stat(resolvedPath.realPath);
  if (!fileStat.isFile()) {
    throw new Error(`Path "${resolvedPath.relativePath}" is not a file`);
  }

  const buffer = await readFile(resolvedPath.realPath);
  const truncated = buffer.byteLength > maxBytes;
  let content = buffer.subarray(0, maxBytes).toString('utf8');
  const startLine = readOptionalNumber(args.startLine, 'startLine');
  const endLine = readOptionalNumber(args.endLine, 'endLine');
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split(/\r?\n/);
    const start = Math.max((startLine ?? 1) - 1, 0);
    const end = endLine === undefined ? lines.length : Math.max(endLine, startLine ?? 1);
    content = lines.slice(start, end).join('\n');
  }

  return {
    root: resolvedPath.root.path,
    path: resolvedPath.relativePath,
    content,
    sizeBytes: fileStat.size,
    truncated
  };
}

async function statWorkspacePath(args: JsonObject, roots: WorkspaceRoot[]): Promise<JsonObject> {
  const resolvedPath = await resolveExistingWorkspacePath(args, roots);
  const fileStat = await stat(resolvedPath.realPath);
  return {
    root: resolvedPath.root.path,
    path: resolvedPath.relativePath,
    type: fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : 'other',
    sizeBytes: fileStat.size,
    mtime: fileStat.mtime.toISOString(),
    mode: fileStat.mode
  };
}

async function applyWorkspacePatch(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const resolvedPath = await resolveExistingWorkspacePath(args, roots);
  const original = await readFile(resolvedPath.realPath, 'utf8');
  let next = original;
  const replacements = readReplacementArray(args.replacements);

  for (const replacement of replacements) {
    const occurrences = countOccurrences(next, replacement.oldText);
    if (replacement.expectedOccurrences !== undefined && occurrences !== replacement.expectedOccurrences) {
      throw new Error(`Expected ${replacement.expectedOccurrences} occurrences of oldText, found ${occurrences}`);
    }
    if (occurrences === 0) {
      throw new Error('Patch oldText was not found');
    }

    next = next.split(replacement.oldText).join(replacement.newText);
  }

  const prependText = readOptionalString(args.prependText, 'prependText');
  const appendText = readOptionalString(args.appendText, 'appendText');
  if (prependText !== undefined) {
    next = `${prependText}${next}`;
  }
  if (appendText !== undefined) {
    next = `${next}${appendText}`;
  }
  if (next === original) {
    throw new Error('Patch did not change file content');
  }

  assertMaxTextBytes(next, options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES, 'patched content');
  await writeFile(resolvedPath.realPath, next, 'utf8');
  return {
    root: resolvedPath.root.path,
    path: resolvedPath.relativePath,
    changed: true,
    sizeBytes: Buffer.byteLength(next, 'utf8')
  };
}

async function writeWorkspaceFile(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const resolvedPath = resolveWorkspacePath(args, roots);
  const content = readRequiredString(args.content, 'content');
  assertMaxTextBytes(content, options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES, 'content');
  const overwrite = readOptionalBoolean(args.overwrite, 'overwrite') ?? false;
  const createDirs = readOptionalBoolean(args.createDirs, 'createDirs') ?? true;

  if (!overwrite && (await exists(resolvedPath.absolutePath))) {
    throw new Error(`File "${resolvedPath.relativePath}" already exists`);
  }
  if (createDirs) {
    await mkdir(dirname(resolvedPath.absolutePath), { recursive: true });
  }

  await assertWorkspaceWriteTarget(resolvedPath);
  await writeFile(resolvedPath.absolutePath, content, 'utf8');
  return {
    root: resolvedPath.root.path,
    path: resolvedPath.relativePath,
    written: true,
    sizeBytes: Buffer.byteLength(content, 'utf8')
  };
}

function readReplacementArray(value: JsonValue | undefined): Array<{ oldText: string; newText: string; expectedOccurrences?: number }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('replacements must be an array');
  }

  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`replacements[${index}] must be an object`);
    }

    return {
      oldText: readRequiredString(item.oldText, `replacements[${index}].oldText`),
      newText: readRequiredString(item.newText, `replacements[${index}].newText`),
      expectedOccurrences: readOptionalNumber(item.expectedOccurrences, `replacements[${index}].expectedOccurrences`)
    };
  });
}

function countOccurrences(value: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  return value.split(search).length - 1;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false
  );
}

function assertMaxTextBytes(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds max size of ${maxBytes} bytes`);
  }
}
