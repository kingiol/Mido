import type {
  AgentRunner,
  ServerToolRuntimeDefinition,
} from "../../packages/server-sdk/src/index.js";
import {
  InMemoryMemoryStore,
  InMemoryRetrievalStore,
  createMemoryTools,
  createSearchAndRetrievalTools,
  createWorkspaceTools,
  type SearchWebProvider,
  type SearchWebResult,
  type ToolkitToolDefinition,
} from "../../packages/toolkit-core/src/index.js";

const DEMO_WORKSPACE_TOOL_NAMES = new Set([
  "workspace_list",
  "workspace_search",
  "workspace_read_file",
  "workspace_stat",
]);

const DEMO_SEARCH_RETRIEVAL_TOOL_NAMES = new Set([
  "search_web",
  "fetch_url",
  "read_document",
  "retrieval_index",
  "retrieval_query",
]);

const DEMO_MEMORY_TOOL_NAMES = new Set([
  "memory_list_scopes",
  "memory_search",
  "memory_read",
  "memory_write",
  "memory_delete",
]);

export interface CreateDemoToolkitToolsOptions {
  projectRoot: string;
  searchProvider?: SearchWebProvider;
  fetch?: typeof fetch;
}

export interface DemoToolkitStatus {
  enabled: boolean;
  reason: string;
  toolCount: number;
  toolNames: string[];
  workspaceRoot: string;
  readonlyWorkspace: boolean;
  volatileStores: boolean;
}

export function createDemoToolkitTools(
  options: CreateDemoToolkitToolsOptions,
): ServerToolRuntimeDefinition[] {
  const retrievalStore = new InMemoryRetrievalStore();
  const memoryStore = new InMemoryMemoryStore();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return [
    ...selectServerTools(
      createWorkspaceTools({
        roots: [options.projectRoot],
        defaultRoot: options.projectRoot,
        executionPolicy: {
          read: "server",
        },
      }),
      DEMO_WORKSPACE_TOOL_NAMES,
    ),
    ...selectServerTools(
      createSearchAndRetrievalTools({
        store: retrievalStore,
        searchProvider:
          options.searchProvider ?? createDemoSearchProvider(fetchImpl),
        fetch: fetchImpl,
        allowPrivateNetworks: false,
        executionPolicy: {
          read: "server",
          write: "server",
        },
      }),
      DEMO_SEARCH_RETRIEVAL_TOOL_NAMES,
    ),
    ...selectServerTools(
      createMemoryTools({
        store: memoryStore,
        executionPolicy: {
          read: "server",
          write: "server",
          delete: "server",
        },
      }),
      DEMO_MEMORY_TOOL_NAMES,
    ),
  ];
}

export function registerDemoToolkitTools(
  runner: Pick<AgentRunner, "registerTool">,
  options: CreateDemoToolkitToolsOptions,
): DemoToolkitStatus {
  const tools = createDemoToolkitTools(options);
  for (const tool of tools) {
    runner.registerTool(tool);
  }

  return {
    enabled: true,
    reason: "registered",
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    workspaceRoot: options.projectRoot,
    readonlyWorkspace: true,
    volatileStores: true,
  };
}

export function createDisabledDemoToolkitStatus(
  projectRoot: string,
  reason: string,
): DemoToolkitStatus {
  return {
    enabled: false,
    reason,
    toolCount: 0,
    toolNames: [],
    workspaceRoot: projectRoot,
    readonlyWorkspace: true,
    volatileStores: true,
  };
}

function selectServerTools(
  tools: ToolkitToolDefinition[],
  allowedNames: ReadonlySet<string>,
): ServerToolRuntimeDefinition[] {
  return tools.filter((tool) => allowedNames.has(tool.name)).map(asServerTool);
}

function asServerTool(
  tool: ToolkitToolDefinition,
): ServerToolRuntimeDefinition {
  if (tool.executionPolicy !== "server") {
    throw new Error(
      `Demo toolkit tool "${tool.name}" must use server execution`,
    );
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`Demo toolkit tool "${tool.name}" must define execute`);
  }

  return tool as ServerToolRuntimeDefinition;
}

