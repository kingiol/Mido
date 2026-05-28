# Mido Agent SDK

TypeScript-first SDKs for building AI agent applications where the agent loop runs on your server, clients execute local tools, and every run can pause, resume, and be inspected through a stable protocol.

Mido is designed for products that need more control than a single hosted agent call can provide:

- Server-owned agent loops with provider-neutral model adapters.
- Resumable client-side tools for browser, desktop, mobile, or native capabilities.
- Human-in-the-loop approval for interactive and destructive actions.
- MCP integration on either side of the server/client boundary.
- AG-UI adapters, JSON Schemas, and conformance helpers for stable client contracts.
- Durable checkpoints, thread/event stores, tracing, and local run inspection.

Use Mido when your app needs the model to reason on the server while the client keeps ownership of local context, user approvals, credentials, or device-only capabilities.

## What is in this repository

- `@mido/protocol-core`
  Shared event types, run request types, tool contracts, JSON Schemas, and schema validation helpers.
- `@mido/protocol-agui`
  Boundary adapter between `CoreEvent` and AG-UI-shaped events.
- `@mido/mcp-core`
  Managed MCP connections, health checks, tool refresh diffs, and mapping helpers for server or client runtimes.
- `@mido/server-sdk`
  Server-owned agent loop, tool routing, suspend/resume flow, `SessionStore`, durable thread/event stores, tracing, and provider adapters including DeepSeek.
- `@mido/client-core`
  Transport-agnostic client runtime with local tool registry, pending interactive tool state, and automatic resume for `client_auto` tools.
- `@mido/client-web`
  Browser transport, React hooks, and a minimal reference panel.
- `MidoClient`
  iOS Swift 6 client SDK packaged with Swift Package Manager under `packages/client-ios`.
- `@mido/toolkit-core`
  Optional agent tools for workspace access, web search/fetch, document retrieval, browser automation adapters, and scoped memory.
- `@mido/conformance`
  JSON Schema export, native client contract docs, and round-trip conformance helpers.

## Repository map

```text
.
├── docs/
│   ├── README.md
│   ├── roadmap.md
│   ├── architecture.md
│   ├── data-flow.md
│   ├── storage-and-tracing.md
│   ├── agent-skills.md
│   ├── plans/
│   └── archive/
├── packages/
│   ├── client-core/
│   ├── client-ios/
│   ├── client-web/
│   ├── conformance/
│   ├── mcp-core/
│   ├── protocol-agui/
│   ├── protocol-core/
│   ├── server-sdk/
│   └── toolkit-core/
└── tests/
```

## Core design

- The agent loop always runs on the server.
- The client consumes streamed events and only executes local tools.
- `server` tools execute immediately inside the server loop.
- `client_auto` tools execute on the client and resume automatically.
- `client_interactive` tools surface pending actions to the UI; approval executes the local handler, while rejection resumes without executing it.
- Client-owned prompt preferences can be set globally with `createAgentClient({ systemPrompt })`, updated with `client.setSystemPrompt(...)`, or provided per run with `sendMessage(text, { systemPrompt })`. Static strings and context-aware provider functions are supported. They are sent with the run request but are not stored in client conversation memory.
- MCP tools follow the same policy split: server MCP tools become `server` tools, and client MCP tools become `client_auto` tools that are advertised through `RunStartRequest.clientTools`.
- Server-owned system prompts can be configured with `createAgentRunner({ systemPrompt })` and updated with `runner.setSystemPrompt(...)`. Static strings and context-aware provider functions are supported. When set, client-provided `system` messages are treated as untrusted supplemental preferences and wrapped under the server prompt instead of being passed through as peer instructions.
- Server-side multi-agent orchestration is supported through `createAgentTool(...)`. A child `AgentRunner` can be wrapped as a normal `server` tool so the root runner keeps ownership of the user-facing conversation while specialists use their own prompts, tools, policies, and stores.
- Agent Skills are supported as instruction/resource packages. Mido indexes `SKILL.md` frontmatter, progressively loads selected instructions, supports `references/` and `assets/`, emits audit events, and can run `scripts/` only when an explicit sandbox is configured.
- Tool policy is opt-in. Existing runners behave the same unless `createAgentRunner({ toolPolicy })` is configured. Tools can add lightweight `metadata.policy` hints such as `risk`, `effects`, and `scopes`; `createDefaultToolPolicy()` hides and blocks destructive non-interactive tools while keeping `client_interactive` tools available for the existing approval flow.
- The internal protocol stays provider-neutral.
- AG-UI stays an adapter layer, not the internal source of truth.
- Durable storage is split into checkpoint storage, thread storage, and event storage so each deployment can choose its own backing store.

