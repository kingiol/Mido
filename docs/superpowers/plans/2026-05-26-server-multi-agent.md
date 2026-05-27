# Server Multi-Agent Implementation Plan

> **给 agentic workers：**实现本计划时，必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：**在 Mido server 端增加稳定、可测试、低破坏面的 multi-agent 能力，让主 agent 可以把局部任务委托给受限的 specialist agents。

**架构：**V1 采用 `supervisor + sub-agents as server tools`。根 `AgentRunner` 继续拥有唯一的用户可见 agent loop、客户端暂停恢复协议、权限策略和最终回答；每个 specialist agent 被包装成普通 `server` tool，在服务端内部运行独立 child run，并把紧凑结果返回给根 agent。V1 不引入 handoff、swarm 或一等公民 graph runtime，避免过早扩大协议和客户端改动面。

**Tech Stack：**TypeScript、pnpm workspace、Vitest、`@mido/protocol-core`、`@mido/server-sdk`、`CoreEvent`、`SessionStore`、`ThreadStore`、`EventStore`、SSE + HTTP POST transport。

---

## 背景和主流设计方向

Mido 当前已经具备 server-owned agent loop、工具路由、checkpoint/resume、thread/event store、tool policy、skills、MCP 和 tracing。multi-agent 的核心问题不是“多几个模型调用”，而是如何在上下文、权限、成本、可观测性和确定性之间做取舍。

当前主流方向可以归纳为：

| 方向                                | 解决的问题                                                                 | 代价                                                          | 对 Mido 的判断                                                             |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `supervisor + agents as tools`      | 一个入口统一接收用户请求，按需调用专家 agent，最终回答仍由 supervisor 把关 | 子 agent 不能直接接管用户对话；需要压缩 child output          | 作为 V1。它最贴合 Mido 现有 server tool、policy、event store 和 trace 结构 |
| `handoff / swarm`                   | 专家 agent 可以接管后续对话，适合客服路由、销售流程、多角色协作            | 需要定义 active agent、上下文可见性、权限继承、客户端 UI 状态 | 延后。它会改变 Mido 当前“一个 server runner 拥有用户可见 loop”的核心边界   |
| `code / graph workflow`             | 用代码或图明确控制顺序、分支、并行、循环，便于测试和成本控制               | 需要额外 workflow API 和状态模型                              | 后续可作为 `server-sdk` 外围 helper，不放进 V1 核心协议                    |
| `parallel fan-out / gather`         | 研究、检索、方案探索可以并行，突破单模型上下文和耗时限制                   | token 和协调成本高，失败恢复更复杂                            | 可在 V1 API 上由应用代码实现；SDK 先提供安全 child runner primitive        |
| `generator-critic / evaluator loop` | 通过 reviewer 或 evaluator agent 提升输出质量                              | 容易变成无限迭代，需要 budget 和验收标准                      | 后续结合 evaluator/run artifact 做标准化                                   |

外部设计参考：

