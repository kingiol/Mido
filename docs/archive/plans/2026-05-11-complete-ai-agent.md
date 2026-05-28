# 完整 AI Agent 实施计划

> **给执行 agent 的要求：**实现本计划时，必须使用 `superpowers:subagent-driven-development`，推荐方式，或 `superpowers:executing-plans`，按任务逐项执行。每个步骤都用复选框格式追踪。

**目标：**把 Mido 从一个已经比较扎实的 agent SDK runtime，推进成一个可用于真实产品集成的完整 AI Agent 参考实现。它需要具备安全工具执行、持久记忆、运行恢复、可观察性、provider 适配验证、完整 reference app 和发布文档。

**架构：**继续保持服务端掌控的 agent loop 作为核心。完整 agent 所需的产品能力放在核心 loop 外围，包括权限事件、运行 replay、持久 memory、browser/workspace 执行面、provider conformance、可复用 inspector 和参考应用。可选能力放在 `@mido/toolkit-core` 里，避免让 `@mido/server-sdk` 绑定某个业务场景。

**技术栈：**TypeScript、pnpm workspace、Vitest、React、SSE + HTTP POST transport、JSON Schema、MCP Streamable HTTP、filesystem/Redis stores、可选 vector store adapter、Vite demo app。

---

## 产品定义

这里的“完整 AI Agent”不是指把所有功能都塞进 `apps/web-demo`。更准确的定义是：

- SDK 层提供稳定协议、运行恢复、权限、安全工具、记忆、观测和 provider 抽象。
- 工具包层提供可选能力：workspace、browser、search、retrieval、memory、MCP。
- reference app 层展示完整体验：聊天、任务状态、权限确认、记忆管理、运行检查、导出、恢复。
- conformance 层保证 native client 和新 provider 不靠猜。

这个方向保留 Mido 当前最有价值的部分：清楚的 runtime 边界。Mido 不应该变成一个单一 app，它应该先成为可靠的 agent 底座，再用 reference app 证明这套底座能跑完整产品体验。

## 目标界面形态

```text
+--------------------------------------------------------------------------------+
| Mido Agent                                                                     |
+--------------------------------------------------------------------------------+
| 线程                | 对话                                 | 运行检查           |
| - 当前任务          | user: refactor this package           | status: running    |
| - 研究记录          | agent: I need workspace access        | model calls: 2     |
| - 支持工单          |                                      | tool calls: 4      |
|                     | + 需要权限确认 --------------------+ | errors: 0          |
|                     | | workspace_apply_patch              |                    |
|                     | | scope: workspace:file:write        | Timeline           |
|                     | | [Approve] [Reject] [Details]       | - model start      |
|                     | +-----------------------------------+ | - tool call        |
|                     |                                      | - resume           |
+--------------------------------------------------------------------------------+
| 记忆 | 技能 | 工具 | 设置                                                   |
+--------------------------------------------------------------------------------+
```

## 总体里程碑

1. 权限协议：高风险动作能暂停 run，并通过标准事件请求 UI 确认。
2. 运行恢复：浏览器刷新、SSE 断线、工具中断后能 replay 并继续。
3. 持久记忆和检索：长期知识能跨进程重启保存。
4. Browser 和 workspace 执行：可选工具足够安全，能处理真实任务。
5. Provider conformance：adapter 能证明自己支持哪些能力。
6. 可复用 inspector：event trace 成为可集成的调试产品。
7. 参考 agent app：demo 升级成真正的集成样板。
8. 发布准备：文档、示例、迁移说明和包发布路径完整。

---

### 任务 1: 标准权限事件

**文件：**
- 修改：`packages/protocol-core/src/index.ts`
- 修改：`packages/conformance/src/index.ts`
- 修改：`packages/conformance/docs/event-sequence.md`
- 修改：`packages/server-sdk/src/runner.ts`
- 修改：`packages/client-core/src/index.ts`
- 修改：`packages/client-web/src/index.tsx`
- 修改：`apps/web-demo/src/App.tsx`
- 测试：`tests/server-sdk.test.ts`
- 测试：`tests/client-core.test.ts`
- 测试：`tests/client-web.test.tsx`

- [ ] **步骤 1: 先写失败测试**

