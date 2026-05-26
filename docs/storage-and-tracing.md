# 持久存储和 Tracing

Mido 的持久化分成三类存储，不把它们合在一起：

- `SessionStore`：保存短期 checkpoint，用来恢复等待客户端工具结果的 run。
- `ThreadStore`：保存长期 thread snapshot，包括消息、共享状态、metadata 和 thread lifecycle。
- `EventStore`：保存 run 的 `CoreEvent` 日志，用于 replay、inspector 和审计。

这个拆分让 checkpoint TTL 可以很短，同时不影响长期对话历史和事件追踪。

## Storage scope

Mido 的 server SDK 和 client SDK 运行在接入方自己的服务端之后。SDK 不负责鉴权，也不内置 `tenantId`、`userId`、JWT、登录态等业务概念；是否鉴权、怎么鉴权、匿名用户怎么识别，都由接入方服务端决定。

为了支持不同用户、租户、workspace 或匿名会话之间的 session 隔离，存储层使用通用的 `storageScope` 作为命名空间。`storageScope` 只表达“这次 run 应该落到哪个存储空间”，不是权限系统。

```ts
export interface StorageScope {
  segments: string[];
}

export interface RunExecutionContext {
  storageScope?: StorageScope;
}
```

典型 scope 示例：

```ts
// SaaS 多租户应用
{ segments: ['tenant', tenantId, 'user', userId] }

// 单用户或消费者应用
{ segments: ['user', userId] }

// 匿名浏览器会话
{ segments: ['anonymous', sessionCookieId] }

// workspace 级隔离
{ segments: ['workspace', workspaceId] }

// 本地 demo 或单租户服务
{ segments: ['default'] }
```

推荐调用方式是在接入方服务端完成鉴权或匿名会话解析后，把可信上下文转换成 `storageScope`，再调用 runner：

```ts
const events = runner.run(request, {
  storageScope: {
    segments: ['tenant', req.auth.tenantId, 'user', req.auth.userId]
  }
});

const resumed = runner.resume(request, {
  storageScope: {
    segments: ['tenant', req.auth.tenantId, 'user', req.auth.userId]
  }
});
```

client SDK 不应该负责传 `tenantId`、`userId` 或 `storageScope`。客户端只提交 `runId`、`threadId`、消息和 tool result；服务端根据自己的可信请求上下文决定使用哪个 scope。这样可以避免把不可信的客户端字段当作存储隔离依据。

如果调用方没有传 `storageScope`，SDK 应归一化为默认 scope：

```ts
{ segments: ['default'] }
```

这样可以保持现有 demo、单用户服务和旧代码的行为兼容。

## Store scope contract

改造后，`runId` 和 `threadId` 不再是全局唯一查找键，而是某个 `storageScope` 内部的逻辑 id。所有持久化读写都应先解析 scope，再访问底层存储。

推荐的 store 语义是：

```ts
interface SessionStore {
  saveCheckpoint(scope: StorageScope, checkpoint: RunCheckpoint): Promise<void>;
  loadCheckpoint(scope: StorageScope, runId: string): Promise<RunCheckpoint | null>;
  deleteCheckpoint(scope: StorageScope, runId: string): Promise<void>;
  heartbeat(scope: StorageScope, runId: string): Promise<void>;
}

interface ThreadStore {
  saveThread(scope: StorageScope, thread: ThreadSnapshot): Promise<void>;
  loadThread(scope: StorageScope, threadId: string): Promise<StoredThread | null>;
}

interface EventStore {
  appendEvent(scope: StorageScope, event: CoreEvent): Promise<void>;
  loadEvents(scope: StorageScope, query: EventStoreQuery): Promise<CoreEvent[]>;
}
```

`resume` 和 `cancelRun` 是最关键的隔离点。它们必须使用接入方服务端解析出的 scope 调用 `loadCheckpoint(scope, runId)`，不能只用全局 `runId` 查 checkpoint。如果在当前 scope 下找不到 checkpoint，应返回普通的 `checkpoint_not_found`，不要暴露“该 run 是否存在于其他 scope”。

Redis 等 KV 存储可以使用稳定 hash 作为 key 前缀，避免把业务 id、邮箱、手机号等敏感字段直接写入 key：

```text
mido:scope:<scopeHash>:session:<runId>
mido:scope:<scopeHash>:thread:<threadId>
mido:scope:<scopeHash>:run-index:<runId>
```

value 中可以冗余保存 `scopeHash`、`runId`、`threadId` 等元数据，便于调试和防御性校验。

## 推荐文件系统布局

`@mido/server-sdk` 的文件系统存储应使用 scope-first 布局。`rootDir` 仍然可以配置为项目根目录下的 `.mido-store`：

