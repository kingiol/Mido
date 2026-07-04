import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import {
  FileSystemEventStore,
  FileSystemThreadStore,
  InMemorySessionStore,
  createAgentRunner,
  createAgentSkillRegistry,
  createDeepSeekModelAdapter,
  registerManagedMcpHttpServerTools,
  type AgentDelegationOptions,
  type AgentRunner,
  type AgentSkillManifest,
} from "../../packages/server-sdk/src/index.js";
import {
  createDemoToolkitTools,
  createDisabledDemoToolkitStatus,
  registerDemoToolkitTools,
  type DemoToolkitStatus,
} from "./demo-toolkit.js";
import {
  runResumeRequestSchema,
  runCancelRequestSchema,
  runStartRequestSchema,
  validateSchema,
  type CoreEvent,
  type JsonObject,
  type RunCancelRequest,
  type RunResumeRequest,
  type RunStartRequest,
} from "../../packages/protocol-core/src/index.js";
import type { ServerToolRuntimeDefinition } from "../../packages/server-sdk/src/index.js";
import {
  buildAdHocWorkerPrompt,
  buildDemoSystemPrompt,
  DEMO_RESEARCH_SPECIALIST_PROMPT,
  DEMO_RESEARCH_WORKER_PROMPT,
  DEMO_REVIEW_WORKER_PROMPT,
  DEMO_SYNTHESIS_WORKER_PROMPT,
  type AmapMcpStatus,
} from "./prompts.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../..");
const demoSkillRoot = resolve(currentDir, "skills");

loadDemoEnv();

const weatherTool: ServerToolRuntimeDefinition = {
  name: "getWeather",
  description: "Look up a city weather report inside the server runtime.",
  executionPolicy: "server",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      city: {
        type: "string",
        description:
          "City name to look up in the server-side demo weather table.",
      },
    },
    required: ["city"],
  },
  resultSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      city: { type: "string" },
      summary: { type: "string" },
      temperatureC: { type: "number" },
    },
    required: ["city", "summary", "temperatureC"],
  },
  execute: async (args: JsonObject) => {
    const city = String(args.city ?? "")
      .trim()
      .toLowerCase();
    const weather = WEATHER_BY_CITY[city] ?? {
      summary: "clear",
      temperatureC: 21,
    };

    return {
      city: titleCase(city || "unknown"),
      summary: weather.summary,
      temperatureC: weather.temperatureC,
    };
  },
};

const port = Number(process.env.PORT ?? 3030);
const provider = resolveProvider();
const exposeReasoningEvents =
  process.env.EXPOSE_REASONING_EVENTS?.trim() !== "false";
const storageRoot = resolveStorageRoot();
let amapMcp: AmapMcpStatus = createDisabledAmapMcpStatus("not connected");
let demoToolkit: DemoToolkitStatus = createDisabledDemoToolkitStatus(
  projectRoot,
  "not registered",
);
const skillRegistry = await createAgentSkillRegistry({
  rootDirs: [demoSkillRoot],
  maxLoadedSkills: 3,
  maxPromptBytes: 24_000,
  auditSink: (event) => {
    console.log(`Skill audit: ${event.type} ${event.skillId}`);
  },
});
const runner = createAgentRunner({
  modelAdapter: provider.modelAdapter,
  sessionStore: new InMemorySessionStore({ ttlMs: 15 * 60 * 1000 }),
  threadStore: new FileSystemThreadStore({ rootDir: storageRoot }),
  eventStore: new FileSystemEventStore({ rootDir: storageRoot }),
  exposeReasoningEvents,
  systemPrompt: () => buildDemoSystemPrompt(amapMcp, demoToolkit),
  skillRegistry,
  delegation: createDemoAgentDelegation(),
});

runner.registerTool(weatherTool);
demoToolkit = registerDemoToolkitTools(runner, { projectRoot });