## Low-friction tool policy

Policy metadata is passive by default:

```ts
runner.registerTool({
  name: 'deleteDraft',
  description: 'Delete a draft',
  executionPolicy: 'server',
  inputSchema,
  resultSchema,
  metadata: {
    policy: {
      risk: 'destructive',
      effects: ['delete'],
      scopes: ['draft:delete']
    }
  },
  execute
});
```

Enable the default policy only when the app is ready to enforce it:

```ts
const runner = createAgentRunner({
  modelAdapter,
  sessionStore,
  toolPolicy: createDefaultToolPolicy()
});
```

The default policy is intentionally quiet: tools without policy metadata are allowed in balanced mode, low-risk tools are allowed, and destructive tools should use `client_interactive` if they need user approval.

## Server multi-agent tools

Use `createAgentTool(...)` when a specialist needs its own prompt, model, tools, or policy, but the root agent should keep ownership of the user-facing conversation:

```ts
const researchRunner = createAgentRunner({
  modelAdapter: researchModel,
  sessionStore,
  systemPrompt: 'You are a research specialist. Return concise findings.'
});

const mainRunner = createAgentRunner({
  modelAdapter: mainModel,
  sessionStore,
  systemPrompt: 'You are the supervisor. Delegate research tasks when useful.'
});

mainRunner.registerTool(createAgentTool({
  agentId: 'research',
  name: 'researchAgent',
  description: 'Delegate focused research tasks and return concise findings.',
  runner: researchRunner,
  maxModelCalls: 3,
  timeoutMs: 60_000
}));
```

The child agent runs as a separate server run and returns a compact tool result with `agentId`, `childRunId`, status, output text, and counters.

Use `createAgentWorkflowTool(...)` when the root agent should decide how many agents to create and how they depend on each other:

```ts
mainRunner.registerTool(createAgentWorkflowTool({
  name: 'runAgentWorkflow',
  description: 'Create and coordinate multiple agents for complex tasks.',
  templates: {
    research: {
      description: 'Read-only research specialist.',
      createRunner: () => createAgentRunner({
        modelAdapter: researchModel,
        sessionStore,
        systemPrompt: 'You are a research specialist.'
      })
    }
  },
  allowAdHocAgents: true,
  createAdHocRunner: request => createAgentRunner({
    modelAdapter: workerModel,
    sessionStore,
    systemPrompt: request.agent.systemPrompt
  }),
  limits: {
    maxAgents: 5,
    maxParallelAgents: 2,
    maxModelCallsPerAgent: 4
  }
}));
```

The root model can call this one server tool with a DAG-shaped request: agents without `dependsOn` can run concurrently, while dependent agents wait for upstream results. Registered templates are preferred because the server controls their model, prompt, tools, and policy. Ad-hoc agents are allowed only when explicitly enabled and still run through the server-provided factory.

## Main flow

```text
User Input
   |
   v
Server Agent Runner
   |
   +--> server tool --------> continue loop
   |
   +--> client tool --------> checkpoint + stream tool call
                               |
                               v
                         Client Runtime
                               |
                               +--> auto execute -----> POST resume
                               |
                               +--> user approve/reject -> POST resume
```

See [Docs](./docs/README.md) for the full documentation map and [Roadmap](./docs/roadmap.md) for current priorities.
See [Architecture](./docs/architecture.md) for the package boundaries and [Data Flow](./docs/data-flow.md) for the annotated sequence diagrams.
See [Storage and Tracing](./docs/storage-and-tracing.md) for filesystem persistence, storage interfaces, and run inspector traces.

## MCP tool mapping

MCP is an integration source, not a separate runtime class in Mido.

| MCP connection | Mido tool policy | Tool execution | Model visibility |
| --- | --- | --- | --- |
| Server-side MCP | `server` | Server runner calls the remote MCP server | Registered directly on the server runner |
| Client-side MCP | `client_auto` | Client runtime calls the remote MCP server | Sent with each `RunStartRequest.clientTools` |

Server-side MCP is useful when credentials and network access should stay in the server process. Client-side MCP is useful when the browser or native client owns the capability. In both cases the model only sees normal tool definitions.

## Agent Skills

Register no-script skills on the server:

