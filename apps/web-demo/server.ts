import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

import {
  FileSystemEventStore,
  FileSystemThreadStore,
  InMemorySessionStore,
  createAgentRunner,
  createAgentSkillRegistry,
  createDeepSeekModelAdapter,
  registerManagedMcpHttpServerTools,
  type AgentSkillManifest
} from '../../packages/server-sdk/src/index.js';
import {
  createDisabledDemoToolkitStatus,
  registerDemoToolkitTools,
  type DemoToolkitStatus
} from './demo-toolkit.js';
import {
  runResumeRequestSchema,
  runCancelRequestSchema,
  runStartRequestSchema,
  validateSchema,
  type CoreEvent,
  type JsonObject,
  type RunCancelRequest,
  type RunResumeRequest,
  type RunStartRequest
} from '../../packages/protocol-core/src/index.js';
import type { ServerToolRuntimeDefinition } from '../../packages/server-sdk/src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, '../..');
const demoSkillRoot = resolve(currentDir, 'skills');

loadDemoEnv();

const weatherTool: ServerToolRuntimeDefinition = {
  name: 'getWeather',
  description: 'Look up a city weather report inside the server runtime.',
  executionPolicy: 'server',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string', description: 'City name to look up in the server-side demo weather table.' }
    },
    required: ['city']
  },
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string' },
      summary: { type: 'string' },
      temperatureC: { type: 'number' }
    },
    required: ['city', 'summary', 'temperatureC']
  },
  execute: async (args: JsonObject) => {
    const city = String(args.city ?? '').trim().toLowerCase();
    const weather = WEATHER_BY_CITY[city] ?? {
      summary: 'clear',
      temperatureC: 21
    };

    return {
      city: titleCase(city || 'unknown'),
      summary: weather.summary,
      temperatureC: weather.temperatureC
    };
  }
};

const port = Number(process.env.PORT ?? 3030);
const provider = resolveProvider();
const exposeReasoningEvents = process.env.EXPOSE_REASONING_EVENTS?.trim() !== 'false';
const storageRoot = resolveStorageRoot();
let amapMcp: AmapMcpStatus = createDisabledAmapMcpStatus('not connected');
let demoToolkit: DemoToolkitStatus = createDisabledDemoToolkitStatus(projectRoot, 'not registered');
const skillRegistry = await createAgentSkillRegistry({
  rootDirs: [demoSkillRoot],
  maxLoadedSkills: 3,
  maxPromptBytes: 24_000,
  auditSink: event => {
    console.log(`Skill audit: ${event.type} ${event.skillId}`);
  }
});
const runner = createAgentRunner({
  modelAdapter: provider.modelAdapter,
  sessionStore: new InMemorySessionStore({ ttlMs: 15 * 60 * 1000 }),
  threadStore: new FileSystemThreadStore({ rootDir: storageRoot }),
  eventStore: new FileSystemEventStore({ rootDir: storageRoot }),
  exposeReasoningEvents,
  systemPrompt: () => buildDemoSystemPrompt(amapMcp, demoToolkit),
  skillRegistry
});

runner.registerTool(weatherTool);
demoToolkit = registerDemoToolkitTools(runner, { projectRoot });

amapMcp = await registerAmapMcpTools(runner);

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/api/health') {
      sendJson(response, 200, {
        status: 'ok',
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
          ids: skillRegistry.listSkills().map(skill => skill.id)
        }
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/skills') {
      sendJson(response, 200, {
        skills: skillRegistry.listSkills().map(toClientSkillSummary)
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/run') {
      const body = await readJson(request);
      const runRequest = validateSchema<RunStartRequest>(runStartRequestSchema, body, 'run request');
      await streamEvents(
        response,
        runner.run(runRequest)
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/resume') {
      const body = await readJson(request);
      const resumeRequest = validateSchema<RunResumeRequest>(runResumeRequestSchema, body, 'resume request');
      await streamEvents(response, runner.resume(resumeRequest));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/cancel') {
      const body = await readJson(request);
      const cancelRequest = validateSchema<RunCancelRequest>(runCancelRequestSchema, body, 'cancel request');
      const event = await runner.cancelRun(cancelRequest);
      sendJson(response, 200, {
        status: event ? 'cancelled' : 'cancelling',
        event
      });
      return;
    }

    sendJson(response, 404, {
      error: 'Not found'
    });
  } catch (error) {
    console.error(error);
    if (response.headersSent) {
      response.end();
      return;
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unknown server error'
    });
  }
});