新增 server test。这个测试配置 `toolPolicy`，让 server tool 返回 `require_confirmation`。

```ts
expect(eventTypes(events)).toEqual([
  'RUN_STARTED',
  'MODEL_CALL_START',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'MODEL_CALL_END',
  'PERMISSION_REQUIRED',
  'RUN_FINISHED'
]);

expect(events.at(-2)).toMatchObject({
  type: 'PERMISSION_REQUIRED',
  toolCallId: 'delete-1',
  level: 'strong',
  policyCode: 'delete_needs_approval'
});

expect(events.at(-1)).toMatchObject({
  type: 'RUN_FINISHED',
  finishReason: 'awaiting_permission'
});
```

运行：

```bash
pnpm test -- tests/server-sdk.test.ts -t "permission"
```

预期：失败。原因是 `PERMISSION_REQUIRED` 和 `awaiting_permission` 还不存在。

- [ ] **步骤 2: 扩展协议类型**

给 `RunFinishReason` 增加：

```ts
'awaiting_permission'
```

给 `CoreEvent` 增加 `PermissionRequiredEvent`。事件字段必须包含：

```ts
toolCallId: string;
toolId: string;
toolName: string;
modelName: string;
executionPolicy: ToolExecutionPolicy;
level: 'user' | 'strong';
policyCode: string;
reason: string;
argsPreview: JsonObject;
```

然后生成 schema：

```bash
pnpm run generate:schemas
```

预期：schema 文件更新，TypeScript 不报错。

- [ ] **步骤 3: 在 checkpoint 中保存待确认工具**

给 `RunCheckpoint` 增加：

```ts
pendingPermissionCalls?: ToolCallEnvelope[];
```

当 `evaluateToolPolicy()` 返回 `require_confirmation` 时，runner 需要：

- 保存 checkpoint；
- emit `PERMISSION_REQUIRED`；
- emit `RUN_FINISHED`，`finishReason` 为 `awaiting_permission`；
- 不执行工具；
- 不把它伪装成 tool error。

- [ ] **步骤 4: 设计权限确认后的 resume 行为**

继续使用现有 `RunResumeRequest`，不要新增一个平行协议。

用户批准时：

- client tool 走现有本地执行路径；
- server tool 让 server 从 checkpoint 中恢复并执行原始 tool call。

用户拒绝时，提交错误 tool result：

```ts
{
  code: 'permission_rejected',
  message: 'User rejected tool execution'
}
```

server 必须校验 resumed `toolCallId` 存在于 `pendingToolCalls` 或 `pendingPermissionCalls`。

- [ ] **步骤 5: 扩展 client 状态**

给 `AgentClientSnapshot` 增加：

```ts
pendingPermissions: PermissionRequestSnapshot[];
```

给 `AgentClient` 增加方法：

```ts
approvePermission(toolCallId: string): Promise<void>;
rejectPermission(toolCallId: string, reason?: string): Promise<void>;
```

`approvePermission()` 对 client runtime 工具复用现有 `executeClientTool()`。对 server runtime 工具，提交 approval resume 请求，让 server 执行原始工具。

- [ ] **步骤 6: 增加 React hook 和 demo UI**

从 `@mido/client-web` 导出：

```ts
usePendingPermissions(client)
```

在 `apps/web-demo/src/App.tsx` 增加权限卡片。

```text
+------------------------------------------+
| 需要权限确认                             |
| Tool: workspace_apply_patch              |
| Risk: high                               |
| Reason: Needs write access               |
|                                          |
| [Approve] [Reject] [Show args]           |
+------------------------------------------+
```

- [ ] **步骤 7: 验证**

运行：

