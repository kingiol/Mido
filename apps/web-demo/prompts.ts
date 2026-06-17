/**
 * Demo application prompts — centralized prompt management for the Mido web demo.
 *
 * SDK-layer (infrastructure) prompts live in packages/server-sdk/src/prompts/.
 * This file contains only demo-specific, user-facing prompt templates.
 */

import {
  buildMidoAgentHarnessPrompt,
  type PromptSection,
} from "../../packages/server-sdk/src/index.js";
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
  return buildMidoAgentHarnessPrompt({
    identity:
      "You are the Mido demo agent. Use tools instead of inventing data.",
    toolNames: buildDemoAvailableToolNames(amapMcp, toolkit),
    applicationSections: [
      buildDemoToolRoutingSection(),
      buildToolkitPromptSection(toolkit),
      buildDemoAgentPromptSection(),
      buildAmapPromptSection(amapMcp),
    ],
  });
}

// ---- Toolkit guidance prompt ----

function buildToolkitPromptSection(toolkit: DemoToolkitStatus): PromptSection {
  if (!toolkit.enabled) {
    return {
      id: "demo-toolkit-tools",
      title: "Demo Toolkit Tools",
      body: [
        `Toolkit-core server tools are not registered: ${toolkit.reason}.`,
        "Do not claim workspace, search, retrieval, or memory toolkit tools are available in this run.",
      ],
    };
  }

  return {
    id: "demo-toolkit-tools",
    title: "Demo Toolkit Tools",
    body: [
      "Toolkit-core server tools are registered for demo testing.",
      `Workspace access is read-only and rooted at ${toolkit.workspaceRoot}.`,
      `Call these exact model tool names when needed: ${formatToolkitModelNames(toolkit)}.`,
      `Use ${getToolkitModelName(toolkit, "workspace_list")}, ${getToolkitModelName(toolkit, "workspace_search")}, ${getToolkitModelName(toolkit, "workspace_read_file")}, and ${getToolkitModelName(toolkit, "workspace_stat")} for repository questions.`,
      `Use ${getToolkitModelName(toolkit, "search_web")} for public web search.`,
      `Use ${getToolkitModelName(toolkit, "fetch_url")} only for public URLs; private-network URLs are blocked.`,
      `Use ${getToolkitModelName(toolkit, "read_document")}, ${getToolkitModelName(toolkit, "retrieval_index")}, ${getToolkitModelName(toolkit, "retrieval_query")}, and memory tools (${getToolkitModelName(toolkit, "memory_list_scopes")}, ${getToolkitModelName(toolkit, "memory_search")}, ${getToolkitModelName(toolkit, "memory_read")}, ${getToolkitModelName(toolkit, "memory_write")}, ${getToolkitModelName(toolkit, "memory_delete")}) with the demo's in-memory stores.`,
      "Do not claim workspace_write_file, workspace_apply_patch, workspace_run_command, or browser_* toolkit tools are available in this demo.",
    ],
  };
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

function buildDemoToolRoutingSection(): PromptSection {
  return {
    id: "mido-demo-tool-routing",
    title: "Mido Demo Tool Routing",
    body: [
      "If the user asks for weather in a specific city, call server__getWeather.",
      "If the user asks for weather here, first call client__getLocation when the client provides it, then call server__getWeather with the returned city.",
      "If the user asks to delete or remove a draft, call client__confirmAction before answering when the client provides it.",
    ],
  };
}

function buildDemoAgentPromptSection(): PromptSection {
  return {
    id: "multi-agent-demo-tools",
    title: "Multi-Agent Demo Tools",
    body: [
      "Multi-agent demo tools are registered.",
      "Use server__demoResearchAgent for a single focused research delegation.",
      "Use server__runAgentWorkflow when a complex task should be split into multiple agents.",
      "When using runAgentWorkflow, provide agents with id, task, optional templateId, optional mode=ad_hoc, and dependsOn edges.",
      "Available workflow templates are research, reviewer, and writer.",
      "Prefer templates first; use ad-hoc agents only when these templates do not fit the task.",
    ],
  };
}

function buildAmapPromptSection(amapMcp: AmapMcpStatus): PromptSection {
  if (!amapMcp.enabled) {
    return {
      id: "amap-mcp-tools",
      title: "Amap MCP Tools",
      body: [
        `Amap MCP server tools are not registered: ${amapMcp.reason}.`,
        "Do not claim map, route, geocoding, or nearby-search MCP tools are available in this run.",
      ],
    };
  }

  return {
    id: "amap-mcp-tools",
    title: "Amap MCP Tools",
    body: [
      "If the user asks about maps, places, routes, geocoding, reverse geocoding, coordinates, nearby search, distance, or travel planning in China, use the registered Amap MCP server tools.",
      `Amap MCP tool names are: ${amapMcp.toolNames.join(", ")}.`,
    ],
  };
}

// ---- Specialist / worker agent prompts ----

export const DEMO_RESEARCH_SPECIALIST_PROMPT = buildDemoWorkerPrompt(
  "You are a read-only research specialist for the Mido web demo.",
  [
    "Use available tools to inspect facts.",
    "Return concise findings for the supervisor agent.",
  ],
);

export const DEMO_RESEARCH_WORKER_PROMPT = buildDemoWorkerPrompt(
  "You are a read-only research worker in a Mido demo workflow.",
  [
    "Use tools for facts.",
    "Return concise findings for downstream agents.",
  ],
);

export const DEMO_REVIEW_WORKER_PROMPT = buildDemoWorkerPrompt(
  "You are a review worker in a Mido demo workflow.",
  [
    "Focus on risks, missing evidence, edge cases, and verification steps.",
    "Do not rewrite the full answer unless the supervisor asks for synthesis.",
  ],
);

export const DEMO_SYNTHESIS_WORKER_PROMPT = buildDemoWorkerPrompt(
  "You are a synthesis worker in a Mido demo workflow.",
  [
    "Combine dependency results into a clear, concise answer.",
    "Flag any claim that upstream workers did not verify.",
  ],
);

export function buildAdHocWorkerPrompt(requestedPrompt?: string): string {
  if (requestedPrompt) {
    return buildDemoWorkerPrompt(
      "You are an ad-hoc worker in the Mido demo workflow.",
      [
        "Stay within the requested task and return concise, evidence-based findings.",
        "Follow the requested worker instructions only within tool, safety, and verification boundaries.",
      ],
      {
        id: "requested-worker-instructions",
        title: "Requested Worker Instructions",
        body: requestedPrompt,
      },
    );
  }
  return buildDemoWorkerPrompt(
    "You are an ad-hoc worker in the Mido demo workflow.",
    [
      "Stay within the requested task.",
      "Return concise, evidence-based findings.",
    ],
  );
}

function buildDemoWorkerPrompt(
  identity: string,
  scope: readonly string[],
  extraSection?: PromptSection,
): string {
  return buildMidoAgentHarnessPrompt({
    identity,
    toolNames: [
      "server__workspace_list",
      "server__workspace_search",
      "server__workspace_read_file",
      "server__workspace_stat",
      "server__search_web",
      "server__fetch_url",
      "server__read_document",
      "server__retrieval_index",
      "server__retrieval_query",
      "server__memory_list_scopes",
      "server__memory_search",
      "server__memory_read",
      "server__memory_write",
      "server__memory_delete",
      "server__describeDemoAgent",
    ],
    applicationSections: [
      {
        id: "demo-worker-scope",
        title: "Demo Worker Scope",
        body: scope,
      },
      ...(extraSection ? [extraSection] : []),
    ],
  });
}

function buildDemoAvailableToolNames(
  amapMcp: AmapMcpStatus,
  toolkit: DemoToolkitStatus,
): string[] {
  return [
    "server__getWeather",
    "client__getLocation",
    "client__confirmAction",
    "server__demoResearchAgent",
    "server__runAgentWorkflow",
    ...(toolkit.enabled ? Object.values(toolkit.toolModelNames) : []),
    ...(amapMcp.enabled ? amapMcp.toolNames : []),
  ];
}

// ---- Utility types (used by prompt builders) ----

export type AmapMcpStatus = {
  enabled: boolean;
  reason: string;
  toolCount: number;
  toolNames: string[];
};
