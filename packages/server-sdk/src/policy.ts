import type { JsonObject, JsonValue, ToolDefinition } from '@mido/protocol-core';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'destructive';
export type DefaultToolPolicyMode = 'permissive' | 'balanced' | 'strict';
export type ToolPolicyAction = 'tool.expose' | 'tool.execute' | 'tool.resume';

export type ToolPolicyMetadata = {
  risk?: ToolRiskLevel;
  effects?: string[];
  scopes?: string[];
  [key: string]: JsonValue | undefined;
};

export interface ToolPolicyContext {
  action: ToolPolicyAction;
  runId: string;
  threadId?: string;
  tool: ToolDefinition;
  args?: JsonObject;
  state: JsonObject;
  metadata?: JsonObject;
}

export type ToolPolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; code: string; reason: string }
  | { type: 'require_confirmation'; level: 'user' | 'strong'; code?: string; reason: string };

export type ToolPolicyProvider = (context: ToolPolicyContext) => Promise<ToolPolicyDecision> | ToolPolicyDecision;

export interface DefaultToolPolicyOptions {
  mode?: DefaultToolPolicyMode;
}

const destructiveEffects = new Set(['delete', 'export', 'send', 'pay', 'permission', 'config']);

export function createDefaultToolPolicy(options: DefaultToolPolicyOptions = {}): ToolPolicyProvider {
  const mode = options.mode ?? 'balanced';

  return context => {
    if (mode === 'permissive') {
      return { type: 'allow' };
    }

    const policy = getToolPolicyMetadata(context.tool);
    if (!policy) {
      return mode === 'strict'
        ? {
            type: 'deny',
            code: 'tool_policy_missing',
            reason: `Tool "${context.tool.name}" is missing policy metadata`
          }
        : { type: 'allow' };
    }

    if (context.tool.executionPolicy === 'client_interactive') {
      return { type: 'allow' };
    }

    if (isDestructivePolicy(policy)) {
      return {
        type: 'deny',
        code: 'tool_policy_denied',
        reason: `Tool "${context.tool.name}" requires an interactive confirmation policy`
      };
    }

    if (mode === 'strict' && isMediumRiskPolicy(policy)) {
      return {
        type: 'deny',
        code: 'tool_policy_denied',
        reason: `Tool "${context.tool.name}" is not low risk`
      };
    }

    return { type: 'allow' };
  };
}

export function getToolPolicyMetadata(tool: ToolDefinition): ToolPolicyMetadata | undefined {
  const rawPolicy = tool.metadata?.policy;
  if (!isJsonObject(rawPolicy)) {
    return undefined;
  }

  const policy: ToolPolicyMetadata = {};
  if (isRiskLevel(rawPolicy.risk)) {
    policy.risk = rawPolicy.risk;
  }

  const effects = readStringArray(rawPolicy.effects);
  if (effects) {
    policy.effects = effects;
  }

  const scopes = readStringArray(rawPolicy.scopes);
  if (scopes) {
    policy.scopes = scopes;
  }

  return policy;
}

function isDestructivePolicy(policy: ToolPolicyMetadata): boolean {
  if (policy.risk === 'high' || policy.risk === 'destructive') {
    return true;
  }

  return (policy.effects ?? []).some(effect => destructiveEffects.has(effect));
}

function isMediumRiskPolicy(policy: ToolPolicyMetadata): boolean {
  return policy.risk === 'medium' || policy.risk === 'high' || policy.risk === 'destructive' || (policy.effects ?? []).some(effect => effect !== 'read');
}

function isRiskLevel(value: JsonValue | undefined): value is ToolRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'destructive';
}

function readStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    return undefined;
  }

  return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