- [OpenAI Agents SDK - Orchestrating multiple agents](https://openai.github.io/openai-agents-python/multi_agent/)
- [OpenAI Agents SDK - Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [LangGraph multi-agent collaboration](https://langchain-ai.github.io/langgraph/tutorials/multi_agent/multi-agent-collaboration/)
- [Google ADK multi-agent systems](https://adk.dev/agents/multi-agents/)
- [CrewAI introduction](https://docs.crewai.com/en/introduction)
- [Anthropic - How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

## V1 产品决策

V1 只做一个能力：把 child `AgentRunner` 包装成根 runner 可注册的 `server` tool。

目标行为：

- 根 runner 的 `runId`、事件流、客户端协议和最终回答保持不变。
- child runner 使用独立 `childRunId`，默认使用独立 child thread。
- child runner 可以拥有自己的 model adapter、system prompt、server tools、tool policy、skill registry 和 stores。
- child runner 的事件不直接插入父 run 的 SSE stream，避免客户端协议膨胀。
- 父 run 的 `TOOL_RESULT.output` 返回紧凑 `AgentToolResult`，包含 `agentId`、`childRunId`、`status`、`outputText` 或 `error`。
- 通过 metadata 和 trace 关联父子运行，开发者可以用 `EventStore.loadEvents()` 查看 child run 细节。

V1 明确不做：

- 不支持 child agent 暂停等待 `client_auto` 或 `client_interactive` tool。
- 不增加 `CoreEvent` 新枚举。
- 不做 first-class graph DSL。
- 不做 handoff 后的 active agent UI 状态。
- 不让 child agent 默认继承父 runner 的全部工具。

目标形态：

```text
----------------------+        server tool call         +----------------------+
| Root AgentRunner     | -----------------------------> | research_agent tool  |
| user-visible loop    |                                | wraps child runner   |
| client protocol owner| <----------------------------- | AgentToolResult      |
+----------------------+                                +----------+-----------+
                                                                  |
                                                                  v
                                                        +----------------------+
                                                        | Child AgentRunner    |
                                                        | isolated messages    |
                                                        | allowed tools only   |
                                                        +----------------------+
```

## API 设计

新增文件：`packages/server-sdk/src/agents.ts`

导出类型：

```ts
import type {
  JSONSchema,
  JsonObject,
  JsonValue,
  ToolDefinition,
} from "@mido/protocol-core";
import type {
  AgentRunner,
  RunExecutionContext,
  ServerToolRuntimeDefinition,
  ToolExecutionContext,
} from "./runner.js";

export interface AgentToolInput {
  task: string;
  context?: JsonObject;
  threadId?: string;
}

export interface AgentToolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export interface AgentToolResult {
  agentId: string;
  childRunId: string;
  childThreadId?: string;
  status: "completed" | "error";
  outputText?: string;
  error?: AgentToolError;
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
}

export interface AgentToolOptions {
  agentId: string;
  name: string;
  description: string;
  runner: AgentRunner;
  inputSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  timeoutMs?: number;
  maxModelCalls?: number;
  metadata?: ToolDefinition["metadata"];
  resolveThreadId?: (
    input: AgentToolInput,
    context: ToolExecutionContext,
  ) => string | undefined;
  buildMetadata?: (
    input: AgentToolInput,
    context: ToolExecutionContext,
  ) => JsonObject | undefined;
}
```

公开函数：

```ts
export function createAgentTool(
  options: AgentToolOptions,
): ServerToolRuntimeDefinition;
```

默认 input schema：

```ts
{
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', minLength: 1 },
    context: { type: 'object', additionalProperties: true },
    threadId: { type: 'string' }
  },
  required: ['task']
}
```

默认 result schema：

```ts
{
  type: 'object',
  additionalProperties: false,
  properties: {
    agentId: { type: 'string' },
    childRunId: { type: 'string' },
    childThreadId: { type: 'string' },
    status: { enum: ['completed', 'error'] },
    outputText: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: true }
      },
      required: ['code', 'message']
    },
    eventCount: { type: 'number' },
    modelCallCount: { type: 'number' },
    toolCallCount: { type: 'number' }
  },
  required: ['agentId', 'childRunId', 'status', 'eventCount', 'modelCallCount', 'toolCallCount']
}
```

`ToolExecutionContext` 需要增加两个只读上下文字段：

```ts
storageScope: StorageScope;
traceId: string;
```

这样 agent tool 可以把 child run 放进与父 run 一致的 storage scope，并用同一个 trace family 做关联。

## 文件结构

- Create: `packages/server-sdk/src/agents.ts`
  负责 `createAgentTool`、child run 收集、timeout/cancel、紧凑结果生成。
- Modify: `packages/server-sdk/src/runner.ts`
  给 server tool execution context 增加 `storageScope` 和 `traceId`。
- Modify: `packages/server-sdk/src/index.ts`
  导出 multi-agent 类型和 `createAgentTool`。
- Create: `tests/server-agents.test.ts`
  覆盖 parent 调 child、隔离工具、child error、child client tool unsupported、timeout、model call limit。
- Modify: `docs/architecture.md`
  增加 multi-agent V1 的边界说明。
- Modify: `README.md`
  增加最小用法示例。

---

### Task 1: 写失败测试，锁定 V1 行为

**Files:**

- Create: `tests/server-agents.test.ts`

- [ ] **Step 1: 新建 focused test 文件**

写入以下测试骨架。`ScriptedModelAdapter` 保持在测试内，避免污染 SDK API。

```ts
import {
  createAgentRunner,
  createAgentTool,
  InMemorySessionStore,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput,
} from "@mido/server-sdk";
import type {
  AgentMessage,
  CoreEvent,
  JsonObject,
  RunStartRequest,
} from "@mido/protocol-core";

class FunctionModelAdapter implements ModelAdapter {
  constructor(
    private readonly handler: (
      input: ModelAdapterRunInput,
    ) => ModelAdapterEvent[] | Promise<ModelAdapterEvent[]>,
  ) {}

  async *run(input: ModelAdapterRunInput): AsyncIterable<ModelAdapterEvent> {
    for (const event of await this.handler(input)) {
      yield event;
    }
  }
}

async function collect(stream: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function createUserMessage(text: string): AgentMessage {
  return {
    id: "msg-user",
    role: "user",
    createdAt: new Date().toISOString(),
    content: [{ type: "text", text }],
  };
}

function createRunRequest(text: string): RunStartRequest {
  return {
    runId: "run-parent",
    threadId: "thread-parent",
    messages: [createUserMessage(text)],
  };
}

function eventTypes(events: CoreEvent[]): string[] {
  return events.map((event) => event.type);
}
```

- [ ] **Step 2: 添加 parent 调 child 的测试**

```ts
it("runs a child agent as a server tool and returns a compact result", async () => {
  const childRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter(() => [
      { type: "text-start", textId: "child-text" },
      {
        type: "text-delta",
        textId: "child-text",
        delta: "Research says Mido should use agent tools.",
      },
      {
        type: "text-end",
        textId: "child-text",
        text: "Research says Mido should use agent tools.",
      },
      { type: "done" },
    ]),
    sessionStore: new InMemorySessionStore(),
  });

  const parentRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter((input) => {
      const hasToolResult = input.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.some((part) => part.type === "tool-result"),
      );

      if (!hasToolResult) {
        return [
          {
            type: "tool-call",
            toolCallId: "call-research",
            toolName: "researchAgent",
            args: { task: "Analyze the best multi-agent V1 for Mido." },
          },
          { type: "done" },
        ];
      }

      return [
        {
          type: "text-end",
          textId: "parent-text",
          text: "Use sub-agents as server tools.",
        },
        { type: "done" },
      ];
    }),
    sessionStore: new InMemorySessionStore(),
  });

  parentRunner.registerTool(
    createAgentTool({
      agentId: "research",
      name: "researchAgent",
      description: "Delegate focused research tasks to the research agent.",
      runner: childRunner,
    }),
  );

  const events = await collect(
    parentRunner.run(createRunRequest("Plan multi-agent support.")),
  );
  const toolResult = events.find((event) => event.type === "TOOL_RESULT");

  expect(eventTypes(events)).toEqual([
    "RUN_STARTED",
    "MODEL_CALL_START",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "MODEL_CALL_END",
    "TOOL_RESULT",
    "MODEL_CALL_START",
    "TEXT_END",
    "MODEL_CALL_END",
    "RUN_FINISHED",
  ]);
  expect(toolResult).toMatchObject({
    type: "TOOL_RESULT",
    toolName: "researchAgent",
    output: {
      agentId: "research",
      status: "completed",
      outputText: "Research says Mido should use agent tools.",
      eventCount: 5,
      modelCallCount: 1,
      toolCallCount: 0,
    },
  });
});
```

- [ ] **Step 3: 添加 child client tool unsupported 的测试**

```ts
it("returns a controlled error when a child agent waits for a client tool", async () => {
  const childRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter(() => [
      {
        type: "tool-call",
        toolCallId: "client-call",
        toolName: "localClientTool",
        args: {},
      },
      { type: "done" },
    ]),
    sessionStore: new InMemorySessionStore(),
  });

  const parentRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter((input) => {
      const hasToolResult = input.messages.some(
        (message) => message.role === "tool",
      );
      return hasToolResult
        ? [{ type: "done" }]
        : [
            {
              type: "tool-call",
              toolCallId: "call-child",
              toolName: "childAgent",
              args: { task: "Use local tool." },
            },
            { type: "done" },
          ];
    }),
    sessionStore: new InMemorySessionStore(),
  });

  parentRunner.registerTool(
    createAgentTool({
      agentId: "child",
      name: "childAgent",
      description: "Delegate to child agent.",
      runner: childRunner,
    }),
  );

  const events = await collect(
    parentRunner.run(createRunRequest("Run child.")),
  );
  const result = events.find((event) => event.type === "TOOL_RESULT");

  expect(result).toMatchObject({
    type: "TOOL_RESULT",
    isError: true,
    output: {
      agentId: "child",
      status: "error",
      error: {
        code: "subagent_client_tool_unsupported",
      },
    },
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: fail，原因是 `createAgentTool` 和 `packages/server-sdk/src/agents.ts` 尚不存在。

- [ ] **Step 5: Commit**

```bash
git add tests/server-agents.test.ts
git commit -m "test: cover server agent tools"
```

---

### Task 2: 实现 `createAgentTool`

**Files:**

- Create: `packages/server-sdk/src/agents.ts`
- Test: `tests/server-agents.test.ts`

- [ ] **Step 1: 创建类型、schema 和导出函数**

实现 `AgentToolInput`、`AgentToolResult`、`AgentToolOptions` 和 `createAgentTool()`。`createAgentTool()` 返回 `ServerToolRuntimeDefinition`，`executionPolicy` 固定为 `server`。

核心实现：

```ts
import {
  createId,
  nowIso,
  type AgentMessage,
  type CoreEvent,
  type JSONSchema,
  type JsonObject,
  type JsonValue,
  type ToolDefinition,
} from "@mido/protocol-core";

import type {
  AgentRunner,
  RunExecutionContext,
  ServerToolRuntimeDefinition,
  ToolExecutionContext,
} from "./runner.js";

export interface AgentToolInput {
  task: string;
  context?: JsonObject;
  threadId?: string;
}

export interface AgentToolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export interface AgentToolResult {
  agentId: string;
  childRunId: string;
  childThreadId?: string;
  status: "completed" | "error";
  outputText?: string;
  error?: AgentToolError;
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
}

export interface AgentToolOptions {
  agentId: string;
  name: string;
  description: string;
  runner: AgentRunner;
  inputSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  timeoutMs?: number;
  maxModelCalls?: number;
  metadata?: ToolDefinition["metadata"];
  resolveThreadId?: (
    input: AgentToolInput,
    context: ToolExecutionContext,
  ) => string | undefined;
  buildMetadata?: (
    input: AgentToolInput,
    context: ToolExecutionContext,
  ) => JsonObject | undefined;
}
```

- [ ] **Step 2: 实现默认 schema**

```ts
const defaultAgentToolInputSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    task: { type: "string", minLength: 1 },
    context: { type: "object", additionalProperties: true },
    threadId: { type: "string" },
  },
  required: ["task"],
};

const defaultAgentToolResultSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentId: { type: "string" },
    childRunId: { type: "string" },
    childThreadId: { type: "string" },
    status: { enum: ["completed", "error"] },
    outputText: { type: "string" },
    error: {
      type: "object",
      additionalProperties: true,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        details: { type: "object", additionalProperties: true },
      },
      required: ["code", "message"],
    },
    eventCount: { type: "number" },
    modelCallCount: { type: "number" },
    toolCallCount: { type: "number" },
  },
  required: [
    "agentId",
    "childRunId",
    "status",
    "eventCount",
    "modelCallCount",
    "toolCallCount",
  ],
};
```

- [ ] **Step 3: 实现 child run collector**

collector 必须只根据 `CoreEvent` 推导紧凑结果。

```ts
async function collectChildRun(
  stream: AsyncIterable<CoreEvent>,
  options: {
    agentId: string;
    childRunId: string;
    childThreadId?: string;
    maxModelCalls?: number;
  },
): Promise<AgentToolResult> {
  const textParts: string[] = [];
  let finalError: AgentToolError | undefined;
  let completed = false;
  let awaitingClientTool = false;
  let eventCount = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;

  for await (const event of stream) {
    eventCount += 1;

    if (event.type === "MODEL_CALL_START") {
      modelCallCount += 1;
      if (
        options.maxModelCalls !== undefined &&
        modelCallCount > options.maxModelCalls
      ) {
        return createAgentToolErrorResult(
          options,
          {
            code: "subagent_model_call_limit_exceeded",
            message: `Sub-agent "${options.agentId}" exceeded maxModelCalls=${options.maxModelCalls}`,
          },
          eventCount,
          modelCallCount,
          toolCallCount,
        );
      }
    }

    if (event.type === "TOOL_CALL_END") {
      toolCallCount += 1;
    }

    if (event.type === "TEXT_END" && event.text) {
      textParts.push(event.text);
    }

    if (event.type === "RUN_ERROR") {
      finalError = {
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
        details: event.error.details,
      };
    }

    if (event.type === "RUN_FINISHED") {
      completed = event.finishReason === "completed";
      awaitingClientTool = event.finishReason === "awaiting_client_tool";
    }
  }

  if (awaitingClientTool) {
    return createAgentToolErrorResult(
      options,
      {
        code: "subagent_client_tool_unsupported",
        message: `Sub-agent "${options.agentId}" requested a client tool, which is not supported by createAgentTool V1`,
      },
      eventCount,
      modelCallCount,
      toolCallCount,
    );
  }

  if (!completed || finalError) {
    return createAgentToolErrorResult(
      options,
      finalError ?? {
        code: "subagent_incomplete",
        message: `Sub-agent "${options.agentId}" did not complete`,
      },
      eventCount,
      modelCallCount,
      toolCallCount,
    );
  }

  return {
    agentId: options.agentId,
    childRunId: options.childRunId,
    childThreadId: options.childThreadId,
    status: "completed",
    outputText: textParts.join("\n").trim(),
    eventCount,
    modelCallCount,
    toolCallCount,
  };
}
```

- [ ] **Step 4: 实现 timeout/cancel**

timeout 时取消 child run，并返回标准 tool error。

```ts
async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => Promise<void>,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      await onTimeout();
      reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
```

- [ ] **Step 5: 实现 `createAgentTool()` 主流程**

```ts
export function createAgentTool(
  options: AgentToolOptions,
): ServerToolRuntimeDefinition {
  return {
    name: options.name,
    description: options.description,
    executionPolicy: "server",
    inputSchema: options.inputSchema ?? defaultAgentToolInputSchema,
    resultSchema: options.resultSchema ?? defaultAgentToolResultSchema,
    timeoutMs: options.timeoutMs,
    metadata: {
      ...(options.metadata ?? {}),
      mido: {
        ...(isJsonObject(options.metadata?.mido) ? options.metadata.mido : {}),
        kind: "agent_tool",
        agentId: options.agentId,
      },
    },
    async execute(args, context) {
      const input = normalizeAgentToolInput(args);
      const childRunId = createId("run");
      const childThreadId =
        input.threadId ??
        options.resolveThreadId?.(input, context) ??
        createId("thread");
      const metadata = compactJsonObject({
        ...(options.buildMetadata?.(input, context) ?? {}),
        traceId: context.traceId,
        parentRunId: context.runId,
        parentThreadId: context.threadId,
        agentId: options.agentId,
      });
      const executionContext: RunExecutionContext = {
        storageScope: context.storageScope,
      };
      const stream = options.runner.run(
        {
          runId: childRunId,
          threadId: childThreadId,
          messages: [createAgentToolUserMessage(input)],
          state: input.context ?? {},
          metadata,
        },
        executionContext,
      );

      try {
        return await runWithTimeout(
          collectChildRun(stream, {
            agentId: options.agentId,
            childRunId,
            childThreadId,
            maxModelCalls: options.maxModelCalls,
          }),
          options.timeoutMs,
          async () => {
            await options.runner.cancelRun(
              { runId: childRunId, reason: "subagent_timeout" },
              executionContext,
            );
          },
        );
      } catch (error) {
        return createAgentToolErrorResult(
          {
            agentId: options.agentId,
            childRunId,
            childThreadId,
            maxModelCalls: options.maxModelCalls,
          },
          {
            code: "subagent_execution_failed",
            message:
              error instanceof Error
                ? error.message
                : "Sub-agent execution failed",
          },
          0,
          0,
          0,
        );
      }
    },
  };
}
```

- [ ] **Step 6: 运行测试**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: `ToolExecutionContext` 缺少 `storageScope` 和 `traceId` 导致 TypeScript 或 runtime 失败。

- [ ] **Step 7: Commit**

```bash
git add packages/server-sdk/src/agents.ts tests/server-agents.test.ts
git commit -m "feat: add server agent tool primitive"
```

---

### Task 3: 给 server tool context 补齐 storage 和 trace 信息

**Files:**

- Modify: `packages/server-sdk/src/runner.ts`
- Test: `tests/server-agents.test.ts`

- [ ] **Step 1: 扩展 `ToolExecutionContext`**

在 `packages/server-sdk/src/runner.ts` 中修改接口：

```ts
export interface ToolExecutionContext {
  runId: string;
  threadId?: string;
  state: JsonObject;
  metadata?: JsonObject;
  messages: AgentMessage[];
  storageScope: StorageScope;
  traceId: string;
  signal?: AbortSignal;
}
```

- [ ] **Step 2: 传入 context 字段**

在 server tool execute 调用处补充字段：

```ts
const output = await withTimeout(
  Promise.resolve(
    runtimeDefinition.execute?.(toolCall.args, {
      runId: context.runId,
      threadId: context.threadId,
      messages: context.messages,
      metadata: context.metadata,
      state: context.state,
      storageScope: context.storageScope,
      traceId: context.traceId,
      signal: dependencies.signal,
    }),
  ),
  getToolTimeoutMs(definition),
  definition.name,
  dependencies.signal,
);
```

- [ ] **Step 3: 运行 focused test**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: parent 调 child 测试通过；如果 timeout/model limit 测试尚未补齐，本任务只要求已有测试通过。

- [ ] **Step 4: Commit**

```bash
git add packages/server-sdk/src/runner.ts tests/server-agents.test.ts
git commit -m "feat: pass storage context to server tools"
```

---

### Task 4: 补齐 error、timeout 和 limit 测试

**Files:**

- Modify: `tests/server-agents.test.ts`
- Modify: `packages/server-sdk/src/agents.ts`

- [ ] **Step 1: 添加 child run error 测试**

```ts
it("returns a controlled error when the child agent fails", async () => {
  const childRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter(() => [
      {
        type: "error",
        code: "provider_failed",
        message: "provider unavailable",
        retryable: true,
      },
    ]),
    sessionStore: new InMemorySessionStore(),
  });

  const parentRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter((input) =>
      input.messages.some((message) => message.role === "tool")
        ? [{ type: "done" }]
        : [
            {
              type: "tool-call",
              toolCallId: "call-child",
              toolName: "childAgent",
              args: { task: "Fail." },
            },
            { type: "done" },
          ],
    ),
    sessionStore: new InMemorySessionStore(),
  });

  parentRunner.registerTool(
    createAgentTool({
      agentId: "child",
      name: "childAgent",
      description: "Delegate to child agent.",
      runner: childRunner,
    }),
  );

  const events = await collect(
    parentRunner.run(createRunRequest("Run child.")),
  );
  const result = events.find((event) => event.type === "TOOL_RESULT");

  expect(result).toMatchObject({
    type: "TOOL_RESULT",
    isError: true,
    output: {
      status: "error",
      error: {
        code: "provider_failed",
        message: "provider unavailable",
        retryable: true,
      },
    },
  });
});
```

- [ ] **Step 2: 添加 max model calls 测试**

```ts
it("stops collecting when the child agent exceeds maxModelCalls", async () => {
  const childRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter((input) => {
      const hasToolResult = input.messages.some(
        (message) => message.role === "tool",
      );
      return hasToolResult
        ? [{ type: "text-end", text: "second call" }, { type: "done" }]
        : [
            {
              type: "tool-call",
              toolCallId: "server-call",
              toolName: "noop",
              args: {},
            },
            { type: "done" },
          ];
    }),
    sessionStore: new InMemorySessionStore(),
  });

  childRunner.registerTool({
    name: "noop",
    description: "No-op server tool.",
    executionPolicy: "server",
    inputSchema: { type: "object" },
    resultSchema: { type: "object" },
    execute: () => ({}),
  });

  const parentRunner = createAgentRunner({
    modelAdapter: new FunctionModelAdapter((input) =>
      input.messages.some((message) => message.role === "tool")
        ? [{ type: "done" }]
        : [
            {
              type: "tool-call",
              toolCallId: "call-child",
              toolName: "childAgent",
              args: { task: "Loop." },
            },
            { type: "done" },
          ],
    ),
    sessionStore: new InMemorySessionStore(),
  });

  parentRunner.registerTool(
    createAgentTool({
      agentId: "child",
      name: "childAgent",
      description: "Delegate to child agent.",
      runner: childRunner,
      maxModelCalls: 1,
    }),
  );

  const events = await collect(
    parentRunner.run(createRunRequest("Run child.")),
  );
  const result = events.find((event) => event.type === "TOOL_RESULT");

  expect(result).toMatchObject({
    type: "TOOL_RESULT",
    isError: true,
    output: {
      status: "error",
      error: {
        code: "subagent_model_call_limit_exceeded",
      },
    },
  });
});
```

- [ ] **Step 3: 让 parent `TOOL_RESULT.isError` 跟随 `AgentToolResult.status`**

在 `runner.ts` 的 server tool 成功执行路径中，`createAgentTool` 返回的是合法 result，但如果 `status === 'error'`，父 run 的 `TOOL_RESULT` 应标记 `isError: true`。实现方式：在 `createAgentTool()` 的 `execute` 返回 error result 时抛出带结构化 payload 的内部错误，或在 runner 中增加一个最小 helper 识别 `output` 的 `status: 'error'`。

推荐保持 runner 简洁：在 `agents.ts` 中定义内部错误类。

```ts
export class AgentToolExecutionError extends Error {
  constructor(readonly result: AgentToolResult) {
    super(result.error?.message ?? "Sub-agent execution failed");
    this.name = "AgentToolExecutionError";
  }
}
```

当 child result 为 error 时，`execute` 抛出 `AgentToolExecutionError`。在 `runner.ts` 的 server tool catch 分支中，如果 `error instanceof AgentToolExecutionError`，用 `error.result` 作为 tool output，而不是通用 `{ code, message }`。

- [ ] **Step 4: 运行 focused test**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: 所有 `server-agents` 测试通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server-sdk/src/agents.ts packages/server-sdk/src/runner.ts tests/server-agents.test.ts
git commit -m "test: cover agent tool failure modes"
```

