import { createHash } from 'node:crypto';

import { buildRunTrace, stableStringify, type AgentMessage, type ToolDefinition } from '@mido/protocol-core';

import { calculateRunMetrics } from './metrics.js';
import type { BuildRunArtifactInput, EvalRunArtifact } from './types.js';

export function buildRunArtifact(input: BuildRunArtifactInput): EvalRunArtifact {
  const trace = buildRunTrace(input.events);
  const metrics = input.metrics ?? calculateRunMetrics(input.events);
  const requestHash = hashStableValue(input.request ?? null);
  const toolManifestHash = hashToolManifest(input.tools ?? []);
  const eventTraceHash = hashStableValue(input.events);
  const modelCapabilitiesHash = input.modelCapabilities === undefined ? undefined : hashStableValue(input.modelCapabilities);
  const systemPromptHash = input.systemPrompt === undefined ? undefined : hashStableValue(input.systemPrompt);

  return {
    schemaVersion: 'mido.run-artifact.v1',
    manifest: {
      runId: trace.runId,
      threadId: trace.threadId,
      traceId: input.events.find(event => event.trace?.traceId)?.trace?.traceId ?? trace.runId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      sdkVersion: input.sdkVersion,
      gitSha: input.git?.sha,
      gitBranch: input.git?.branch,
      provider: input.model?.provider ?? trace.modelCalls.find(call => call.provider)?.provider,
      model: input.model?.model ?? trace.modelCalls.find(call => call.model)?.model,
      adapterKind: input.adapterKind,
      requestHash,
      eventTraceHash,
      toolManifestHash,
      systemPromptHash,
      modelCapabilitiesHash,
      skillDigestList: input.skillRefs ?? []
    },
    trace,
    metrics,
    events: input.events,
    request: input.includePayload ? input.request : undefined,
    tools: input.includePayload ? input.tools : undefined,
    modelCapabilities: input.includePayload ? input.modelCapabilities : undefined
  };
}

export function hashMessages(messages: AgentMessage[]): string {
  return hashStableValue(messages);
}

export function hashToolManifest(tools: ToolDefinition[]): string {
  const manifest = tools
    .map(toSerializableToolDefinition)
    .sort((left, right) => `${left.modelName ?? ''}:${left.name}`.localeCompare(`${right.modelName ?? ''}:${right.name}`));

  return hashStableValue(manifest);
}

export function hashStableValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function toSerializableToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    toolId: tool.toolId,
    name: tool.name,
    modelName: tool.modelName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    resultSchema: tool.resultSchema,
    executionPolicy: tool.executionPolicy,
    timeoutMs: tool.timeoutMs,
    metadata: tool.metadata
  } as ToolDefinition;
}