```bash
pnpm test -- tests/server-sdk.test.ts tests/client-core.test.ts tests/client-web.test.tsx
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 8: 提交**

```bash
git add packages/protocol-core packages/conformance packages/server-sdk packages/client-core packages/client-web apps/web-demo tests
git commit -m "feat: add permission confirmation events"
```

---

### 任务 2: Run replay、reconnect 和 checkpoint recovery

**文件：**
- 修改：`packages/protocol-core/src/index.ts`
- 修改：`packages/server-sdk/src/store.ts`
- 修改：`packages/server-sdk/src/runner.ts`
- 修改：`packages/client-core/src/index.ts`
- 修改：`packages/client-web/src/index.tsx`
- 修改：`apps/web-demo/server.ts`
- 修改：`apps/web-demo/src/App.tsx`
- 测试：`tests/server-sdk.test.ts`
- 测试：`tests/client-core.test.ts`
- 测试：`tests/client-web.test.tsx`

- [ ] **步骤 1: 先写 replay 失败测试**

server test：

```ts
const events = await eventStore.loadEvents({ runId, afterSequence: 3 });
expect(events.every(event => event.sequence > 3)).toBe(true);
```

client test：

```ts
await client.reconnectRun({ runId: 'run-1', afterSequence: 4 });
expect(client.getSnapshot().status).toBe('awaiting_client_tool');
```

运行：

```bash
pnpm test -- tests/server-sdk.test.ts tests/client-core.test.ts -t "reconnect"
```

预期：失败。原因是 client reconnect API 还不存在。

- [ ] **步骤 2: 增加 server replay API**

给 runner 暴露：

```ts
loadRunEvents(query: EventStoreQuery): Promise<CoreEvent[]>;
```

如果没有配置 `eventStore`，HTTP 层返回 `run_replay_unavailable`。不要从 client snapshot 伪造 replay。

- [ ] **步骤 3: 增加 client reconnect API**

给 `AgentClient` 增加：

```ts
reconnectRun(options: { runId: string; afterSequence?: number }): Promise<void>;
```

client 行为：

- 拉取缺失 events；
- 按 `sequence` 顺序 apply；
- 如果 replay 后状态是 `awaiting_client_tool`，继续 flush pending auto tools。

- [ ] **步骤 4: 增加 browser transport 支持**

给 `BrowserSseTransportOptions` 增加：

```ts
replayUrl?: string;
```

demo server 增加：

```text
GET /api/runs/:runId/events?afterSequence=N
```

返回：

```json
{
  "events": []
}
```

- [ ] **步骤 5: 增加 UI reconnect 控制**

当 status 是 `error` 且存在 run id 时，显示：

```text
+--------------------------------+
| 连接已中断                     |
| 最后一条事件 sequence: 18       |
| [重新连接 run] [新建 run]       |
+--------------------------------+
```

- [ ] **步骤 6: 验证**

```bash
pnpm test -- tests/server-sdk.test.ts tests/client-core.test.ts tests/client-web.test.tsx
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 7: 提交**

```bash
git add packages/protocol-core packages/server-sdk packages/client-core packages/client-web apps/web-demo tests
git commit -m "feat: add run replay and reconnect support"
```

---

### 任务 3: 持久 memory 和 retrieval adapter

**文件：**
- 新建：`packages/toolkit-core/src/memory/fs-store.ts`
- 新建：`packages/toolkit-core/src/retrieval/fs-store.ts`
- 新建：`packages/toolkit-core/src/retrieval/vector-store.ts`
- 修改：`packages/toolkit-core/src/memory.ts`
- 修改：`packages/toolkit-core/src/search-retrieval.ts`
- 修改：`packages/toolkit-core/src/index.ts`
- 修改：`packages/toolkit-core/package.json`
- 修改：`apps/web-demo/demo-toolkit.ts`
- 测试：`packages/toolkit-core/src/index.test.ts`

- [ ] **步骤 1: 先写持久化失败测试**

写入 memory 后重新创建 store，再读回来。

```ts
const rootDir = await mkdtemp(join(tmpdir(), 'mido-memory-'));
const first = new FileSystemMemoryStore({ rootDir });
const entry = await first.write({
  scope: 'demo',
  text: 'favorite color is teal',
  reason: 'user preference'
});

const second = new FileSystemMemoryStore({ rootDir });
expect(await second.read('demo', entry.id)).toMatchObject({
  text: 'favorite color is teal'
});
```

运行：

```bash
pnpm test -- packages/toolkit-core/src/index.test.ts -t "persistent"
```

预期：失败。原因是 filesystem store 还不存在。

- [ ] **步骤 2: 实现 filesystem memory store**

使用 JSONL 存储：

```text
<rootDir>/memory/<scope>.jsonl
```

规则：