---

### Task 5: 导出 public API

**Files:**

- Modify: `packages/server-sdk/src/index.ts`
- Test: `tests/server-agents.test.ts`

- [ ] **Step 1: 从 server SDK 导出类型和函数**

```ts
export type {
  AgentToolError,
  AgentToolInput,
  AgentToolOptions,
  AgentToolResult,
} from "./agents.js";
export { AgentToolExecutionError, createAgentTool } from "./agents.js";
```

- [ ] **Step 2: 运行 TypeScript 检查**

```bash
pnpm lint
```

Expected: pass。

- [ ] **Step 3: 运行 focused test**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: pass。

- [ ] **Step 4: Commit**

```bash
git add packages/server-sdk/src/index.ts
git commit -m "feat: export server agent tools"
```

---

### Task 6: 文档化 Mido 的 multi-agent 边界

**Files:**

- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 `docs/architecture.md`**

在 server SDK responsibility 之后加入：

```md
### Server multi-agent orchestration

Mido's first multi-agent primitive is `supervisor + sub-agents as server tools`.
The root `AgentRunner` remains the user-visible loop owner. A specialist agent can
be wrapped with `createAgentTool(...)` and registered as a normal `server` tool.

The child agent runs as a separate server run with its own `runId`, optional
`threadId`, model adapter, system prompt, tool registry, policy, skills, and stores.
The child run does not stream directly to the client. The parent receives a compact
tool result containing `agentId`, `childRunId`, status, output text, and counters.

V1 intentionally does not implement handoff, swarm, or a first-class graph runtime.
Those patterns require explicit protocol and UI state for active agents, context
visibility, permission inheritance, and resumable child client tools.
```