```ts
import {
  FileSystemEventStore,
  FileSystemThreadStore,
  InMemorySessionStore,
  createAgentRunner
} from '@mido/server-sdk';

const runner = createAgentRunner({
  modelAdapter,
  sessionStore: new InMemorySessionStore(),
  threadStore: new FileSystemThreadStore({ rootDir: './.mido-store' }),
  eventStore: new FileSystemEventStore({ rootDir: './.mido-store' })
});
```

web demo 可以继续通过 `MIDO_STORE_DIR` 改路径：

```bash
MIDO_STORE_DIR=./tmp/mido-store pnpm demo
```

推荐文件布局：

```text
.mido-store/
  scopes/
    <scopeId>/
      scope.json
      sessions/
        <runId>.checkpoint.json
      threads/
        <threadId>/
          snapshot.json
          runs/
            <runId>/
              events.jsonl
      run-index/
        <runId>.json
```

`<scopeId>` 由 `storageScope.segments` 计算得到，例如：

```ts
const scopeId = 'scp_' + sha256(JSON.stringify(storageScope.segments)).slice(0, 32);
```

不建议直接把 `tenantId`、`userId` 等业务字段展开成目录名，例如 `.mido-store/tenants/<tenantId>/users/<userId>/...`。SDK 应保持通用，只理解 `scopes/<scopeId>`；具体 scope 代表租户、用户、workspace 还是匿名会话，由接入方决定。

`scope.json` 用于调试和校验。若 scope segments 不含敏感信息，可以保存原始 segments：

```json
{
  "scopeId": "scp_8f3a9c2e4b1d7a0f91c6e2d5a4b7c8e9",
  "segments": ["tenant", "tenant_123", "user", "user_456"],
  "createdAt": "2026-05-26T10:00:00.000Z"
}
```

如果 segments 可能包含敏感信息，应只保存 hash 和必要的非敏感调试字段：

```json
{
  "scopeId": "scp_8f3a9c2e4b1d7a0f91c6e2d5a4b7c8e9",
  "scopeHash": "8f3a9c2e4b1d7a0f91c6e2d5a4b7c8e9",
  "createdAt": "2026-05-26T10:00:00.000Z"
}
```

`sessions/<runId>.checkpoint.json` 保存短期 checkpoint，用于等待 client tool result 后 resume。这个目录可以按 TTL 清理：

```json
{
  "scopeId": "scp_8f3a9c2e4b1d7a0f91c6e2d5a4b7c8e9",
  "runId": "run_abc",
  "threadId": "thread_001",
  "checkpoint": {
    "runId": "run_abc",
    "threadId": "thread_001",
    "sequence": 12,
    "messages": [],
    "state": {},
    "pendingToolCalls": [],
    "submittedToolResults": [],
    "processedToolCallIds": [],
    "updatedAt": "2026-05-26T10:01:00.000Z"
  },
  "createdAt": "2026-05-26T10:00:00.000Z",
  "updatedAt": "2026-05-26T10:01:00.000Z",
  "expiresAt": "2026-05-26T10:06:00.000Z"
}
```

`threads/<threadId>/snapshot.json` 保存当前 scope 内的最新 thread snapshot。`threads/<threadId>/runs/<runId>/events.jsonl` 每行保存一个 `CoreEvent`，顺序和 stream 顺序一致。

`run-index/<runId>.json` 用于在当前 scope 内通过 `runId` 快速定位 `threadId`，避免旧式全局 `EventStore.loadEvents({ runId })` 语义下扫描所有 thread：

```json
{
  "runId": "run_abc",
  "threadId": "thread_001",
  "createdAt": "2026-05-26T10:00:00.000Z"
}
```

这个布局把 scope、thread、run、event 的关系直接体现在文件系统里。人工检查时，可以先定位 scope，再打开某个 thread 目录查看 snapshot 和该 thread 下每次 run 的事件日志。

`snapshot.json` 里还会保存 `messageIndex`，用于从 message id 快速找到相关 run：

```json
{
  "threadId": "thread_1",
  "messages": [],
  "messageIndex": {
    "msg_user_1": {
      "triggeredRunId": "run_1"
    },
    "msg_assistant_1": {
      "createdByRunId": "run_1"
    }
  }
}
```

这里存的是当前 scope 内的逻辑引用，不是全局文件路径：

- `triggeredRunId`：这个 user message 触发了哪个 run。
- `createdByRunId`：这个 assistant、tool 或 system message 由哪个 run 生成。

拿到任意一个 run id 后，可以用 `EventStore.loadEvents(scope, { runId })` 读取当前 scope 下对应 run 的事件详情。文件系统实现会通过 `run-index/<runId>.json` 定位到 `threads/<threadId>/runs/<runId>/events.jsonl`。

客户端提交下一轮对话历史时，应保留 streamed event 里的 assistant `messageId`。如果客户端重新生成本地 id，后续 snapshot 只能知道这条消息属于哪个 run，不能和 `events.jsonl` 里的同一条 message id 精确对齐。