- 每一行是一条完整 `MemoryEntry`；
- `write()` append；
- `read()` 返回最新的未删除 entry；
- `delete()` append tombstone record，存在 entry 时返回 `true`。

- [ ] **步骤 3: 实现 filesystem retrieval store**

使用 JSONL 存储：

```text
<rootDir>/retrieval/<namespace>.jsonl
```

第一版继续使用现有 `rankByText()`。接口保持和未来 vector search 兼容。

- [ ] **步骤 4: 增加 vector store interface**

增加：

```ts
export interface VectorRetrievalStore extends RetrievalStore {
  indexEmbeddings(namespace: string, documents: RetrievalDocument[]): Promise<RetrievalEntry[]>;
}
```

不要引入具体 vendor dependency。这里只增加 adapter interface 和文档注释。

- [ ] **步骤 5: demo 接入持久 store**

在 `apps/web-demo/demo-toolkit.ts` 中使用：

```text
.mido-store/toolkit/memory
.mido-store/toolkit/retrieval
```

测试仍然允许注入 in-memory store。

- [ ] **步骤 6: 验证**

```bash
pnpm test -- packages/toolkit-core/src/index.test.ts tests/web-demo-mcp-lifecycle.test.ts
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 7: 提交**

```bash
git add packages/toolkit-core apps/web-demo tests
git commit -m "feat: add durable memory and retrieval stores"
```

---

### 任务 4: 安全 workspace write 和 command mode

**文件：**
- 修改：`packages/toolkit-core/src/workspace/files.ts`
- 修改：`packages/toolkit-core/src/workspace/command.ts`
- 修改：`packages/toolkit-core/src/types.ts`
- 修改：`apps/web-demo/demo-toolkit.ts`
- 修改：`apps/web-demo/src/App.tsx`
- 测试：`packages/toolkit-core/src/index.test.ts`
- 测试：`tests/web-demo-mcp-lifecycle.test.ts`

- [ ] **步骤 1: 先写 dry-run patch 失败测试**

```ts
const result = await applyPatchTool.execute?.({
  path: 'notes.txt',
  replacements: [{ oldText: 'hello', newText: 'hi' }],
  dryRun: true
});

expect(result).toMatchObject({
  path: 'notes.txt',
  changed: true,
  dryRun: true
});
expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('hello');
```

运行：

```bash
pnpm test -- packages/toolkit-core/src/index.test.ts -t "dry-run"
```

预期：失败。原因是 `dryRun` 还不存在。

- [ ] **步骤 2: 增加 patch preview 输出**

返回结构：

```ts
{
  path: string;
  changed: boolean;
  dryRun: boolean;
  replacementsApplied: number;
  preview: {
    before: string;
    after: string;
  };
}
```

`preview.before` 和 `preview.after` 受 `maxReadBytes` 限制。

- [ ] **步骤 3: 加固 command execution**

增加选项：

```ts
killSignal?: NodeJS.Signals;
killAfterMs?: number;
maxRuntimeMs?: number;
```

超时后先发 `SIGTERM`，等待 `killAfterMs`，再发 `SIGKILL`。

输出必须包含：

```ts
{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}
```

- [ ] **步骤 4: write tools 必须走权限**

demo 里只有当下面变量为 true 时才注册 write 和 command tools：

```text
MIDO_DEMO_ENABLE_WRITE_TOOLS=true
```

启用时必须配置 `toolPolicy`，让 write 和 command tools 触发 permission events，而不是静默执行。

- [ ] **步骤 5: 验证**

```bash
pnpm test -- packages/toolkit-core/src/index.test.ts tests/web-demo-mcp-lifecycle.test.ts
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 6: 提交**

```bash
git add packages/toolkit-core apps/web-demo tests
git commit -m "feat: harden workspace write and command tools"
```

---

### 任务 5: Browser automation reference adapter

**文件：**
- 新建：`packages/toolkit-core/src/browser/playwright-adapter.ts`
- 修改：`packages/toolkit-core/src/browser.ts`
- 修改：`packages/toolkit-core/src/index.ts`
- 修改：`packages/toolkit-core/package.json`
- 新建：`tests/browser-toolkit.test.ts`
- 修改：`apps/web-demo/src/App.tsx`

- [ ] **步骤 1: 先写 browser adapter 失败测试**

