# Agent Workflow Orchestration Design

> **给 agentic workers：**实现本计划时，必须使用 `superpowers:test-driven-development`。先写失败测试，再写实现。不要把 workflow 编排塞进 `toolkit-core`；这是 server runtime 能力，属于 `@mido-agent/server-sdk`。

**目标：**在 Mido server 端新增动态 multi-agent workflow 能力，让主 agent 可以自行判断是否创建多个子 agent，并控制这些 agent 的串行、并发或 DAG 依赖关系。

**核心结论：**保留现有 `createAgentTool(...)` 作为“固定 specialist agent”简单模式；新增 `createAgentWorkflowTool(...)` 作为“动态创建和调度多个 agents”的编排模式。两者都属于 `@mido-agent/server-sdk`，不放入 `@mido-agent/toolkit-core`。

---

## 背景

当前 V1 的 `createAgentTool(...)` 解决的是固定 delegation：

```text
main agent -> researchAgent tool -> child AgentRunner
```

它适合“我已经知道有哪些专家 agent”的场景，例如 `researchAgent`、`reviewerAgent`、`plannerAgent`。但用户现在需要的是更高一层：

```text
main agent 自己判断：
- 要不要创建子 agent；
- 创建几个子 agent；
- 每个 agent 负责什么任务；
- agent 之间是串行、并发，还是部分依赖；
- 如果预注册 template 不满足任务，能否创建临时 ad-hoc agent。
```

因此需要新增 workflow tool，而不是继续扩展单个 `createAgentTool(...)` 的输入形态。

## 设计边界

### 放在 `server-sdk`

`createAgentWorkflowTool(...)` 依赖这些 server runtime 概念：

- `AgentRunner`
- `ModelAdapter`
- `RunExecutionContext`
- `ToolExecutionContext`
- storage scope
- trace metadata
- tool policy
- child run cancellation

这些都不是 toolkit 能力。`toolkit-core` 仍然只放 workspace、search、browser、memory 这类“agent 可以调用的工具能力”。

推荐分层：

```text
@mido-agent/server-sdk
  createAgentRunner
  createAgentTool
  createAgentWorkflowTool
  AgentTemplateRegistry
  AgentWorkflowExecutor

@mido-agent/toolkit-core
  workspace tools
  search tools
  browser tools
  memory tools
```

### 不改客户端协议

V1 workflow 仍然表现为一个普通 `server` tool：

```text
main runner -> agentWorkflow tool -> internal child runs -> compact workflow result
```

child agent 的事件不直接流给客户端。客户端只看到父 run 的工具调用和工具结果。调试时通过 `workflowRunId`、`childRunId` 和 `EventStore` 查看内部细节。

## 主 agent 如何触发 workflow

接入方在初始化时注册一个 workflow 工具：

```ts
mainRunner.registerTool(
  createAgentWorkflowTool({
    name: "runAgentWorkflow",
    description: "Create and coordinate multiple agents for complex tasks.",
    templates,
    createAdHocRunner,
    limits: {
      maxAgents: 6,
      maxParallelAgents: 3,
      maxModelCallsPerAgent: 4,
      timeoutMs: 120_000,
    },
  }),
);
```

运行时，主 agent 自己决定是否调用 `runAgentWorkflow`。如果任务简单，它可以不调用；如果任务复杂，它可以调用并提交 workflow spec。

示例输入：

```json
{
  "agents": [
    {
      "id": "repo_research",
      "templateId": "research",
      "task": "Inspect the current server-sdk architecture and summarize extension points."
    },
    {
      "id": "pattern_research",
      "templateId": "research",
      "task": "Compare mainstream multi-agent orchestration patterns."
    },
    {
      "id": "design",
      "templateId": "architect",
      "task": "Design the Mido workflow API using the two research outputs.",
      "dependsOn": ["repo_research", "pattern_research"]
    }
  ]
}
```

执行图：

```text
repo_research      \
                    -> design
pattern_research   /
```