## Thread lifecycle

`snapshot.json` 可以包含 `lifecycle` 字段。它有两个独立状态轴：

- `userState`：用户或产品行为，比如 `active`、`archived`。
- `contextState`：系统对模型上下文是否还能继续运行的判断，比如 `ok`、`frozen`。

默认状态表示 thread 没有归档，context 也还可以继续：

```json
{
  "threadId": "thread_1",
  "lifecycle": {
    "userState": {
      "state": "active"
    },
    "contextState": {
      "state": "ok"
    }
  }
}
```

当最后一条 `summary` 加上保留窗口仍然超过模型输入预算时，runner 会把 `contextState` 标记为 `frozen`。这不是某一次 run 的完成状态，而是 thread 级上下文状态。后续同一个 `threadId` 的新 run 会在调用 model 前被拒绝，返回 `thread_context_frozen`，并且不会把这次请求消息追加到 snapshot。

```json
{
  "threadId": "thread_1",
  "lifecycle": {
    "userState": {
      "state": "active"
    },
    "contextState": {
      "state": "frozen",
      "reason": "context_budget_exhausted",
      "frozenAt": "2026-05-11T10:00:00.000Z",
      "frozenByRunId": "run_42",
      "estimatedInputTokens": 1200000,
      "maxInputTokens": 950000,
      "lastSummaryMessageId": "msg_summary_9"
    }
  }
}
```

冻结只在“已经存在 summary，并且压缩后的 thread continuation 自身仍然超预算”时触发。单条新用户输入太大时，runner 只拒绝本次 run，不冻结 thread。这样可以避免用户粘贴一段超大日志后，把原本可继续的 thread 永久锁死。

`archived` 可以和 `frozen` 同时存在，因为它们不是同一种状态。`archived` 来自用户或产品操作，`frozen` 来自系统预算判断。runner 会先处理 `archived`，返回 `thread_archived`；如果未归档但 context 已冻结，才返回 `thread_context_frozen`。

```json
{
  "threadId": "thread_1",
  "lifecycle": {
    "userState": {
      "state": "archived",
      "archivedAt": "2026-05-11T10:05:00.000Z",
      "archivedBy": "user_1"
    },
    "contextState": {
      "state": "frozen",
      "reason": "context_budget_exhausted",
      "frozenAt": "2026-05-11T10:00:00.000Z",
      "frozenByRunId": "run_42",
      "estimatedInputTokens": 1200000,
      "maxInputTokens": 950000,
      "lastSummaryMessageId": "msg_summary_9"
    }
  }
}
```

UI 可以把冻结态作为只读状态展示，并引导用户 fork：

```text
+--------------------------------------------+
| This thread is frozen                      |
| Context is too large to continue safely.   |
|                                            |
| [Fork with summary] [Export transcript]    |
+--------------------------------------------+
```

## Summary 压缩消息

`snapshot.json.messages` 可以包含 `role: "summary"` 的压缩摘要消息。UI 和审计仍然保留完整消息数组。server 发送下一次 model input 时，如果发现 `summary` 消息，会使用最后一条 `summary` 作为裁剪点：保留所有 `system` 消息，保留最后一条 `summary`，再保留它之后从第一条 `user` 开始的消息。`summary` 之前的非 `system` 消息不会发送给 model。

生成 `summary` 时必须扫描被覆盖范围内的 `tool-result`，把有意义的工具结论写进 summary 文本。`summary` 在本地 snapshot 中保持自己的 role，不会改成 `user`。如果 provider 不支持 `summary` role，adapter 只在 provider payload 层把它映射成 assistant-like message。

完整示例：