amapMcp = await registerAmapMcpTools(runner);

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        port,
        provider: provider.name,
        model: provider.model,
        storageRoot,
        exposeReasoningEvents,
        amapMcp,
        toolkit: demoToolkit,
        skills: {
          enabled: true,
          count: skillRegistry.listSkills().length,
          ids: skillRegistry.listSkills().map((skill) => skill.id),
        },
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/skills") {
      sendJson(response, 200, {
        skills: skillRegistry.listSkills().map(toClientSkillSummary),
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/run") {
      const body = await readJson(request);
      const runRequest = validateSchema<RunStartRequest>(
        runStartRequestSchema,
        body,
        "run request",
      );
      await streamEvents(response, runner.run(runRequest));
      return;
    }

    if (request.method === "POST" && request.url === "/api/resume") {
      const body = await readJson(request);
      const resumeRequest = validateSchema<RunResumeRequest>(
        runResumeRequestSchema,
        body,
        "resume request",
      );
      await streamEvents(response, runner.resume(resumeRequest));
      return;
    }

    if (request.method === "POST" && request.url === "/api/cancel") {
      const body = await readJson(request);
      const cancelRequest = validateSchema<RunCancelRequest>(
        runCancelRequestSchema,
        body,
        "cancel request",
      );
      const event = await runner.cancelRun(cancelRequest);
      sendJson(response, 200, {
        status: event ? "cancelled" : "cancelling",
        event,
      });
      return;
    }

    sendJson(response, 404, {
      error: "Not found",
    });
  } catch (error) {
    console.error(error);
    if (response.headersSent) {
      response.end();
      return;
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(port, () => {
  console.log(`Mido demo API listening on http://localhost:${port}`);
  console.log(
    'Try the web client on http://localhost:5173 after running "pnpm demo".',
  );
  console.log(`Provider: ${provider.name} (${provider.model})`);
  console.log(`Storage root: ${storageRoot}`);
  console.log(`Expose reasoning events: ${exposeReasoningEvents}`);
  console.log(
    `Toolkit core: ${demoToolkit.enabled ? `enabled (${demoToolkit.toolCount} tools)` : `disabled (${demoToolkit.reason})`}`,
  );
  console.log(
    `Amap MCP: ${amapMcp.enabled ? `enabled (${amapMcp.toolCount} tools)` : `disabled (${amapMcp.reason})`}`,
  );
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function streamEvents(
  response: ServerResponse<IncomingMessage>,
  stream: AsyncIterable<CoreEvent>,
) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  for await (const event of stream) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  response.end();
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function toClientSkillSummary(skill: AgentSkillManifest) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    digest: skill.digest,
    source: "demo-server",
    enabled: false,
    hasScripts: skill.scripts.length > 0,
    status: "ready",
    risk: skill.scripts.length > 0 ? "high" : "low",
    metadata: {
      keywords: skill.keywords ?? [],
    },
  };
}

async function registerAmapMcpTools(
  runner: Pick<ReturnType<typeof createAgentRunner>, "registerTool">,
) {
  const apiKey = process.env.AMAP_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return createDisabledAmapMcpStatus("missing AMAP_MAPS_API_KEY");
  }

  const url = new URL("https://mcp.amap.com/mcp");
  url.searchParams.set("key", apiKey);

  try {
    const result = await registerManagedMcpHttpServerTools(runner, {
      url,
      namePrefix: "amap_",
      clientName: "mido-web-demo",
      clientVersion: "0.1.0",
    });

    return {
      enabled: true,
      reason: "connected",
      toolCount: result.tools.length,
      toolNames: result.tools.map((tool) => tool.name),
    };
  } catch (error) {
    console.error("Failed to connect Amap MCP server:", error);
    return {
      enabled: false,
      reason: error instanceof Error ? error.message : "unknown error",
      toolCount: 0,
      toolNames: [] as string[],
    };
  }
}

function createDemoAgentDelegation(): AgentDelegationOptions {
  return {
    // 这里配置的是“固定专家 agent”示例：主 agent 只有在判断需要专项研究时，才会调用 demoResearchAgent。
    // 子 agent 使用独立 runner 和独立工具注册，不会自动继承主 runner 的全部工具，避免把 MCP、workflow 等高权限能力递归暴露给子 agent。
    agents: [
      {
        agentId: "demo_research",
        name: "demoResearchAgent",
        description:
          "Delegate focused repository, documentation, or research tasks to a read-only demo research agent.",
        runner: createDemoSpecialistRunner(
          "demo_research",
          DEMO_RESEARCH_SPECIALIST_PROMPT,
        ),
        // maxModelCalls: 3,
        timeoutMs: 90_000,
      },
    ],
    // 这里配置的是“动态多 agent workflow”示例：主 agent 可以一次性声明多个 worker agents，
    // 并用 dependsOn 控制它们是并发执行、串行执行，还是组成一个小型 DAG。
    workflow: {
      name: "runAgentWorkflow",
      description:
        "Create and coordinate multiple demo agents for complex tasks. Use dependsOn to control serial, parallel, or DAG execution.",
      templates: {
        research: {
          description: "Read-only research worker with demo toolkit access.",
          createRunner: (request) =>
            createDemoSpecialistRunner(
              `workflow_${request.agent.id}`,
              DEMO_RESEARCH_WORKER_PROMPT,
            ),
        },
        reviewer: {
          description:
            "Review worker focused on risks, gaps, and verification.",
          createRunner: (request) =>
            createDemoSpecialistRunner(
              `workflow_${request.agent.id}`,
              DEMO_REVIEW_WORKER_PROMPT,
            ),
        },
        writer: {
          description:
            "Synthesis worker that turns upstream findings into a clear final draft.",
          createRunner: (request) =>
            createDemoSpecialistRunner(
              `workflow_${request.agent.id}`,
              DEMO_SYNTHESIS_WORKER_PROMPT,
            ),
        },
      },
      allowAdHocAgents: true,
      createAdHocRunner: (request) => {
        // ad-hoc agent 由主 agent 提出，但真正创建仍经过 server factory。
        // demo 中允许它自定义 systemPrompt，是为了展示能力；生产环境可以在这里做审核、包裹或拒绝。
        const requestedPrompt = request.agent.systemPrompt?.trim();
        return createDemoSpecialistRunner(
          `workflow_${request.agent.id}`,
          buildAdHocWorkerPrompt(requestedPrompt || undefined),
        );
      },
      limits: {
        maxAgents: 5,
        maxParallelAgents: 2,
        // maxModelCallsPerAgent: 3,
        timeoutMs: 120_000,
      },
    },
  };
}

function createDemoSpecialistRunner(
  agentId: string,
  systemPrompt: string,
): AgentRunner {
  const childRunner = createAgentRunner({
    modelAdapter: provider.modelAdapter,
    sessionStore: new InMemorySessionStore({ ttlMs: 15 * 60 * 1000 }),
    threadStore: new FileSystemThreadStore({ rootDir: storageRoot }),
    eventStore: new FileSystemEventStore({ rootDir: storageRoot }),
    exposeReasoningEvents,
    systemPrompt,
  });

  // 子 agent 只注册 demo 的安全 toolkit 面：仓库读取、公开检索、文档/记忆工具。
  // 它不会注册 runAgentWorkflow、demoResearchAgent 或 Amap MCP，避免子 agent 递归创建更多 agent 或拿到主 agent 的全部能力。
  for (const tool of createDemoToolkitTools({ projectRoot })) {
    childRunner.registerTool(tool);
  }

  // 这个轻量工具帮助 demo 调试：让 child run 的输出和 trace 更容易区分来自哪个 worker。
  childRunner.registerTool({
    name: "describeDemoAgent",
    description: "Return the id and role of the current demo child agent.",
    executionPolicy: "server",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    resultSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        role: { type: "string" },
      },
      required: ["agentId", "role"],
    },
    execute: () => ({
      agentId,
      role: "demo_child_agent",
    }),
  });

  return childRunner;
}