没有 `dependsOn` 的节点可以并发执行；有依赖的节点等依赖完成后再执行。

## Template 和 Ad-Hoc Agent

### 预注册 template

template 是 server 允许的 agent 类型：

```ts
const templates = {
  research: {
    description: "Research specialist with read-only tools.",
    createRunner: (context) =>
      createAgentRunner({
        modelAdapter: researchModel,
        sessionStore,
        eventStore,
        systemPrompt: "You are a research specialist. Return concise findings.",
      }),
  },
  architect: {
    description: "Architecture specialist for design synthesis.",
    createRunner: (context) =>
      createAgentRunner({
        modelAdapter: architectModel,
        sessionStore,
        eventStore,
        systemPrompt: "You are a software architecture specialist.",
      }),
  },
};
```

主 agent 优先选择 template，因为 template 的模型、工具、权限和 system prompt 都由 server 预先治理。

### 允许 ad-hoc agent

如果主 agent 认为现有 template 不满足任务，可以创建 ad-hoc agent，但必须经过 server 提供的 factory：

```ts
createAgentWorkflowTool({
  templates,
  allowAdHocAgents: true,
  createAdHocRunner: (request) =>
    createAgentRunner({
      modelAdapter: defaultWorkerModel,
      sessionStore,
      eventStore,
      systemPrompt: request.systemPrompt,
    }),
});
```

主 agent 可以提出：

```json
{
  "id": "security_reviewer",
  "mode": "ad_hoc",
  "task": "Review the design for permission and sandbox risks.",
  "systemPrompt": "You are a security-focused reviewer. Focus on permission boundaries."
}
```

但是 server 仍然控制：

- 是否允许 ad-hoc；
- 使用哪个 model adapter；
- 是否允许自定义 system prompt；
- 最多创建几个 agent；
- 每个 agent 能调用哪些工具；
- 是否允许写入、执行命令或访问外部网络。

也就是说，**主 agent 可以动态设计 worker，但不能绕过 server 的能力边界。**

## Workflow 输入接口

默认 tool input schema：

```ts
export interface AgentWorkflowInput {
  agents: AgentWorkflowAgentSpec[];
}

export interface AgentWorkflowAgentSpec {
  id: string;
  task: string;
  dependsOn?: string[];
  context?: JsonObject;
  templateId?: string;
  mode?: "template" | "ad_hoc";
  systemPrompt?: string;
  description?: string;
}
```

规则：

- `id` 必须在 workflow 内唯一。
- `dependsOn` 只能引用同一个 workflow 内已声明的 agent id。
- 图不能有环。
- `templateId` 存在时优先使用 template。
- `mode: 'ad_hoc'` 或没有可用 template 时，只有在 `allowAdHocAgents` 为 true 且提供 `createAdHocRunner` 时才允许创建。
- ad-hoc agent 的 `systemPrompt` 可以由主 agent 提供，但 server 可以在 factory 中改写、包裹或拒绝。

## Workflow 输出接口

默认 tool result：

```ts
export interface AgentWorkflowResult {
  workflowRunId: string;
  status: "completed" | "partial" | "error";
  agents: AgentWorkflowAgentResult[];
  executionOrder: string[];
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
}

export interface AgentWorkflowAgentResult {
  id: string;
  templateId?: string;
  mode: "template" | "ad_hoc";
  childRunId?: string;
  childThreadId?: string;
  status: "completed" | "error" | "skipped";
  outputText?: string;
  error?: AgentToolError;
  dependsOn?: string[];
}
```

`status` 语义：

- `completed`：所有 agent 都成功。
- `partial`：至少一个 agent 成功，至少一个失败或被跳过。
- `error`：没有任何 agent 成功，或 workflow spec 无法执行。

## 调度语义

workflow executor 使用 DAG 调度：