- [ ] **Step 2: 更新 `README.md` 用法示例**

在 Agent Skills 或 Core design 附近加入：

```ts
const researchRunner = createAgentRunner({
  modelAdapter: researchModel,
  sessionStore,
  systemPrompt:
    "You are a research specialist. Return concise findings with sources.",
});

const mainRunner = createAgentRunner({
  modelAdapter: mainModel,
  sessionStore,
  systemPrompt: "You are the supervisor. Delegate research tasks when useful.",
});

mainRunner.registerTool(
  createAgentTool({
    agentId: "research",
    name: "researchAgent",
    description: "Delegate focused research tasks and return concise findings.",
    runner: researchRunner,
    maxModelCalls: 3,
    timeoutMs: 60_000,
  }),
);
```

并补充中文说明：

```md
Use this pattern when a specialist needs its own prompt, model, tools, or policy,
but the root agent should keep ownership of the user-facing conversation. Use
application-level code for parallel fan-out/gather in V1; do not model handoffs
through `createAgentTool`.
```

- [ ] **Step 3: 运行文档相关检查**

```bash
pnpm lint
```

Expected: pass。

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: document server multi-agent primitive"
```

---

### Task 7: 全量验证

**Files:**

- No code changes.

- [ ] **Step 1: 运行 focused tests**

```bash
pnpm test -- tests/server-agents.test.ts
```

Expected: pass。

- [ ] **Step 2: 运行 server SDK 相关测试**

```bash
pnpm test -- tests/server-sdk.test.ts tests/server-skills.test.ts tests/server-summary-messages.test.ts
```

Expected: pass。

- [ ] **Step 3: 运行全量测试**

```bash
pnpm test
```

Expected: pass。

- [ ] **Step 4: 运行类型检查**

```bash
pnpm lint
```

Expected: pass。

- [ ] **Step 5: 运行 build**

```bash
pnpm build
```

Expected: pass。

- [ ] **Step 6: Commit**

```bash
git status --short
git commit -m "feat: support server multi-agent tools"
```

## 验收标准

- 根 runner 可以把任务委托给 child runner，并在同一个父 run 中继续最终回答。
- child runner 的 prompt、tools、policy 和 storage 能独立配置。
- child run 不直接改变客户端协议。
- child 请求客户端工具时，父 run 得到明确、可测试的 error tool result。
- timeout、model call limit、child provider error 都有稳定错误码。
- `EventStore` 可以通过 `childRunId` 查看 child run 细节。
- `pnpm test`、`pnpm lint`、`pnpm build` 全部通过。

## 风险和后续方向

- **上下文膨胀：**child output 必须紧凑返回，后续可增加 output compressor。
- **权限继承：**V1 不继承父工具权限；每个 child runner 显式注册工具和 policy。
- **并行调度：**V1 API 支持应用代码并行调用多个 child runners，但 SDK 不内置 graph runtime。
- **handoff：**需要新增 active agent、context visibility、resume semantics 和 UI 状态，后续单独设计。
- **评估闭环：**multi-agent 成本更高，建议先完成 evaluator/run artifact 后再推进复杂 graph/swarm。
