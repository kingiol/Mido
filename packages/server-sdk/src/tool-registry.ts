import { normalizeToolDefinition, type ToolDefinition } from '@mido-agent/protocol-core';

export type RegisteredToolDefinition = ToolDefinition & Required<Pick<ToolDefinition, 'toolId' | 'modelName'>>;

export class ToolRegistry {
  private readonly byId = new Map<string, RegisteredToolDefinition>();
  private readonly byModelName = new Map<string, RegisteredToolDefinition>();

  register(definition: ToolDefinition): RegisteredToolDefinition {
    const normalized = normalizeToolDefinition(definition);
    if (this.byId.has(normalized.toolId)) {
      throw new Error(`Tool id "${normalized.toolId}" is already registered`);
    }

    if (this.byModelName.has(normalized.modelName)) {
      throw new Error(`Tool modelName "${normalized.modelName}" is already registered`);
    }

    this.byId.set(normalized.toolId, normalized);
    this.byModelName.set(normalized.modelName, normalized);
    return normalized;
  }

  get(toolId: string): RegisteredToolDefinition | undefined {
    return this.byId.get(toolId);
  }

  getByModelName(modelName: string): RegisteredToolDefinition | undefined {
    return this.byModelName.get(modelName);
  }

  getByName(name: string): RegisteredToolDefinition | undefined {
    const matches = [...this.byId.values()].filter(definition => definition.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  list(): RegisteredToolDefinition[] {
    return [...this.byId.values()];
  }
}