function createDemoSearchProvider(
  fetchImpl: typeof fetch = globalThis.fetch,
): SearchWebProvider {
  return async (request) => {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    const response = await fetchImpl(url);
    if (!response.ok) {
      return {
        results: createFallbackSearchResults(
          request.query,
          request.limit,
          `HTTP ${response.status}`,
        ),
      };
    }

    const raw = await response.text();
    if (!raw.trim()) {
      return {
        results: createFallbackSearchResults(
          request.query,
          request.limit,
          "empty response",
        ),
      };
    }

    let payload: DuckDuckGoResponse;
    try {
      payload = JSON.parse(raw) as DuckDuckGoResponse;
    } catch {
      return {
        results: createFallbackSearchResults(
          request.query,
          request.limit,
          "invalid JSON",
        ),
      };
    }

    return {
      results: normalizeDuckDuckGoResults(
        payload,
        request.query,
        request.limit,
      ),
    };
  };
}

function normalizeDuckDuckGoResults(
  payload: DuckDuckGoResponse,
  query: string,
  limit = 5,
): SearchWebResult[] {
  const results: SearchWebResult[] = [];
  const seenUrls = new Set<string>();

  if (payload.AbstractText && payload.AbstractURL) {
    addSearchResult(results, seenUrls, {
      title: payload.Heading || query,
      url: payload.AbstractURL,
      snippet: payload.AbstractText,
      source: "duckduckgo",
    });
  }

  for (const topic of [
    ...(payload.Results ?? []),
    ...(payload.RelatedTopics ?? []),
  ]) {
    addDuckDuckGoTopic(results, seenUrls, topic);
    if (results.length >= limit) {
      break;
    }
  }

  if (results.length === 0) {
    return createFallbackSearchResults(
      query,
      limit,
      "no instant answer results",
    );
  }

  return results.slice(0, Math.max(1, limit));
}

function createFallbackSearchResults(
  query: string,
  limit = 1,
  reason: string,
): SearchWebResult[] {
  const searchUrl = new URL("https://duckduckgo.com/");
  searchUrl.searchParams.set("q", query);

  return [
    {
      title: `Search DuckDuckGo for "${query}"`,
      url: searchUrl.toString(),
      snippet:
        "DuckDuckGo did not return instant-answer results for this query.",
      source: "duckduckgo",
      metadata: { reason },
    },
  ].slice(0, Math.max(1, limit));
}

function addDuckDuckGoTopic(
  results: SearchWebResult[],
  seenUrls: Set<string>,
  topic: DuckDuckGoTopicGroup | DuckDuckGoTopic,
) {
  if (isDuckDuckGoTopicGroup(topic)) {
    for (const nested of topic.Topics) {
      addDuckDuckGoTopic(results, seenUrls, nested);
    }
    return;
  }

  if (!topic.FirstURL || !topic.Text) {
    return;
  }

  addSearchResult(results, seenUrls, {
    title: readTopicTitle(topic.Text),
    url: topic.FirstURL,
    snippet: topic.Text,
    source: "duckduckgo",
  });
}

function addSearchResult(
  results: SearchWebResult[],
  seenUrls: Set<string>,
  result: SearchWebResult,
) {
  if (seenUrls.has(result.url)) {
    return;
  }

  seenUrls.add(result.url);
  results.push(result);
}

function readTopicTitle(text: string): string {
  const [title] = text.split(" - ");
  return title?.trim() || text;
}

function isDuckDuckGoTopicGroup(
  topic: DuckDuckGoTopicGroup | DuckDuckGoTopic,
): topic is DuckDuckGoTopicGroup {
  return Array.isArray((topic as DuckDuckGoTopicGroup).Topics);
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  Results?: DuckDuckGoTopic[];
  RelatedTopics?: Array<DuckDuckGoTopic | DuckDuckGoTopicGroup>;
}

interface DuckDuckGoTopic {
  FirstURL?: string;
  Text?: string;
}

interface DuckDuckGoTopicGroup {
  Topics: DuckDuckGoTopic[];
}
