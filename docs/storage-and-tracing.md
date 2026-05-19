# 持久存储和 Tracing

Mido 的持久化分成三类存储，不把它们合在一起：

- `SessionStore`：保存短期 checkpoint，用来恢复等待客户端工具结果的 run。
- `ThreadStore`：保存长期 thread snapshot，包括消息、共享状态、metadata 和 thread lifecycle。
- `EventStore`：保存 run 的 `CoreEvent` 日志，用于 replay、inspector 和审计。

这个拆分让 checkpoint TTL 可以很短，同时不影响长期对话历史和事件追踪。

## 当前文件系统实现

`@mido/server-sdk` 提供两个文件系统 store：

- `FileSystemThreadStore`
- `FileSystemEventStore`

示例：

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

web demo 已经默认启用这个存储，保存到项目根目录的 `.mido-store`。可以通过 `MIDO_STORE_DIR` 改路径：

```bash
MIDO_STORE_DIR=./tmp/mido-store pnpm demo
```

文件布局：

```text
.mido-store/
  threads/
    <threadId>/
      snapshot.json
      runs/
        <runId>/
          events.jsonl
```

`threads/<threadId>/snapshot.json` 保存最新 thread snapshot。  
`threads/<threadId>/runs/<runId>/events.jsonl` 每行保存一个 `CoreEvent`，顺序和 stream 顺序一致。

这个布局把 thread、run、event 的关系直接体现在文件系统里。人工检查时，可以先打开某个 thread 目录，再查看它下面每次 run 的事件日志。

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

这里存的是逻辑引用，不是文件路径：

- `triggeredRunId`：这个 user message 触发了哪个 run。
- `createdByRunId`：这个 assistant、tool 或 system message 由哪个 run 生成。

拿到任意一个 run id 后，可以用 `EventStore.loadEvents({ runId })` 读取对应 run 的事件详情。文件系统实现会把它解析到 `threads/<threadId>/runs/<runId>/events.jsonl`。

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
  saveThread(thread: ThreadSnapshot): Promise<void>;
  loadThread(threadId: string): Promise<StoredThread | null>;
}

interface EventStore {
  appendEvent(event: CoreEvent): Promise<void>;
  loadEvents(query: EventStoreQuery): Promise<CoreEvent[]>;
}
```

建议实现规则：

- `ThreadStore` 以 `threadId` 为主键。
- `EventStore` 以 `runId` 为主要查询键。
- `ThreadStore` 可以保存 `messageIndex`，让 `messageId` 指向触发或创建它的 `runId`。
- event append 应保持顺序。
- event load 应按 `sequence` 升序返回。
- 文件系统实现会从 `RUN_STARTED.threadId` 记录 `runId -> threadId`，进程重启后也能通过目录扫描恢复这个关系。
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

const events = await eventStore.loadEvents({ runId });
const trace = buildRunTrace(events);
```

这一步不依赖文件系统。只要能从任意 `EventStore` 读出 events，就能生成同样的 run trace。