```json
{
  "threadId": "thread_1",
  "messages": [
    {
      "id": "msg_system_1",
      "role": "system",
      "createdAt": "2026-05-09T10:00:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "You are a helpful coding agent."
        }
      ]
    },
    {
      "id": "msg_user_1",
      "role": "user",
      "createdAt": "2026-05-09T10:01:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "设计 thread snapshot 的压缩机制。"
        }
      ]
    },
    {
      "id": "msg_assistant_1",
      "role": "assistant",
      "createdAt": "2026-05-09T10:02:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "建议使用 summary message 作为裁剪点。"
        },
        {
          "type": "tool-call",
          "toolCallId": "call_read_docs",
          "toolName": "workspace_read_file",
          "args": {
            "path": "docs/storage-and-tracing.md"
          },
          "executionPolicy": "server"
        }
      ]
    },
    {
      "id": "msg_tool_1",
      "role": "tool",
      "createdAt": "2026-05-09T10:02:10.000Z",
      "content": [
        {
          "type": "tool-result",
          "toolCallId": "call_read_docs",
          "toolName": "workspace_read_file",
          "output": {
            "path": "docs/storage-and-tracing.md",
            "summary": "ThreadStore saves snapshot.json and EventStore saves per-run events.jsonl."
          }
        }
      ]
    },
    {
      "id": "msg_summary_1",
      "role": "summary",
      "createdAt": "2026-05-09T10:30:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "Summary: 用户要设计 thread-local summary compaction。已决定 snapshot.json.messages 保留完整历史并插入 summary 消息；发送 model input 时保留 system、最后一条 summary，以及 summary 后从第一条 user 开始的窗口。workspace_read_file returned path docs/storage-and-tracing.md: ThreadStore saves snapshot.json and EventStore saves per-run events.jsonl."
        }
      ]
    },
    {
      "id": "msg_user_2",
      "role": "user",
      "createdAt": "2026-05-09T10:31:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "继续实现代码。"
        }
      ]
    },
    {
      "id": "msg_assistant_2",
      "role": "assistant",
      "createdAt": "2026-05-09T10:32:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "已经开始实现协议和 runner。"
        }
      ]
    }
  ],
  "messageIndex": {
    "msg_user_1": {
      "triggeredRunId": "run_1"
    },
    "msg_assistant_1": {
      "createdByRunId": "run_1"
    },
    "msg_tool_1": {
      "createdByRunId": "run_1"
    },
    "msg_summary_1": {
      "createdByRunId": "run_2"
    },
    "msg_user_2": {
      "triggeredRunId": "run_2"
    },
    "msg_assistant_2": {
      "createdByRunId": "run_2"
    }
  },
  "state": {},
  "metadata": {},
  "updatedAt": "2026-05-09T10:32:00.000Z",
  "createdAt": "2026-05-09T10:00:00.000Z"
}
```

## 存储抽象

后续要接 Redis、SQL、对象存储或其他部署环境，不需要改 runner。只需要实现对应接口：

```ts
interface ThreadStore {
  saveThread(scope: StorageScope, thread: ThreadSnapshot): Promise<void>;
  loadThread(scope: StorageScope, threadId: string): Promise<StoredThread | null>;
}

interface EventStore {
  appendEvent(scope: StorageScope, event: CoreEvent): Promise<void>;
  loadEvents(scope: StorageScope, query: EventStoreQuery): Promise<CoreEvent[]>;
}
```

建议实现规则：

- `ThreadStore` 以 `storageScope + threadId` 为主键。
- `EventStore` 以 `storageScope + runId` 为主要查询键。
- `ThreadStore` 可以保存 `messageIndex`，让 `messageId` 指向当前 scope 内触发或创建它的 `runId`。
- event append 应保持顺序。
- event load 应按 `sequence` 升序返回。
- 文件系统实现会从 `RUN_STARTED.threadId` 在当前 scope 下记录 `runId -> threadId` 到 `run-index/<runId>.json`，进程重启后也能在同一 scope 内恢复这个关系。
- 存储失败默认应该让 run 失败，避免用户误以为已经完成审计记录。

## Trace Metadata

`CoreEvent` 现在带有可选 `trace` 字段。老客户端可以忽略它，新 inspector 可以直接消费它。

核心字段：

- `traceId`：一次 run 或外部 trace 的统一 id。默认使用 `runId`。
- `spanId`：事件所属 span。工具事件默认使用 `toolCallId`。
- `name`：事件或工具 span 名称。
- `kind`：`run`、`model`、`tool`、`state` 或 `transport`。
- `startedAt` / `endedAt` / `durationMs`：用于延迟分析。
- `attributes`：工具名、执行策略、错误状态等结构化字段。

如果 `RunStartRequest.metadata.traceId` 是字符串，runner 会优先使用它作为 `traceId`。否则使用 `runId`。

模型调用现在有独立 lifecycle events：

- `MODEL_CALL_START`
- `MODEL_CALL_END`

`MODEL_CALL_END` 会在 adapter 能提供时记录 `provider`、`model`、`providerRequestId` 和 `usage`。这些字段让 inspector 可以把模型耗时、token 用量和 provider 请求串起来看。工具调用仍然使用 `TOOL_CALL_*` 和 `TOOL_RESULT`，所以 model span 和 tool span 是分开的。

## Run Inspector 数据

`@mido/protocol-core` 提供 `buildRunTrace(events)`，可以从一组 `CoreEvent` 生成 inspector 友好的摘要：

- run status
- startedAt / endedAt / durationMs
- eventCount
- modelCalls
- toolCalls
- errors

示例：

```ts
import { buildRunTrace } from '@mido/protocol-core';

const events = await eventStore.loadEvents(scope, { runId });
const trace = buildRunTrace(events);
```

这里的 `scope` 应由接入方服务端从可信请求上下文解析得到。这一步不依赖文件系统；只要能从当前 scope 下的任意 `EventStore` 读出 events，就能生成同样的 run trace。