1. 解析所有 agent spec。
2. 校验 id 唯一、依赖存在、无环、数量不超过 `maxAgents`。
3. 找到所有依赖已完成的 ready nodes。
4. 最多并发执行 `maxParallelAgents` 个 ready nodes。
5. 一个 agent 完成后，将结果加入 `completedResults`。
6. dependent agent 启动时，会收到依赖 agent 的紧凑输出作为上下文。
7. 如果依赖失败，dependent 默认标记为 `skipped`，错误码为 `dependency_failed`。

依赖注入到 child prompt 的形式：

```text
Task:
<agent task>

Dependency results:
- repo_research: <outputText>
- pattern_research: <outputText>

Context:
<optional json context>
```

## 错误处理

标准错误码：

- `workflow_invalid_input`
- `workflow_duplicate_agent_id`
- `workflow_unknown_dependency`
- `workflow_cycle_detected`
- `workflow_agent_limit_exceeded`
- `workflow_parallel_limit_exceeded`
- `workflow_template_not_found`
- `workflow_ad_hoc_not_allowed`
- `workflow_ad_hoc_factory_missing`
- `workflow_dependency_failed`
- `workflow_agent_failed`
- `workflow_timeout`

错误原则：

- workflow spec 结构错误：整个 tool result `isError: true`。
- 单个 agent 失败：记录在该 agent result 中；workflow 可继续执行无依赖的其他节点。
- 依赖失败：dependent agent 不执行，标记 skipped。
- timeout/cancel：取消所有仍在运行的 child runs。

## 安全和治理

必须有 limits：

```ts
export interface AgentWorkflowLimits {
  maxAgents?: number;
  maxParallelAgents?: number;
  maxModelCallsPerAgent?: number;
  timeoutMs?: number;
}
```

推荐默认值：

```ts
{
  maxAgents: 5,
  maxParallelAgents: 2,
  maxModelCallsPerAgent: 4,
  timeoutMs: 120_000
}
```

ad-hoc agent 必须受限：

- 默认关闭。
- 必须显式 `allowAdHocAgents: true`。
- 必须提供 `createAdHocRunner`。
- server factory 可以拒绝危险 prompt 或危险工具请求。
- ad-hoc runner 默认不继承 parent runner 的工具。

## 实现任务

### Task 1: 添加失败测试

新增 `tests/server-agent-workflows.test.ts`，覆盖：

- template agents 可以按 DAG 串并行执行；
- dependent agent 能看到依赖结果；
- ad-hoc agent 在允许时可以创建；
- ad-hoc agent 在未允许时返回明确错误；
- cycle/unknown dependency 返回明确错误。

### Task 2: 实现 workflow 类型和 executor

在 `packages/server-sdk/src/agents.ts` 中新增：

- `AgentWorkflowInput`
- `AgentWorkflowAgentSpec`
- `AgentWorkflowResult`
- `AgentWorkflowAgentResult`
- `AgentWorkflowTemplate`
- `AgentWorkflowLimits`
- `CreateAgentWorkflowToolOptions`
- `createAgentWorkflowTool(...)`

### Task 3: 导出 API

在 `packages/server-sdk/src/index.ts` 导出新增类型和函数。

### Task 4: 更新文档

更新：

- `README.md`
- `docs/architecture.md`

说明 `createAgentTool` 和 `createAgentWorkflowTool` 的差异。

### Task 5: 验证

运行：

```bash
pnpm test -- tests/server-agent-workflows.test.ts tests/server-agents.test.ts
pnpm lint
pnpm build
pnpm test
```

## 验收标准

- 主 agent 可以通过一个 workflow server tool 动态声明多个 agent。
- workflow 支持无依赖并发、有依赖串行和混合 DAG。
- workflow 优先使用预注册 template。
- template 不满足时，允许通过受控 factory 创建 ad-hoc agent。
- ad-hoc 默认关闭，未开启时有明确错误。
- workflow 内部 child runs 可通过 `childRunId` 和 `EventStore` 调试。
- 不修改客户端协议。
- 不把 workflow 编排放入 `toolkit-core`。