function createDisabledAmapMcpStatus(reason: string): AmapMcpStatus {
  return {
    enabled: false,
    reason,
    toolCount: 0,
    toolNames: [],
  };
}

function resolveProvider() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
  const baseUrl =
    process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to run the web demo server");
  }

  return {
    name: "deepseek",
    model,
    modelAdapter: createDeepSeekModelAdapter({
      apiKey,
      model,
      baseUrl,
    }),
  };
}

function loadDemoEnv() {
  const envFiles = [
    resolve(projectRoot, ".env"),
    resolve(projectRoot, ".env.local"),
    resolve(currentDir, ".env"),
    resolve(currentDir, ".env.local"),
  ];

  for (const path of envFiles) {
    loadEnv({
      path,
      override: true,
    });
  }
}

function resolveStorageRoot(): string {
  const configured = process.env.MIDO_STORE_DIR?.trim();
  if (!configured) {
    return resolve(projectRoot, ".mido-store");
  }

  return resolve(projectRoot, configured);
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(
      (segment) =>
        segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join(" ");
}

const WEATHER_BY_CITY: Record<
  string,
  { summary: string; temperatureC: number }
> = {
  shanghai: { summary: "humid and bright", temperatureC: 24 },
  hangzhou: { summary: "cloudy with light rain", temperatureC: 21 },
  beijing: { summary: "dry and windy", temperatureC: 18 },
  tokyo: { summary: "clear with a cool breeze", temperatureC: 19 },
  singapore: { summary: "warm with scattered showers", temperatureC: 30 },
};