server.listen(port, () => {
  console.log(`Mido demo API listening on http://localhost:${port}`);
  console.log('Try the web client on http://localhost:5173 after running "pnpm demo".');
  console.log(`Provider: ${provider.name} (${provider.model})`);
  console.log(`Storage root: ${storageRoot}`);
  console.log(`Expose reasoning events: ${exposeReasoningEvents}`);
  console.log(`Toolkit core: ${demoToolkit.enabled ? `enabled (${demoToolkit.toolCount} tools)` : `disabled (${demoToolkit.reason})`}`);
  console.log(`Amap MCP: ${amapMcp.enabled ? `enabled (${amapMcp.toolCount} tools)` : `disabled (${amapMcp.reason})`}`);
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function streamEvents(response: ServerResponse<IncomingMessage>, stream: AsyncIterable<CoreEvent>) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });

  for await (const event of stream) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  response.end();
}

function sendJson(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function toClientSkillSummary(skill: AgentSkillManifest) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    digest: skill.digest,
    source: 'demo-server',
    enabled: false,
    hasScripts: skill.scripts.length > 0,
    status: 'ready',
    risk: skill.scripts.length > 0 ? 'high' : 'low',
    metadata: {
      keywords: skill.keywords ?? []
    }
  };
}

async function registerAmapMcpTools(runner: Pick<ReturnType<typeof createAgentRunner>, 'registerTool'>) {
  const apiKey = process.env.AMAP_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return createDisabledAmapMcpStatus('missing AMAP_MAPS_API_KEY');
  }

  const url = new URL('https://mcp.amap.com/mcp');
  url.searchParams.set('key', apiKey);

  try {
    const result = await registerManagedMcpHttpServerTools(runner, {
      url,
      namePrefix: 'amap_',
      clientName: 'mido-web-demo',
      clientVersion: '0.1.0'
    });

    return {
      enabled: true,
      reason: 'connected',
      toolCount: result.tools.length,
      toolNames: result.tools.map(tool => tool.name)
    };
  } catch (error) {
    console.error('Failed to connect Amap MCP server:', error);
    return {
      enabled: false,
      reason: error instanceof Error ? error.message : 'unknown error',
      toolCount: 0,
      toolNames: [] as string[]
    };
  }
}

type AmapMcpStatus = {
  enabled: boolean;
  reason: string;
  toolCount: number;
  toolNames: string[];
};

function createDisabledAmapMcpStatus(reason: string): AmapMcpStatus {
  return {
    enabled: false,
    reason,
    toolCount: 0,
    toolNames: []
  };
}

function buildDemoSystemPrompt(amapMcp: AmapMcpStatus, toolkit: DemoToolkitStatus): string {
  return `You are the Mido demo agent. Use tools instead of inventing data. If the user asks for weather in a specific city, call getWeather. If the user asks for weather here, first call getLocation and then call getWeather with the returned city. If the user asks to delete or remove a draft, call confirmAction before answering.${buildToolkitPrompt(toolkit)}${amapMcp.enabled ? ` If the user asks about maps, places, routes, geocoding, reverse geocoding, coordinates, nearby search, distance, or travel planning in China, use the registered Amap MCP server tools. Amap MCP tool names are: ${amapMcp.toolNames.join(', ')}.` : ''}`;
}

function buildToolkitPrompt(toolkit: DemoToolkitStatus): string {
  if (!toolkit.enabled) {
    return '';
  }

  return ` Toolkit-core server tools are registered for demo testing. Workspace access is read-only and rooted at ${toolkit.workspaceRoot}. Use workspace_list, workspace_search, workspace_read_file, and workspace_stat for repository questions. Use search_web for public web search. Use fetch_url only for public URLs; private-network URLs are blocked. Use read_document, retrieval_index, retrieval_query, and memory_* tools with the demo's in-memory stores. Do not claim workspace_write_file, workspace_apply_patch, workspace_run_command, or browser_* toolkit tools are available in this demo. Registered toolkit tool names are: ${toolkit.toolNames.join(', ')}.`;
}

function resolveProvider() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com';

  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required to run the web demo server');
  }

  return {
    name: 'deepseek',
    model,
    modelAdapter: createDeepSeekModelAdapter({
      apiKey,
      model,
      baseUrl
    })
  };
}

function loadDemoEnv() {
  const envFiles = [
    resolve(projectRoot, '.env'),
    resolve(projectRoot, '.env.local'),
    resolve(currentDir, '.env'),
    resolve(currentDir, '.env.local')
  ];

  for (const path of envFiles) {
    loadEnv({
      path,
      override: true
    });
  }
}

function resolveStorageRoot(): string {
  const configured = process.env.MIDO_STORE_DIR?.trim();
  if (!configured) {
    return resolve(projectRoot, '.mido-store');
  }

  return resolve(projectRoot, configured);
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

const WEATHER_BY_CITY: Record<string, { summary: string; temperatureC: number }> = {
  shanghai: { summary: 'humid and bright', temperatureC: 24 },
  hangzhou: { summary: 'cloudy with light rain', temperatureC: 21 },
  beijing: { summary: 'dry and windy', temperatureC: 18 },
  tokyo: { summary: 'clear with a cool breeze', temperatureC: 19 },
  singapore: { summary: 'warm with scattered showers', temperatureC: 30 }
};