```ts
const skillRegistry = await createAgentSkillRegistry({
  rootDirs: ['./skills'],
  maxLoadedSkills: 3,
  maxPromptBytes: 48_000,
  auditSink: event => console.log(event)
});

const runner = createAgentRunner({
  modelAdapter,
  sessionStore,
  systemPrompt: 'Follow the application safety policy.',
  skillRegistry
});
```

Clients can send preferences without reading skill files:

```ts
await client.sendMessage('Please triage this ticket.', {
  metadata: {
    enabledSkills: ['support-triage']
  }
});
```

Native clients can keep local skill state with `createAgentSkillManager({ store })` and pass it to `createAgentClient({ skillManager })`. The client will include enabled skill refs in `metadata.skills.enabled` for each run.

## iOS Swift Package

The iOS client SDK lives in `packages/client-ios` and is distributed as a Swift Package named `MidoClient`.

```swift
// Package.swift
.package(url: "https://github.com/kingiol/Mido.git", branch: "main")
```

Then add the `MidoClient` product to your app target. The first iOS SDK pass includes Swift 6 Codable protocol models, an `AgentClient` actor, local `client_auto` and `client_interactive` tool handling, and a `URLSessionSSETransport` for the same `SSE down + POST up` contract used by the web client. The agent loop still runs on the server.

Verify the Swift package with:

```bash
swift test --package-path packages/client-ios
```

To enable `scripts/`, configure `scriptSandbox` and register `createAgentSkillScriptTool(skillRegistry)`. See [Agent Skills](./docs/agent-skills.md) for the sandbox contract and safety controls.

MCP Streamable HTTP connections are wrapped with the managed connection helpers in the web demo. `createManagedMcpHttpConnection` exposes `getStatus`, `subscribe`, `healthCheck`, `reconnect`, `close`, and `refreshTools`. Tool calls retry once after a stale connection failure, and refresh helpers return added, updated, removed, and unchanged tool definitions so applications can update registration without duplicating tools.

## Provider adapters

Mido keeps provider behavior behind `ModelAdapter`. Adapters can also expose `ModelAdapterCapabilities`, so the runner can fail early when a run asks for capabilities the model does not support.

Available server SDK adapter entry points:

- `createDeepSeekModelAdapter` for DeepSeek native Chat Completions-style streaming.
- `createVercelAiModelAdapter` for Vercel AI SDK stream normalization with caller-provided capabilities.
- `createOpenAICompatibleModelAdapter` for OpenAI-compatible Chat Completions endpoints such as LiteLLM, OpenRouter, Ollama, vLLM, and LocalAI.
- `createOpenAIResponsesModelAdapter` for OpenAI native Responses API behavior.

OpenAI-compatible defaults are intentionally conservative. Pass explicit `capabilities` for production provider checks because compatible endpoints vary in tool calling, usage, request id, and streaming behavior.

## Local commands

```bash
pnpm install
pnpm lint
pnpm test
pnpm run generate:schemas
pnpm build
```

## Demo environment

Run the full local demo:

```bash
pnpm demo
```

That starts:

- API server on `http://localhost:3030`
- Web client on `http://localhost:5173`

Configure the DeepSeek provider before running the demo:

```bash
cp apps/web-demo/.env.example apps/web-demo/.env
```

Then set:

```bash
DEEPSEEK_API_KEY=your_key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
VITE_TENCENT_MAP_MCP_KEY=your_tencent_map_key
```

The demo server reads env files in both locations:

- `apps/web-demo/.env`
- `.env`

`apps/web-demo/.env` has higher priority and is the recommended place for demo-only keys.

Try these prompts in the demo UI:

- `weather in shanghai`
- `weather here`
- `delete draft`
- `search nearby coffee shops around Hangzhou West Lake`

The web demo registers Tencent Map MCP as client-side MCP. It uses the Vite dev proxy at `/mcp/tencent-map` because the Tencent MCP endpoint does not allow direct browser CORS preflight.

Current provider notes:

- The web demo still uses DeepSeek by default.
- DeepSeek V4 flash mode declares tool resume support.
- DeepSeek V4 thinking mode is explicitly marked as not supporting Mido tool resume yet through adapter capabilities.

## Current status

- Core packages compile and build.
- JSON Schemas are exported under `packages/conformance/schemas`.
- The test suite covers text-only runs, server tools, client auto tools, client interactive tools, AG-UI round trips, duplicate submission idempotency, and the browser SSE transport.
- Filesystem thread/event stores and `CoreEvent.trace` support provide a local durable storage path for run inspection.
- Provider adapter capabilities, preflight checks, OpenAI-compatible, and OpenAI Responses adapters are covered by focused tests.