用 Playwright 打开本地 HTML 页面。

```ts
const adapter = await createPlaywrightBrowserAutomationAdapter();
const tools = createBrowserAutomationTools(adapter);
const open = tools.find(tool => tool.name === 'browser_open');
const snapshot = tools.find(tool => tool.name === 'browser_snapshot');

await open?.execute?.({ url: serverUrl });
const result = await snapshot?.execute?.({});

expect(JSON.stringify(result)).toContain('Submit');
```

运行：

```bash
pnpm test -- tests/browser-toolkit.test.ts
```

预期：失败。原因是 adapter 文件还不存在。

- [ ] **步骤 2: 实现 Playwright adapter**

新增：

```ts
createPlaywrightBrowserAutomationAdapter(options?: {
  allowedOrigins?: string[];
  headless?: boolean;
}): Promise<BrowserAutomationAdapter>
```

规则：

- `browser_open` 在配置 `allowedOrigins` 后拒绝不在列表中的 origin；
- `browser_click` 和 `browser_type` 默认仍是 `client_interactive`；
- `browser_snapshot` 返回 URL、title 和 visible text；
- `browser_screenshot` 返回 base64 和 MIME type。

- [ ] **步骤 3: demo UI 增加 browser 状态**

默认 disabled，只有 `VITE_ENABLE_BROWSER_TOOLS=true` 时展示可用状态。

```text
+--------------------------------------+
| Browser 工具                          |
| 状态: disabled                        |
| 设置 VITE_ENABLE_BROWSER_TOOLS 启用   |
+--------------------------------------+
```

- [ ] **步骤 4: 验证**

```bash
pnpm test -- tests/browser-toolkit.test.ts packages/toolkit-core/src/index.test.ts
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 5: 提交**

```bash
git add packages/toolkit-core apps/web-demo tests
git commit -m "feat: add Playwright browser toolkit adapter"
```

---

### 任务 6: Provider conformance kit

**文件：**
- 新建：`packages/conformance/src/provider.ts`
- 新建：`packages/conformance/docs/provider-adapter-contract.md`
- 修改：`packages/conformance/src/index.ts`
- 修改：`packages/server-sdk/src/adapters/openai-responses.ts`
- 修改：`packages/server-sdk/src/adapters/openai-compatible.ts`
- 修改：`packages/server-sdk/src/adapters/deepseek.ts`
- 测试：`tests/provider-adapters.test.ts`

- [ ] **步骤 1: 先写 conformance helper 失败测试**

```ts
await expectProviderAdapterConformance({
  adapter,
  capabilities: adapter.capabilities,
  scenarios: ['text-stream', 'tool-call', 'tool-resume']
});
```

运行：

```bash
pnpm test -- tests/provider-adapters.test.ts -t "conformance"
```

预期：失败。原因是 helper 还不存在。

- [ ] **步骤 2: 实现 provider conformance helper**

导出：

```ts
export type ProviderConformanceScenario =
  | 'text-stream'
  | 'tool-call'
  | 'tool-resume'
  | 'reasoning-stream'
  | 'usage'
  | 'request-id';

export async function expectProviderAdapterConformance(input: {
  adapter: ModelAdapter;
  scenarios: ProviderConformanceScenario[];
}): Promise<void>;
```

helper 使用 scripted fake stream 或 mocked fetch。它不能依赖真实 API key。

- [ ] **步骤 3: 增加 adapter contract 文档**

文档必须说明：

- `modelName` 如何映射回内部 tool identity；
- 什么时候 `capabilities.tools.resumeWithResults` 必须是 false；
- `rawFinishReason` 如何保留；
- usage 和 request id 如何出现在 `MODEL_CALL_END`。

- [ ] **步骤 4: 验证**

```bash
pnpm test -- tests/provider-adapters.test.ts tests/deepseek-adapter.test.ts
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 5: 提交**

```bash
git add packages/conformance packages/server-sdk tests
git commit -m "feat: add provider adapter conformance helpers"
```

---

### 任务 7: 可复用 Run Inspector 包

**文件：**
- 新建：`packages/client-web/src/RunInspector.tsx`
- 修改：`packages/client-web/src/index.tsx`
- 修改：`apps/web-demo/src/App.tsx`
- 修改：`apps/web-demo/src/styles.css`
- 测试：`tests/client-web.test.tsx`
- 测试：`tests/web-demo-export.test.ts`

