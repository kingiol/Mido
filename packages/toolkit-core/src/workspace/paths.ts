import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { JsonObject } from '@mido-agent/protocol-core';

import { readOptionalString } from '../validation.js';

export interface WorkspaceRoot {
  path: string;
  name: string;
}

export interface ResolvedWorkspacePath {
  root: WorkspaceRoot;
  absolutePath: string;
  relativePath: string;
}

export interface ExistingWorkspacePath extends ResolvedWorkspacePath {
  realPath: string;
  realRoot: string;
}

export function createWorkspaceRoots(roots: string[], defaultRoot?: string): WorkspaceRoot[] {
  if (roots.length === 0) {
    throw new Error('createWorkspaceTools requires at least one root');
  }

  const normalizedRoots = roots.map(root => ({
    path: resolve(root),
    name: basename(resolve(root)) || resolve(root)
  }));
  if (!defaultRoot) {
    return normalizedRoots;
  }

  const selectedDefault = resolve(defaultRoot);
  const defaultIndex = normalizedRoots.findIndex(root => root.path === selectedDefault);
  if (defaultIndex < 0) {
    throw new Error('defaultRoot must be included in roots');
  }

  const [root] = normalizedRoots.splice(defaultIndex, 1);
  return [root, ...normalizedRoots];
}

export function resolveWorkspacePath(args: JsonObject, roots: WorkspaceRoot[]): ResolvedWorkspacePath {
  const rawPath = readOptionalString(args.path, 'path') ?? '.';
  const selectedRoot = selectWorkspaceRoot(readOptionalString(args.root, 'root'), roots);
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(selectedRoot.path, rawPath);
  const root = roots.find(item => isPathInside(candidate, item.path));
  if (!root) {
    throw new Error(`Path "${rawPath}" is outside allowed workspace roots`);
  }

  return {
    root,
    absolutePath: candidate,
    relativePath: toPosixPath(relative(root.path, candidate)) || '.'
  };
}

export async function resolveExistingWorkspacePath(args: JsonObject, roots: WorkspaceRoot[]): Promise<ExistingWorkspacePath> {
  const resolvedPath = resolveWorkspacePath(args, roots);
  const realRoot = await realpath(resolvedPath.root.path);
  const realTarget = await realpath(resolvedPath.absolutePath);
  assertRealPathInsideRoot(realTarget, realRoot, resolvedPath.relativePath);
  return {
    ...resolvedPath,
    realPath: realTarget,
    realRoot
  };
}

export async function assertWorkspaceWriteTarget(resolvedPath: ResolvedWorkspacePath): Promise<void> {
  const realRoot = await realpath(resolvedPath.root.path);
  try {
    const realTarget = await realpath(resolvedPath.absolutePath);
    assertRealPathInsideRoot(realTarget, realRoot, resolvedPath.relativePath);
    return;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const realParent = await realpath(dirname(resolvedPath.absolutePath));
  assertRealPathInsideRoot(realParent, realRoot, resolvedPath.relativePath);
}

export async function walkDirectory(
  start: ResolvedWorkspacePath,
  depth: number,
  onEntry: (entry: { absolutePath: string; relativePath: string; dirent: Dirent }) => Promise<void> | void
): Promise<void> {
  const dirents = await readdir(start.absolutePath, { withFileTypes: true });
  for (const dirent of dirents) {
    const absolutePath = join(start.absolutePath, dirent.name);
    const relativePath = toPosixPath(relative(start.root.path, absolutePath));
    await onEntry({ absolutePath, relativePath, dirent });

    if (depth > 0 && dirent.isDirectory()) {
      await walkDirectory({ root: start.root, absolutePath, relativePath }, depth - 1, onEntry);
    }
  }
}

export function shouldIgnore(path: string, ignore: string[]): boolean {
  return ignore.some(pattern => matchesGlob(path, pattern));
}

export function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

export function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function selectWorkspaceRoot(rootInput: string | undefined, roots: WorkspaceRoot[]): WorkspaceRoot {
  if (!rootInput) {
    return roots[0] as WorkspaceRoot;
  }

  const resolved = resolve(rootInput);
  const root = roots.find(item => item.path === resolved || item.name === rootInput);
  if (!root) {
    throw new Error(`Unknown workspace root "${rootInput}"`);
  }

  return root;
}

function assertRealPathInsideRoot(realTarget: string, realRoot: string, displayPath: string): void {
  if (!isPathInside(realTarget, realRoot)) {
    throw new Error(`Path "${displayPath}" is outside allowed workspace roots`);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
