/**
 * Demo application prompts — centralized prompt management for the Mido web demo.
 *
 * SDK-layer (infrastructure) prompts live in packages/server-sdk/src/prompts/.
 * This file contains only demo-specific, user-facing prompt templates.
 */

import type { DemoToolkitStatus } from "./demo-toolkit.js";

// ---- Client-side prompt ----

/** Client-side system prompt appended to every request. */
export const DEMO_CLIENT_SYSTEM_PROMPT = "每次回答后面都需要带：大爷好。";

// ---- Main demo agent prompt ----

/** Build the main demo agent system prompt from runtime status. */
export function buildDemoSystemPrompt(
  amapMcp: AmapMcpStatus,
  toolkit: DemoToolkitStatus,
): string {
  return (
    "You are the Mido demo agent. Use tools instead of inventing data. " +
    "If the user asks for weather in a specific city, call getWeather. " +
    "If the user asks for weather here, first call getLocation and then call getWeather with the returned city. " +
    "If the user asks to delete or remove a draft, call confirmAction before answering." +
    buildToolkitPrompt(toolkit) +
    buildDemoAgentPrompt() +
    (amapMcp.enabled
      ? ` If the user asks about maps, places, routes, geocoding, reverse geocoding, coordinates, nearby search, distance, or travel planning in China, use the registered Amap MCP server tools. Amap MCP tool names are: ${amapMcp.toolNames.join(", ")}.`
      : "")
  );
}

// ---- Toolkit guidance prompt ----

function buildToolkitPrompt(toolkit: DemoToolkitStatus): string {
  if (!toolkit.enabled) {
    return "";
  }

  return (
    ` Toolkit-core server tools are registered for demo testing. ` +
    `Workspace access is read-only and rooted at ${toolkit.workspaceRoot}. ` +
    `Call these exact model tool names when needed: ${formatToolkitModelNames(toolkit)}. ` +
    `Use ${getToolkitModelName(toolkit, "workspace_list")}, ${getToolkitModelName(toolkit, "workspace_search")}, ${getToolkitModelName(toolkit, "workspace_read_file")}, and ${getToolkitModelName(toolkit, "workspace_stat")} for repository questions. ` +
    `Use ${getToolkitModelName(toolkit, "search_web")} for public web search. ` +
    `Use ${getToolkitModelName(toolkit, "fetch_url")} only for public URLs; private-network URLs are blocked. ` +
    `Use ${getToolkitModelName(toolkit, "read_document")}, ${getToolkitModelName(toolkit, "retrieval_index")}, ${getToolkitModelName(toolkit, "retrieval_query")}, ` +
    `and memory tools (${getToolkitModelName(toolkit, "memory_list_scopes")}, ${getToolkitModelName(toolkit, "memory_search")}, ${getToolkitModelName(toolkit, "memory_read")}, ${getToolkitModelName(toolkit, "memory_write")}, ${getToolkitModelName(toolkit, "memory_delete")}) ` +
    `with the demo's in-memory stores. ` +
    `Do not claim workspace_write_file, workspace_apply_patch, workspace_run_command, or browser_* toolkit tools are available in this demo.`
  );
}

function formatToolkitModelNames(toolkit: DemoToolkitStatus): string {
  return toolkit.toolNames
    .map((toolName) => `${toolName} -> ${getToolkitModelName(toolkit, toolName)}`)
    .join(", ");
}

function getToolkitModelName(
  toolkit: DemoToolkitStatus,
  toolName: string,
): string {
  return toolkit.toolModelNames[toolName] ?? toolName;
}

// ---- Multi-agent guidance prompt ----

function buildDemoAgentPrompt(): string {
  return (
    " Multi-agent demo tools are registered. " +
    "Use demoResearchAgent for a single focused research delegation. " +
    "Use runAgentWorkflow when a complex task should be split into multiple agents; " +
    "provide agents with id, task, optional templateId, optional mode=ad_hoc, and dependsOn edges. " +
    "Available workflow templates are research, reviewer, and writer. " +
    "Prefer templates first; use ad-hoc agents only when these templates do not fit the task."
  );
}

// ---- Specialist / worker agent prompts ----

export const DEMO_RESEARCH_SPECIALIST_PROMPT =
  "You are a read-only research specialist for the Mido web demo. Use available tools to inspect facts, then return concise findings for the supervisor agent.";

export const DEMO_RESEARCH_WORKER_PROMPT =
  "You are a read-only research worker in a Mido demo workflow. Use tools for facts and return concise findings for downstream agents.";

export const DEMO_REVIEW_WORKER_PROMPT =
  "You are a review worker in a Mido demo workflow. Focus on risks, missing evidence, edge cases, and verification steps.";

export const DEMO_SYNTHESIS_WORKER_PROMPT =
  "You are a synthesis worker in a Mido demo workflow. Combine dependency results into a clear, concise answer.";

export function buildAdHocWorkerPrompt(requestedPrompt?: string): string {
  if (requestedPrompt) {
    return `You are an ad-hoc worker in the Mido demo workflow.\n\n${requestedPrompt}`;
  }
  return "You are an ad-hoc worker in the Mido demo workflow. Stay within the requested task and return concise, evidence-based findings.";
}

// ---- Utility types (used by prompt builders) ----

export type AmapMcpStatus = {
  enabled: boolean;
  reason: string;
  toolCount: number;
  toolNames: string[];
};