- [ ] **步骤 1: 先写组件失败测试**

测试 `RunInspector` 能从 `CoreEvent[]` 渲染 model calls、tool calls 和 errors。

```tsx
render(<RunInspector events={events} onExport={vi.fn()} />);

expect(screen.getByText('Run Inspector')).toBeInTheDocument();
expect(screen.getByText('MODEL_CALL_END')).toBeInTheDocument();
expect(screen.getByText('TOOL_RESULT')).toBeInTheDocument();
```

运行：

```bash
pnpm test -- tests/client-web.test.tsx -t "RunInspector"
```

预期：失败。原因是 component 还不存在。

- [ ] **步骤 2: 抽出 inspector UI**

把 `apps/web-demo/src/App.tsx` 中 trace summary 的渲染逻辑移动到：

```text
packages/client-web/src/RunInspector.tsx
```

props：

```ts
export interface RunInspectorProps {
  events: CoreEvent[];
  onExport?: () => void | Promise<void>;
  exportDisabled?: boolean;
}
```

- [ ] **步骤 3: 保持 demo 视觉行为稳定**

demo 中替换为：

```tsx
<RunInspector
  events={snapshot.events}
  onExport={exportTimeline}
  exportDisabled={snapshot.events.length === 0}
/>
```

- [ ] **步骤 4: 验证**

