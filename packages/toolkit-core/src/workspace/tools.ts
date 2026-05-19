import type { CreateWorkspaceToolsOptions, ToolkitToolDefinition } from '../types.js';
import { createWorkspaceCommandTool } from './command.js';
import { createWorkspaceFileTools } from './files.js';
import { createWorkspaceRoots } from './paths.js';
import { createWorkspaceSearchTool } from './search.js';

export function createWorkspaceTools(options: CreateWorkspaceToolsOptions): ToolkitToolDefinition[] {
  const roots = createWorkspaceRoots(options.roots, options.defaultRoot);

  return [
    ...createWorkspaceFileTools(roots, options),
    createWorkspaceSearchTool(roots, options),
    createWorkspaceCommandTool(roots, options)
  ];
}