```bash
pnpm test -- tests/client-web.test.tsx tests/web-demo-export.test.ts
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 5: 提交**

```bash
git add packages/client-web apps/web-demo tests
git commit -m "feat: extract reusable run inspector"
```

---

### 任务 8: Reference agent app 加固

**文件：**
- 修改：`apps/web-demo/server.ts`
- 修改：`apps/web-demo/src/App.tsx`
- 修改：`apps/web-demo/src/styles.css`
- 新建：`apps/web-demo/src/thread-store.ts`
- 新建：`apps/web-demo/src/memory-panel.tsx`
- 新建：`apps/web-demo/src/tool-panel.tsx`
- 测试：`tests/web-demo-mcp-lifecycle.test.ts`
- 测试：`tests/client-web.test.tsx`

- [ ] **步骤 1: 先写 UI state 失败测试**

覆盖这些行为：

- thread list 至少渲染一个 active thread；
- memory panel 展示 scopes 和 entries；
- tool panel 展示 registered tools 和 risk labels；
- permission card 出现时，新消息发送被禁用。

运行：

```bash
pnpm test -- tests/client-web.test.tsx tests/web-demo-mcp-lifecycle.test.ts
```

预期：失败。原因是 panels 还不存在。

- [ ] **步骤 2: 增加本地 thread list**

实现 browser-side thread metadata store。

```ts
export interface DemoThreadSummary {
  threadId: string;
  title: string;
  status: AgentClientSnapshot['status'];
  updatedAt: string;
}
```

保存到 `localStorage`：

```text
mido.demo.threads.v1
```

- [ ] **步骤 3: 增加 memory panel**

行为：

- 通过 `memory_list_scopes` 列出 scopes；
- 通过 `memory_search` 搜索选中的 scope；
- 展示 entry text、reason、confidence 和 created time；
- 删除必须走 permission flow。

- [ ] **步骤 4: 增加 tool panel**

行为：

- 请求 `/api/health`；
- 展示 server tools、MCP tools、toolkit tools 和 skill count；
- 读取 `metadata.policy` 展示 risk labels；
- disabled capabilities 展示原因。

- [ ] **步骤 5: 调整 UI 布局**

保持工具型产品气质。不要做 landing page。第一屏就是 agent workspace。

```text
+------------+------------------------+-------------------+
| 线程       | 对话                    | Inspector         |
| 工具       | 权限卡片                | 事件时间线        |
| 记忆       | 输入框                  | 导出              |
+------------+------------------------+-------------------+
```

- [ ] **步骤 6: 验证**

```bash
pnpm test -- tests/client-web.test.tsx tests/web-demo-mcp-lifecycle.test.ts
pnpm lint
pnpm demo:build
```

预期：全部通过。

- [ ] **步骤 7: 提交**

```bash
git add apps/web-demo tests
git commit -m "feat: harden reference agent app"
```

---

### 任务 9: 发布准备和文档

**文件：**
- 新建：`docs/complete-agent.md`
- 新建：`docs/provider-adapters.md`
- 新建：`docs/permissions.md`
- 新建：`docs/recovery.md`
- 新建：`docs/memory-and-retrieval.md`
- 修改：`README.md`
- 修改：`packages/*/package.json`
- 测试：`tests/docs.test.ts`

- [ ] **步骤 1: 先写文档检查失败测试**

新增轻量测试，确认关键文档存在并包含必要标题。

```ts
expect(readFileSync('docs/permissions.md', 'utf8')).toContain('Permission Events');
expect(readFileSync('docs/recovery.md', 'utf8')).toContain('Replay');
expect(readFileSync('docs/memory-and-retrieval.md', 'utf8')).toContain('Persistent Stores');
```

运行：

```bash
pnpm test -- tests/docs.test.ts
```

预期：失败。原因是 docs 还不存在。

- [ ] **步骤 2: 编写 complete agent 文档**

`docs/complete-agent.md` 必须解释最终架构：

- server-owned loop；
- client-local tools；
- permission events；
- durable memory；
- replay and reconnect；
- provider conformance；
- reference app layout。

- [ ] **步骤 3: 检查 package metadata**

每个准备发布的包都要确认：

- `name`
- `version`
- `main`
- `module`
- `types`
- `exports`
- runtime dependencies
- React 包的 peer dependencies

root package 继续保留：

```json
{
  "private": true
}
```

直到发布流程明确。

- [ ] **步骤 4: 增加迁移说明**

需要说明这些行为变化：

- 新的 `RunFinishReason`；
- permission event handling；
- replay endpoint；
- persistent store options；
- provider conformance expectations。

- [ ] **步骤 5: 验证**

```bash
pnpm test
pnpm lint
pnpm build
```

预期：全部通过。

- [ ] **步骤 6: 提交**

```bash
git add README.md docs packages tests
git commit -m "docs: document complete agent release path"
```

---

## 完成标准

满足这些条件后，项目可以比较硬气地叫“完整 AI Agent”：

- 高风险 server tool 可以通过标准协议事件请求用户批准。
- 浏览器刷新后可以 replay run，并继续 pending client tools。
- memory 和 retrieval 数据能跨进程重启保存。
- workspace write 和 command tools 默认走 preview 或显式 approval。
- browser automation 有真实 adapter 和 origin guard。
- provider adapters 能在没有真实 API key 的情况下跑 conformance scenarios。
- inspector 能在 demo 之外复用。
- reference app 可以作为第一个完整集成样板。
- `pnpm test`、`pnpm lint`、`pnpm build` 全部通过。

## 自检

需求覆盖：

- Runtime safety 由 Task 1 和 Task 4 覆盖。
- Run reliability 由 Task 2 覆盖。
- Long-term knowledge 由 Task 3 覆盖。
- External execution capability 由 Task 5 覆盖。
- Provider reliability 由 Task 6 覆盖。
- Debuggability 由 Task 7 覆盖。
- Product completeness 由 Task 8 覆盖。
- Release readiness 由 Task 9 覆盖。

占位检查：

- 没有占位标记，也没有“补合适处理”这种不可执行步骤。
- 每个 task 都写了具体文件、测试命令、预期结果和 commit message。

类型一致性：

- 权限状态统一使用 `PERMISSION_REQUIRED`、`awaiting_permission`、`pendingPermissions`、`approvePermission()` 和 `rejectPermission()`。
- Replay 状态统一使用 `reconnectRun()` 和 `EventStoreQuery`。
- Store 名称统一使用 `FileSystemMemoryStore`、`FileSystemRetrievalStore` 和 `VectorRetrievalStore`。

## 执行交接

计划已保存到：

```text
docs/superpowers/plans/2026-05-11-complete-ai-agent.md
```

后续有两种执行方式：

1. Subagent-Driven：每个 task 派一个新的 subagent，任务之间做 review，适合快速推进。
2. Inline Execution：在当前会话里按 checkpoint 批量执行，适合你想持续盯着过程时使用。
