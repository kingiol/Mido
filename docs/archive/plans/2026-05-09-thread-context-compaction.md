# Summary Message 上下文压缩实施计划

> **给 agent worker：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。步骤使用 checkbox（`- [ ]`）跟踪进度。

**目标：** `snapshot.json.messages` 继续保存完整对话，同时允许在 messages 中插入一条 `summary` 消息。发送给 SDK 内部 agent/model adapter 时，如果存在 `summary`，保留所有 `system` 消息，保留最后一条 `summary` 及其之后的消息，丢弃它之前的非 `system` 消息。

**架构：** 把 `summary` 做成 `AgentMessage.role` 的一等角色，而不是额外的 `ThreadSnapshot.context` 字段。UI 和审计仍然读完整 `messages`；runner 只在 SDK 内部 model input 边界做窗口选择。生成 summary 时要扫描被压缩范围内有意义的 tool 结果，把仍会影响后续任务的事实写进 summary 文本。provider adapter 负责把内部 `summary` role 映射成具体 LLM API 支持的 assistant-like message，不能映射成 `user`。

**技术栈：** TypeScript、Vitest、`@mido-agent/protocol-core`、`@mido-agent/server-sdk`、provider adapters、conformance schemas。

---

## 数据结构

压缩后的 `snapshot.json` 仍然只有一个长期消息数组：

```json
{
  "threadId": "thread_1",
  "messages": [
    {
      "id": "msg_system_1",
      "role": "system",
      "createdAt": "2026-05-09T10:00:00.000Z",
      "content": [{ "type": "text", "text": "You are a helpful agent." }]
    },
    {
      "id": "msg_user_1",
      "role": "user",
      "createdAt": "2026-05-09T10:01:00.000Z",
      "content": [{ "type": "text", "text": "第一轮问题" }]
    },
    {
      "id": "msg_assistant_1",
      "role": "assistant",
      "createdAt": "2026-05-09T10:01:08.000Z",
      "content": [{ "type": "text", "text": "第一轮回答" }]
    },
    {
      "id": "msg_tool_1",
      "role": "tool",
      "createdAt": "2026-05-09T10:01:10.000Z",
      "content": [
        {
          "type": "tool-result",
          "toolCallId": "call_1",
          "toolName": "lookup",
          "output": {
            "path": "docs/storage-and-tracing.md",
            "summary": "当前持久化结构是 `.mido-store/threads/<threadId>/snapshot.json` 和 runs events.jsonl。"
          }
        }
      ]
    },
    {
      "id": "msg_summary_1",
      "role": "summary",
      "createdAt": "2026-05-09T10:05:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "Summary: 用户正在设计 agent 上下文压缩。已决定 UI 保留完整 messages，agent 请求从 summary 消息开始裁剪历史，system 消息始终保留。重要 tool 事实：lookup 工具读取 docs/storage-and-tracing.md，确认当前持久化结构是 `.mido-store/threads/<threadId>/snapshot.json` 和 runs events.jsonl。"
        }
      ]
    },
    {
      "id": "msg_user_2",
      "role": "user",
      "createdAt": "2026-05-09T10:06:00.000Z",
      "content": [{ "type": "text", "text": "继续实现。" }]
    },
    {
      "id": "msg_assistant_2",
      "role": "assistant",
      "createdAt": "2026-05-09T10:06:20.000Z",
      "content": [{ "type": "text", "text": "已记录 summary 方案。" }]
    },
    {
      "id": "msg_user_3",
      "role": "user",
      "createdAt": "2026-05-09T10:07:00.000Z",
      "content": [{ "type": "text", "text": "下一步怎么做？" }]
    }
  ],
  "messageIndex": {
    "msg_user_1": { "triggeredRunId": "run_1" },
    "msg_assistant_1": { "createdByRunId": "run_1" },
    "msg_tool_1": { "createdByRunId": "run_1" },
    "msg_summary_1": { "createdByRunId": "run_compact_1" },
    "msg_assistant_2": { "createdByRunId": "run_2" },
    "msg_user_2": { "triggeredRunId": "run_2" },
    "msg_user_3": { "triggeredRunId": "run_3" }
  },
  "state": {},
  "metadata": {},
  "createdAt": "2026-05-09T10:00:00.000Z",
  "updatedAt": "2026-05-09T10:06:00.000Z"
}
```

发送给 SDK 内部 agent/model adapter 时，上面的 messages 会变成：

```text
system(msg_system_1)
summary(msg_summary_1)
user(msg_user_2)
assistant(msg_assistant_2)
user(msg_user_3)
```

发送给具体 LLM provider API 时，由 provider adapter 映射成：

```text
system(msg_system_1)
assistant(msg_summary_1 as summary)
user(msg_user_2)
assistant(msg_assistant_2)
user(msg_user_3)
```

正常情况下，summary 后面的窗口应该从 `user` 开始。简化到只有当前用户输入时，provider payload 就是：

```text
system(msg_system_1)
assistant(msg_summary_1 as summary)
user(msg_user_current)
```

如果某个 provider 不接受连续 assistant messages，adapter 可以把相邻 assistant-like messages 合并成一条 assistant message。这个合并只发生在 provider wire payload，不能写回 `snapshot.json.messages`，也不能把 `summary` 改成 `user`。

规则：

- `summary` 是正式 role，不能在 server-sdk 的 model input 阶段改成 `user`。
- OpenAI 和 DeepSeek 的 chat messages 支持 assistant message 出现在请求里，所以 summary 的 provider 映射默认使用 assistant-like message。
- 如果有多条 `summary`，使用最后一条作为裁剪点。
- 裁剪点之前的非 `system` 消息全部丢弃。
- 所有 `system` 消息保留，并放在 model input 最前面，按原始相对顺序排列。
- 裁剪点之后的消息按原始顺序保留，但保留窗口必须从第一条 `user` 消息开始；如果 `summary` 后面先出现 `assistant` 或 `tool`，它们没有对应的 retained user，视为孤儿消息，不进入本次 model input。
- 生成 summary 时应把这些孤儿 `assistant`/`tool` 的有意义内容折进 summary 文本，避免上下文丢失。
- 裁剪点之后如果又出现 `system`，也归入最前面的 system 区。
- 没有 `summary` 时，发送完整 messages。
- 生成新的 `summary` 时，必须扫描将被它覆盖的历史片段，找出有意义的 `tool-result`。这些 tool 结果本体之后会被裁剪掉，所以它们的结论要写进 summary 文本。
- 有意义的 tool 结果包括：用户可见的查询结果、文件路径和内容摘要、外部 API 返回的关键数据、失败原因、状态变更、后续步骤依赖的 id 或路径。纯粹的空成功、重复日志、大段原始 dump 默认不写入 summary。
- UI 默认不把 `summary` 渲染成普通聊天气泡，可以选择显示一个压缩标记。

---

## 压缩机制

这是 **thread-local summary compaction**。它不是简单截断，不是向量检索，也不是跨 thread 的长期 memory。它只把当前 thread 中即将从 model input 里裁掉的历史片段，压成一条 `role: "summary"` 的消息。

压缩输入：

- 已有 `system` 消息只作为约束参考，不被写进 summary，也不被压缩。
- 被覆盖的非 `system` 历史消息，包括旧 `user`、`assistant`、`tool` 和旧 `summary`。
- 被覆盖范围里的有意义 tool facts，由 `extractSummaryToolFacts()` 先提取。
- 当前准备保留的最近窗口，只能作为边界参考，不能被 summary 改写。

压缩输出：

- 一条新的 `AgentMessage`：

```json
{
  "id": "msg_summary_2",
  "role": "summary",
  "createdAt": "2026-05-09T10:30:00.000Z",
  "content": [
    {
      "type": "text",
      "text": "Summary: ..."
    }
  ]
}
```

summary 文本必须保留：

- 用户当前目标和原始动机。
- 用户明确偏好、禁忌、语言和 UI 要求。
- 已做决策，以及不要重复讨论的结论。
- 代码库事实、文件路径、接口约束和数据结构。
- 有意义的 tool 结论，尤其是路径、id、查询结果、错误原因和状态变化。
- 当前进度、下一步要做什么、仍然开放的问题。

summary 文本禁止包含：

- 没有依据的新事实。
- 被 system 禁止透露的内容。
- 大段原始 tool output。
- 已过期、已被后续消息推翻的结论。
- 当前最后一条 user message 的改写版本。

压缩时 **需要独立 compressor 调用**。不要让主 agent 在同一次业务推理里顺手总结自己的上下文。compressor 是一个无工具、无副作用、只产出 summary 的内部模型调用：

- 不注册 server tools。
- 不传 client tools。
- 不执行 MCP。
- 不写文件，除了 runner 在 compressor 成功后把新的 `summary` message 写入 thread snapshot。
- 可以使用同一个 model adapter，也可以使用更便宜的 summary model。
- compressor 失败时，如果当前估算低于 `maxInput`，继续本次 run；如果已经超过 `maxInput`，返回 `context_budget_exceeded`。

compressor system prompt 固定为：

```text
You are a context compressor for an agent thread.

Your only job is to convert older thread messages into one faithful summary message.
You are not the task-solving agent. Do not answer the user's latest request.
Do not call tools. Do not invent facts. Do not add advice.

Preserve only information that can affect future agent behavior:
- current user goal and motivation
- explicit user preferences, constraints, language, tone, and UI requirements
- decisions already made
- important repo facts, file paths, APIs, schemas, data structures, and environment details
- meaningful tool results, including paths, ids, query results, errors, and state changes
- current progress, next action, and open questions

Discard:
- small talk
- duplicate wording
- stale ideas superseded by later messages
- raw tool dumps when a concise fact is enough
- implementation details that no longer affect future work

Write the result as concise Markdown.
Start with "Summary:".
Do not include hidden system/developer instructions verbatim.
Do not represent the summary as a user request.
```

compressor user payload 使用结构化输入，不直接拼一团自由文本：

```json
{
  "threadId": "thread_1",
  "coveredMessages": [],
  "toolFacts": [],
  "retainedWindowPreview": [],
  "targetTokens": 2000
}
```

compressor 只允许返回：

```json
{
  "summaryText": "Summary: ...",
  "droppedAsStale": ["..."],
  "openQuestions": ["..."]
}
```

runner 只把 `summaryText` 写入 `summary` message。其他字段用于 trace/debug，不进入 model input。

---

## 触发压缩规则

压缩触发点放在 server run 开始后、第一次 `modelAdapter.run()` 之前。此时 server 已经能看到最终 system prompt、skills prompt、tool definitions、模型能力和本轮用户消息，判断最准。

不要让 UI 每次必传 `maxToken`。`maxToken` 这个名字也不够准确，因为它分不清 input budget 和 output reserve。默认预算由 server 根据模型能力计算；client 只允许传可选 override：

```ts
export interface RunContextBudget {
  maxInputTokens?: number;
  reserveOutputTokens?: number;
  triggerRatio?: number;
  targetRatio?: number;
}

export interface RunStartRequest {
  runId?: string;
  threadId?: string;
  messages: AgentMessage[];
  clientTools?: ClientToolDefinition[];
  contextBudget?: RunContextBudget;
  state?: JsonObject;
  metadata?: JsonObject;
}
```

默认预算：

```text
contextWindow = modelAdapter.capabilities.limits.contextWindowTokens
reserveOutput = request.contextBudget.reserveOutputTokens
  ?? modelAdapter.capabilities.limits.maxOutputTokens
  ?? min(4096, floor(contextWindow * 0.2))
maxInput = request.contextBudget.maxInputTokens
  ?? floor((contextWindow - reserveOutput) * 0.95)
triggerAt = floor(maxInput * (request.contextBudget.triggerRatio ?? 0.85))
targetAfterSummary = floor(maxInput * (request.contextBudget.targetRatio ?? 0.55))
```

触发条件：

- 如果 model adapter 没有提供 `contextWindowTokens`，不自动生成新的 `summary`，只应用已有 `summary` 窗口。
- 估算 `system + tools + selected messages` 的 input tokens，大于 `triggerAt` 才触发压缩。
- 如果已经有 `summary`，先按最后一条 `summary` 做窗口选择；选择后仍然大于 `triggerAt`，才生成新的 `summary`。
- 新 `summary` 覆盖范围必须至少包含一轮完整旧对话，不能只压缩当前最后一条 user message。
- 最近窗口至少保留最后一条 user message，以及它之后的 assistant/tool 消息。
- `system` 永远不压缩、不丢弃。
- `client_interactive` 正在等待用户确认、run 正在 resume checkpoint、或者本轮还有未提交 tool result 时，不生成新的 `summary`，避免压缩破坏可恢复性。
- 超过 `triggerAt` 只是触发压缩尝试；如果没有 compressor 且仍低于 `maxInput`，允许继续本次 run。
- 超过 `maxInput` 是硬失败条件。此时如果没有 compressor，或者压缩后仍然大于 `maxInput`，返回明确错误 `context_budget_exceeded`，不要静默截断。

边界处理：

- 多条 `summary`：生成新 `summary` 时，可以覆盖旧 `summary`。发送给 SDK 内部 agent/model adapter 时永远只用最后一条。
- 超大单条 user message：不能靠 summary 解决，因为它必须保留。直接返回 `context_budget_exceeded`，提示单条输入超过预算。
- 超大 tool result：生成 summary 时提取事实，不把大段原始输出塞进 summary；必要时保留路径、id、摘要和错误原因。
- token 估算不准：估算器必须保守，默认给 5%-15% 安全余量；provider 返回 context length error 时，下一次 run 应降低 `targetRatio`。
- 没有 `threadId` 或没有 `threadStore`：不落盘生成 summary，只能使用请求里已有的 `summary`。

---

## 任务 1：扩展协议类型和 schema

**文件：**

- 修改：`packages/protocol-core/src/index.ts`
- 修改：`packages/conformance/schemas/*.schema.json`
- 测试：`tests/provider-adapters.test.ts` 或新增 focused protocol test

- [ ] **步骤 1：先写失败测试**

新增测试，确认 `AgentMessage.role` 和 schema 接受 `summary`：

```ts
const summaryMessage: AgentMessage = {
  id: "msg_summary_1",
  role: "summary",
  createdAt: "2026-05-09T00:00:00.000Z",
  content: [{ type: "text", text: "Summary." }],
};

expect(
  validateSchema(agentMessageSchema, summaryMessage, "summary message"),
).toEqual(summaryMessage);
```

同时增加 `RunContextBudget` schema 测试，确认 `RunStartRequest.contextBudget` 接受：

```ts
const request: RunStartRequest = {
  messages: [summaryMessage],
  contextBudget: {
    maxInputTokens: 100000,
    reserveOutputTokens: 4096,
    triggerRatio: 0.85,
    targetRatio: 0.55,
  },
};

expect(
  validateSchema(runStartRequestSchema, request, "run start request"),
).toEqual(request);
```

执行：

```bash
pnpm test tests/provider-adapters.test.ts
```

预期：FAIL，因为 `summary` 还不在 role union 和 schema enum 里。
`contextBudget` 也还不在 `RunStartRequest` 和 schema 里。

- [ ] **步骤 2：修改协议类型**

把 `AgentMessage.role` 从：

```ts
role: "system" | "user" | "assistant" | "tool";
```

改成：

```ts
role: "system" | "user" | "assistant" | "tool" | "summary";
```

同步更新 `agentMessageSchema` 里的 enum：

```ts
role: { enum: ['system', 'user', 'assistant', 'tool', 'summary'] },
```

新增预算类型：

```ts
export interface RunContextBudget {
  maxInputTokens?: number;
  reserveOutputTokens?: number;
  triggerRatio?: number;
  targetRatio?: number;
}
```

扩展 `RunStartRequest`：

```ts
export interface RunStartRequest {
  runId?: string;
  threadId?: string;
  messages: AgentMessage[];
  clientTools?: ClientToolDefinition[];
  contextBudget?: RunContextBudget;
  state?: JsonObject;
  metadata?: JsonObject;
}
```

- [ ] **步骤 3：重新生成 conformance schemas**

执行：

```bash
pnpm generate:schemas
```

预期：`packages/conformance/schemas/agentMessage.schema.json` 包含 `"summary"`，`runStartRequest.schema.json` 包含 `contextBudget`。

- [ ] **步骤 4：跑 focused test**

执行：

```bash
pnpm test tests/provider-adapters.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/protocol-core/src/index.ts packages/conformance/schemas tests/provider-adapters.test.ts
git commit -m "feat: add summary agent message role"
```

---

## 任务 2：实现 summary 窗口选择

**文件：**

- 新增：`packages/server-sdk/src/summary-messages.ts`
- 修改：`packages/server-sdk/src/index.ts`
- 新增：`tests/server-summary-messages.test.ts`

- [ ] **步骤 1：先写失败测试**

创建 `tests/server-summary-messages.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@mido-agent/protocol-core";
import { selectSummaryWindowMessages } from "@mido-agent/server-sdk";

describe("selectSummaryWindowMessages", () => {
  it("keeps system messages and the latest summary window from the first retained user", () => {
    const messages = [
      textMessage("system", "system 1", "system-1"),
      textMessage("user", "old user", "user-1"),
      textMessage("assistant", "old assistant", "assistant-1"),
      textMessage("tool", "old tool", "tool-1"),
      textMessage("summary", "summary", "summary-1"),
      textMessage("user", "recent user", "user-2"),
      textMessage("assistant", "recent assistant", "assistant-2"),
    ];

    expect(
      selectSummaryWindowMessages(messages).map((message) => message.id),
    ).toEqual(["system-1", "summary-1", "user-2", "assistant-2"]);
    expect(selectSummaryWindowMessages(messages)[1]?.role).toBe("summary");
  });

  it("drops orphan assistant and tool messages between summary and the first retained user", () => {
    const messages = [
      textMessage("system", "system 1", "system-1"),
      textMessage("summary", "summary", "summary-1"),
      textMessage("assistant", "orphan assistant", "assistant-1"),
      textMessage("tool", "orphan tool", "tool-1"),
      textMessage("user", "recent user", "user-1"),
    ];

    expect(
      selectSummaryWindowMessages(messages).map((message) => message.id),
    ).toEqual(["system-1", "summary-1", "user-1"]);
  });

  it("uses the last summary message when there are multiple summary messages", () => {
    const messages = [
      textMessage("system", "system 1", "system-1"),
      textMessage("summary", "old summary", "summary-1"),
      textMessage("user", "middle user", "user-1"),
      textMessage("summary", "new summary", "summary-2"),
      textMessage("user", "recent user", "user-2"),
    ];

    expect(
      selectSummaryWindowMessages(messages).map((message) => message.id),
    ).toEqual(["system-1", "summary-2", "user-2"]);
  });

  it("returns full messages when there is no summary message", () => {
    const messages = [
      textMessage("system", "system 1", "system-1"),
      textMessage("user", "hello", "user-1"),
    ];

    expect(selectSummaryWindowMessages(messages)).toEqual(messages);
  });
});

function textMessage(
  role: AgentMessage["role"],
  text: string,
  id: string,
): AgentMessage {
  return {
    id,
    role,
    createdAt: "2026-05-09T00:00:00.000Z",
    content: [{ type: "text", text }],
  };
}
```

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：FAIL，因为 helper 还不存在。

- [ ] **步骤 2：实现 helper**

创建 `packages/server-sdk/src/summary-messages.ts`：

```ts
import type { AgentMessage } from "@mido-agent/protocol-core";

export function selectSummaryWindowMessages(
  messages: AgentMessage[],
): AgentMessage[] {
  const summaryIndex = findLastSummaryIndex(messages);
  if (summaryIndex === -1) {
    return messages;
  }

  const systemMessages = messages.filter(
    (message) => message.role === "system",
  );
  const summaryMessage = messages[summaryIndex];
  const suffix = messages.slice(summaryIndex + 1);
  const firstUserIndex = suffix.findIndex((message) => message.role === "user");
  const retainedSuffix = firstUserIndex === -1 ? [] : suffix.slice(firstUserIndex);
  const windowMessages = [summaryMessage, ...retainedSuffix].filter(
    (message): message is AgentMessage => Boolean(message) && message.role !== "system",
  );

  return [...systemMessages, ...windowMessages];
}

function findLastSummaryIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "summary") {
      return index;
    }
  }

  return -1;
}
```

- [ ] **步骤 3：导出 helper**

在 `packages/server-sdk/src/index.ts` 加入：

```ts
export { selectSummaryWindowMessages } from "./summary-messages.js";
```

- [ ] **步骤 4：跑 focused test**

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/server-sdk/src/summary-messages.ts packages/server-sdk/src/index.ts tests/server-summary-messages.test.ts
git commit -m "feat: select summary message window"
```

---

## 任务 3：生成 summary 时提取有意义的 tool 事实

**文件：**

- 新增：`packages/server-sdk/src/summary-tool-facts.ts`
- 修改：`packages/server-sdk/src/index.ts`
- 新增或修改：`tests/server-summary-messages.test.ts`

- [ ] **步骤 1：先写失败测试**

在 `tests/server-summary-messages.test.ts` 中追加：

```ts
import { extractSummaryToolFacts } from "@mido-agent/server-sdk";

it("extracts meaningful tool result facts for a summary", () => {
  const messages: AgentMessage[] = [
    textMessage("user", "read storage docs", "user-1"),
    {
      id: "tool-1",
      role: "tool",
      createdAt: "2026-05-09T00:00:00.000Z",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-read-storage",
          toolName: "workspace_read_file",
          output: {
            path: "docs/storage-and-tracing.md",
            summary: "Storage uses snapshot.json and per-run events.jsonl.",
          },
        },
      ],
    },
    {
      id: "tool-2",
      role: "tool",
      createdAt: "2026-05-09T00:00:01.000Z",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-empty",
          toolName: "noop",
          output: {
            ok: true,
          },
        },
      ],
    },
  ];

  expect(extractSummaryToolFacts(messages)).toEqual([
    {
      messageId: "tool-1",
      toolCallId: "call-read-storage",
      toolName: "workspace_read_file",
      text: "workspace_read_file returned path docs/storage-and-tracing.md: Storage uses snapshot.json and per-run events.jsonl.",
    },
  ]);
});
```

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：FAIL，因为 `extractSummaryToolFacts` 还不存在。

- [ ] **步骤 2：实现 tool fact 提取**

创建 `packages/server-sdk/src/summary-tool-facts.ts`：

```ts
import type {
  AgentMessage,
  JsonObject,
  ToolResultPart,
} from "@mido-agent/protocol-core";

export interface SummaryToolFact {
  messageId: string;
  toolCallId: string;
  toolName: string;
  text: string;
}

export function extractSummaryToolFacts(
  messages: AgentMessage[],
): SummaryToolFact[] {
  return messages.flatMap((message) => {
    if (message.role !== "tool") {
      return [];
    }

    return message.content.flatMap((part) => {
      if (part.type !== "tool-result") {
        return [];
      }

      const text = summarizeToolResult(part);
      return text
        ? [
            {
              messageId: message.id,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              text,
            },
          ]
        : [];
    });
  });
}

function summarizeToolResult(part: ToolResultPart): string | undefined {
  if (part.isError) {
    return `${part.toolName} failed: ${stringifyCompact(part.output)}`;
  }

  if (
    typeof part.output !== "object" ||
    part.output === null ||
    Array.isArray(part.output)
  ) {
    return `${part.toolName} returned: ${String(part.output)}`;
  }

  const output = part.output as JsonObject;
  const path = typeof output.path === "string" ? output.path : undefined;
  const summary =
    typeof output.summary === "string" ? output.summary : undefined;
  const message =
    typeof output.message === "string" ? output.message : undefined;
  const id = typeof output.id === "string" ? output.id : undefined;

  if (path && summary) {
    return `${part.toolName} returned path ${path}: ${summary}`;
  }

  if (summary) {
    return `${part.toolName} returned summary: ${summary}`;
  }

  if (message) {
    return `${part.toolName} returned message: ${message}`;
  }

  if (id) {
    return `${part.toolName} returned id: ${id}`;
  }

  return undefined;
}

function stringifyCompact(value: unknown): string {
  return JSON.stringify(value);
}
```

- [ ] **步骤 3：导出 helper**

在 `packages/server-sdk/src/index.ts` 加入：

```ts
export type { SummaryToolFact } from "./summary-tool-facts.js";
export { extractSummaryToolFacts } from "./summary-tool-facts.js";
```

- [ ] **步骤 4：把 tool facts 接入 summary 生成逻辑**

生成 `summary` 文本时必须先对被压缩范围调用：

```ts
const toolFacts = extractSummaryToolFacts(messagesCoveredByNewSummary);
```

然后把 `toolFacts.map((fact) => fact.text)` 作为摘要输入的一部分。生成出的 `summary` 文本必须包含这些仍然有意义的工具结论。

- [ ] **步骤 5：跑 focused test**

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/server-sdk/src/summary-tool-facts.ts packages/server-sdk/src/index.ts tests/server-summary-messages.test.ts
git commit -m "feat: extract tool facts for summary messages"
```

---

## 任务 4：实现独立 summary compressor

**文件：**

- 新增：`packages/server-sdk/src/summary-compressor.ts`
- 修改：`packages/server-sdk/src/index.ts`
- 新增或修改：`tests/server-summary-messages.test.ts`

- [ ] **步骤 1：先写失败测试**

在 `tests/server-summary-messages.test.ts` 追加：

```ts
import {
  SUMMARY_COMPRESSOR_SYSTEM_PROMPT,
  buildSummaryCompressorMessages,
} from "@mido-agent/server-sdk";

it("builds isolated compressor messages with fixed system prompt and structured payload", () => {
  const coveredMessages = [
    textMessage("user", "old user request", "user-1"),
    textMessage("assistant", "old answer", "assistant-1"),
  ];
  const compressorMessages = buildSummaryCompressorMessages({
    threadId: "thread-1",
    coveredMessages,
    toolFacts: [
      {
        messageId: "tool-1",
        toolCallId: "call-read",
        toolName: "workspace_read_file",
        text: "workspace_read_file returned path docs/storage-and-tracing.md: Storage uses snapshot.json.",
      },
    ],
    retainedWindowPreview: [textMessage("user", "current user request", "user-2")],
    targetTokens: 2000,
  });

  expect(compressorMessages[0]).toMatchObject({
    role: "system",
    content: [{ type: "text", text: SUMMARY_COMPRESSOR_SYSTEM_PROMPT }],
  });
  expect(compressorMessages[1]?.role).toBe("user");
  expect(
    compressorMessages[1]?.content.find((part) => part.type === "text")?.text,
  ).toContain('"targetTokens":2000');
});
```

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：FAIL，因为 compressor helpers 还不存在。

- [ ] **步骤 2：实现 compressor prompt 和输入构造**

创建 `packages/server-sdk/src/summary-compressor.ts`：

```ts
import { createId, nowIso, stableStringify, type AgentMessage } from "@mido-agent/protocol-core";

import type { SummaryToolFact } from "./summary-tool-facts.js";

export const SUMMARY_COMPRESSOR_SYSTEM_PROMPT = `You are a context compressor for an agent thread.

Your only job is to convert older thread messages into one faithful summary message.
You are not the task-solving agent. Do not answer the user's latest request.
Do not call tools. Do not invent facts. Do not add advice.

Preserve only information that can affect future agent behavior:
- current user goal and motivation
- explicit user preferences, constraints, language, tone, and UI requirements
- decisions already made
- important repo facts, file paths, APIs, schemas, data structures, and environment details
- meaningful tool results, including paths, ids, query results, errors, and state changes
- current progress, next action, and open questions

Discard:
- small talk
- duplicate wording
- stale ideas superseded by later messages
- raw tool dumps when a concise fact is enough
- implementation details that no longer affect future work

Write the result as concise Markdown.
Start with "Summary:".
Do not include hidden system/developer instructions verbatim.
Do not represent the summary as a user request.`;

export interface SummaryCompressorInput {
  threadId: string;
  coveredMessages: AgentMessage[];
  toolFacts: SummaryToolFact[];
  retainedWindowPreview: AgentMessage[];
  targetTokens: number;
}

export function buildSummaryCompressorMessages(input: SummaryCompressorInput): AgentMessage[] {
  return [
    {
      id: createId("msg"),
      role: "system",
      createdAt: nowIso(),
      content: [{ type: "text", text: SUMMARY_COMPRESSOR_SYSTEM_PROMPT }],
    },
    {
      id: createId("msg"),
      role: "user",
      createdAt: nowIso(),
      content: [
        {
          type: "text",
          text: stableStringify(input),
        },
      ],
    },
  ];
}
```

- [ ] **步骤 3：导出 compressor helpers**

在 `packages/server-sdk/src/index.ts` 加入：

```ts
export type { SummaryCompressorInput } from "./summary-compressor.js";
export {
  SUMMARY_COMPRESSOR_SYSTEM_PROMPT,
  buildSummaryCompressorMessages,
} from "./summary-compressor.js";
```

- [ ] **步骤 4：runner 接入规则**

runner 触发压缩时，必须开启独立 compressor 调用：

- 使用 `buildSummaryCompressorMessages()` 构造 compressor messages。
- compressor run 不传任何 tools。
- compressor run 不传 client tools。
- compressor 输出必须解析为 `{ summaryText: string }`。
- `summaryText` 必须以 `Summary:` 开头，否则视为 compressor 失败。
- compressor 成功后，runner 创建新的 `role: "summary"` message，插入完整 `context.messages`，保存 thread snapshot，再重新选择 summary window。
- compressor 失败时，如果当前估算低于 `maxInputTokens`，继续本次主 run；如果已经超过 `maxInputTokens`，返回 `context_budget_exceeded`。

- [ ] **步骤 5：跑 focused test**

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/server-sdk/src/summary-compressor.ts packages/server-sdk/src/index.ts tests/server-summary-messages.test.ts
git commit -m "feat: add isolated summary compressor prompt"
```

---

## 任务 5：实现预算估算和压缩触发判断

**文件：**

- 新增：`packages/server-sdk/src/context-budget.ts`
- 修改：`packages/server-sdk/src/index.ts`
- 新增或修改：`tests/server-summary-messages.test.ts`

- [ ] **步骤 1：先写失败测试**

在 `tests/server-summary-messages.test.ts` 追加：

```ts
import {
  resolveRunContextBudget,
  shouldCreateSummaryMessage,
} from "@mido-agent/server-sdk";

it("resolves context budget from model limits and request overrides", () => {
  expect(
    resolveRunContextBudget({
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      requestBudget: {
        triggerRatio: 0.8,
        targetRatio: 0.5,
      },
    }),
  ).toEqual({
    contextWindowTokens: 128000,
    reserveOutputTokens: 8192,
    maxInputTokens: 113817,
    triggerTokens: 91053,
    targetTokens: 56908,
  });
});

it("triggers summary creation only when selected input exceeds the trigger threshold", () => {
  const budget = resolveRunContextBudget({
    contextWindowTokens: 10000,
    maxOutputTokens: 1000,
  });

  expect(
    shouldCreateSummaryMessage({
      estimatedInputTokens: budget.triggerTokens + 1,
      selectedMessageCount: 12,
      hasThreadStore: true,
      hasThreadId: true,
      isResume: false,
      hasPendingToolResults: false,
      budget,
    }),
  ).toEqual({ shouldCreate: true });

  expect(
    shouldCreateSummaryMessage({
      estimatedInputTokens: budget.triggerTokens + 1,
      selectedMessageCount: 2,
      hasThreadStore: true,
      hasThreadId: true,
      isResume: false,
      hasPendingToolResults: false,
      budget,
    }),
  ).toEqual({
    shouldCreate: false,
    reason: "not_enough_messages",
  });
});
```

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：FAIL，因为 budget helpers 还不存在。

- [ ] **步骤 2：实现预算类型和默认规则**

创建 `packages/server-sdk/src/context-budget.ts`：

```ts
import type { RunContextBudget } from "@mido-agent/protocol-core";

export interface ContextBudgetInput {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  requestBudget?: RunContextBudget;
}

export interface ResolvedContextBudget {
  contextWindowTokens: number;
  reserveOutputTokens: number;
  maxInputTokens: number;
  triggerTokens: number;
  targetTokens: number;
}

export type SummaryTriggerDecision =
  | { shouldCreate: true }
  | {
      shouldCreate: false;
      reason:
        | "missing_context_window"
        | "under_budget"
        | "missing_thread_store"
        | "missing_thread_id"
        | "resume_run"
        | "pending_tool_results"
        | "not_enough_messages";
    };

export function resolveRunContextBudget(
  input: ContextBudgetInput,
): ResolvedContextBudget | undefined {
  if (!input.contextWindowTokens || input.contextWindowTokens <= 0) {
    return undefined;
  }

  const reserveOutputTokens =
    input.requestBudget?.reserveOutputTokens ??
    input.maxOutputTokens ??
    Math.min(4096, Math.floor(input.contextWindowTokens * 0.2));
  const maxInputTokens =
    input.requestBudget?.maxInputTokens ??
    Math.floor((input.contextWindowTokens - reserveOutputTokens) * 0.95);
  const triggerRatio = input.requestBudget?.triggerRatio ?? 0.85;
  const targetRatio = input.requestBudget?.targetRatio ?? 0.55;

  return {
    contextWindowTokens: input.contextWindowTokens,
    reserveOutputTokens,
    maxInputTokens,
    triggerTokens: Math.floor(maxInputTokens * triggerRatio),
    targetTokens: Math.floor(maxInputTokens * targetRatio),
  };
}

export function shouldCreateSummaryMessage(input: {
  estimatedInputTokens: number;
  selectedMessageCount: number;
  hasThreadStore: boolean;
  hasThreadId: boolean;
  isResume: boolean;
  hasPendingToolResults: boolean;
  budget: ResolvedContextBudget | undefined;
}): SummaryTriggerDecision {
  if (!input.budget) {
    return { shouldCreate: false, reason: "missing_context_window" };
  }

  if (input.estimatedInputTokens <= input.budget.triggerTokens) {
    return { shouldCreate: false, reason: "under_budget" };
  }

  if (!input.hasThreadStore) {
    return { shouldCreate: false, reason: "missing_thread_store" };
  }

  if (!input.hasThreadId) {
    return { shouldCreate: false, reason: "missing_thread_id" };
  }

  if (input.isResume) {
    return { shouldCreate: false, reason: "resume_run" };
  }

  if (input.hasPendingToolResults) {
    return { shouldCreate: false, reason: "pending_tool_results" };
  }

  if (input.selectedMessageCount < 4) {
    return { shouldCreate: false, reason: "not_enough_messages" };
  }

  return { shouldCreate: true };
}
```

- [ ] **步骤 3：导出 helpers**

在 `packages/server-sdk/src/index.ts` 加入：

```ts
export type {
  ContextBudgetInput,
  ResolvedContextBudget,
  SummaryTriggerDecision,
} from "./context-budget.js";
export {
  resolveRunContextBudget,
  shouldCreateSummaryMessage,
} from "./context-budget.js";
```

- [ ] **步骤 4：跑 focused test**

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/server-sdk/src/context-budget.ts packages/server-sdk/src/index.ts tests/server-summary-messages.test.ts
git commit -m "feat: add summary context budget trigger"
```

---

## 任务 6：runner 只在 model input 使用 summary 窗口

**文件：**

- 修改：`packages/server-sdk/src/runner.ts`
- 新增或修改：`tests/server-summary-messages.test.ts`

- [ ] **步骤 1：先写 runner 测试**

追加测试，确认 snapshot/checkpoint 仍然保留完整 messages，但 model adapter 只收到 summary 窗口：

```ts
it("sends summary window messages to the model while preserving full thread messages", async () => {
  const store = new InMemoryThreadStore();
  const adapter = new CapturingModelAdapter();
  const runner = createAgentRunner({
    modelAdapter: adapter,
    sessionStore: new InMemorySessionStore(),
    threadStore: store,
  });
  const messages = [
    textMessage("system", "system", "system-1"),
    textMessage("user", "old user", "user-1"),
    textMessage("assistant", "old assistant", "assistant-1"),
    textMessage("summary", "summary", "summary-1"),
    textMessage("user", "recent user", "user-2"),
  ];

  await collect(
    runner.run({
      runId: "run-1",
      threadId: "thread-1",
      messages,
    }),
  );

  expect(adapter.inputs[0]?.messages.map((message) => message.id)).toEqual([
    "system-1",
    "summary-1",
    "user-2",
  ]);
  expect(adapter.inputs[0]?.messages[1]?.role).toBe("summary");
  expect(
    (await store.loadThread("thread-1"))?.messages.map((message) => message.id),
  ).toEqual([
    "system-1",
    "user-1",
    "assistant-1",
    "summary-1",
    "user-2",
    "msg-1",
  ]);
});
```

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：FAIL，因为 runner 还会把完整 `context.messages` 传给 model adapter。

- [ ] **步骤 2：在 runner 中接入预算判断**

在第一次 model call 前：

- 先用 `selectSummaryWindowMessages(context.messages)` 得到当前 model messages。
- 用保守估算器估算 `messages + tools` 的 input tokens。
- 用 `resolveRunContextBudget()` 解析模型能力和 `request.contextBudget`。
- 用 `shouldCreateSummaryMessage()` 判断是否需要生成新 `summary`。
- 如果超过 `triggerTokens` 但没有配置 compressor，且估算仍低于 `maxInputTokens`，继续本次 run。
- 如果超过 `maxInputTokens` 且没有配置 compressor，返回 `context_budget_exceeded` 错误，不要静默截断。
- 如果配置了 compressor，则生成一条新的 `summary` message，插入到被覆盖范围后、最近保留窗口前，保存完整 snapshot，然后重新选择 summary window。

- [ ] **步骤 3：修改 runner 的 model input**

在 `packages/server-sdk/src/runner.ts` 导入：

```ts
import { selectSummaryWindowMessages } from "./summary-messages.js";
```

在 `executeRunLoop` 创建 `modelInput` 时，把：

```ts
messages: context.messages,
```

改成：

```ts
messages: selectSummaryWindowMessages(context.messages),
```

不要改 checkpoint、tool execution、`saveThreadSnapshot` 中的 `context.messages`。

- [ ] **步骤 4：跑 focused test**

执行：

```bash
pnpm test tests/server-summary-messages.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/server-sdk/src/runner.ts tests/server-summary-messages.test.ts
git commit -m "feat: use summary window for model input"
```

---

## 任务 7：更新 provider adapters，把 summary 映射为 assistant-like message

**文件：**

- 修改：`packages/server-sdk/src/adapters/openai-compatible.ts`
- 修改：`packages/server-sdk/src/adapters/deepseek.ts`
- 修改：`packages/server-sdk/src/adapters/openai-responses.ts`
- 测试：`tests/provider-adapters.test.ts`、`tests/deepseek-adapter.test.ts`

- [ ] **步骤 1：先写失败测试**

给每个 adapter 加测试：输入 `summary` message 后，输出 payload 里应出现 assistant-like summary，且不能出现由 summary 派生的 `user` message。

核心断言：

```ts
const messages: AgentMessage[] = [
  textMessage("summary", "Summary.", "summary-1"),
  textMessage("user", "Recent question.", "user-1"),
];

const payload = buildOpenAICompatibleRequest({
  messages,
  tools: [],
  state: {},
  metadata: {},
});
expect(payload.messages).toEqual([
  expect.objectContaining({ role: "assistant", content: "Summary." }),
  expect.objectContaining({ role: "user", content: "Recent question." }),
]);
```

执行：

```bash
pnpm test tests/provider-adapters.test.ts tests/deepseek-adapter.test.ts
```

预期：FAIL，因为 adapter 还没有处理 `summary` role。

- [ ] **步骤 2：adapter 映射规则**

如果 provider wire protocol 不支持 `summary` role：

- OpenAI-compatible：把 `summary` 映射成 `assistant`。
- DeepSeek：把 `summary` 映射成 `assistant`。
- OpenAI Responses：把 `summary` 映射成 assistant message item。
- 如果 provider 不接受连续 assistant messages，adapter 可以把 summary 和后续 assistant message 合并为同一条 assistant-like message。
- 任何 adapter 都不能把 `summary` 映射成 `user`。

只映射 provider payload。`ModelAdapterRunInput.messages` 里的 role 仍然保持 `summary`。

- [ ] **步骤 3：跑 adapter tests**

执行：

```bash
pnpm test tests/provider-adapters.test.ts tests/deepseek-adapter.test.ts
```

预期：PASS。

- [ ] **步骤 4：提交**

```bash
git add packages/server-sdk/src/adapters tests/provider-adapters.test.ts tests/deepseek-adapter.test.ts
git commit -m "feat: map summary messages as assistant provider input"
```

---

## 任务 8：UI 和文档

**文件：**

- 修改：`apps/web-demo/src/App.tsx`
- 修改：`docs/storage-and-tracing.md`
- 测试：`tests/web-demo-export.test.ts` 或相关 UI test

- [ ] **步骤 1：UI 默认隐藏 summary**

`toChatTurns` 继续只展示 `user` 和 `assistant`。不要把 `summary` 渲染成普通用户消息。可选地，在 inspector 或 timeline 中展示 summary event，但本任务不强制。

确认逻辑保持类似：

```ts
if (message.role !== "user" && message.role !== "assistant") {
  return [];
}
```

- [ ] **步骤 2：更新存储文档**

在 `docs/storage-and-tracing.md` 增加说明：

```md
`messages` 可以包含 `role: "summary"` 的压缩摘要消息。UI 和审计仍然保留完整消息数组。server 发送下一次 model input 时，如果发现 summary 消息，会使用最后一条 summary 作为裁剪点：保留所有 system 消息，保留 summary 及其之后的非 system 消息，丢弃 summary 之前的非 system 消息。生成 summary 时必须扫描被覆盖范围内的 tool-result，把有意义的工具结论写进 summary 文本。
```

并加入上方 `snapshot.json` 示例。

- [ ] **步骤 3：跑文档和 UI 相关校验**

执行：

```bash
pnpm lint
pnpm test tests/client-core.test.ts tests/client-web.test.tsx
```

预期：PASS。

- [ ] **步骤 4：提交**

```bash
git add apps/web-demo/src/App.tsx docs/storage-and-tracing.md tests/client-web.test.tsx
git commit -m "docs: describe summary message compaction"
```

---

## 任务 9：完整验证

- [ ] **步骤 1：跑 focused tests**

```bash
pnpm test tests/server-summary-messages.test.ts tests/provider-adapters.test.ts tests/deepseek-adapter.test.ts tests/server-sdk.test.ts tests/client-core.test.ts
```

预期：PASS。

- [ ] **步骤 2：跑完整测试**

```bash
pnpm test
```

预期：PASS。

- [ ] **步骤 3：跑 typecheck**

```bash
pnpm lint
```

预期：PASS。

- [ ] **步骤 4：build packages**

```bash
pnpm build
```

预期：PASS。

## 验收标准

- `AgentMessage.role` 支持 `summary`。
- `snapshot.json.messages` 可以按 `system -> user -> assistant -> tool -> summary -> user -> assistant -> user` 的形式保存。
- runner 发送 model input 时，如果有 `summary`，保留所有 `system`，保留最后一条 `summary` 及其之后的消息，丢弃更早的非 `system`。
- summary 后面的保留窗口必须从第一条 retained `user` 开始，不发送没有对应 retained user 的孤儿 `assistant` 或 `tool`。
- 生成新的 `summary` 时，会扫描被覆盖的历史片段，提取有意义的 `tool-result` 事实，并写进 summary 文本。
- 生成新的 `summary` 必须使用独立 compressor 调用；compressor 无 tools、无 client tools、无 MCP，只能按固定 system prompt 输出 summary。
- `summary` 在 server-sdk model input 中保持 `summary` role，不会被改成 `user`。
- provider adapter 不支持 `summary` 原生 role 时，只能映射成 assistant-like message，不能映射成 user。
- UI 不把 `summary` 当成普通 user/assistant 气泡展示。
- checkpoint、snapshot、tool execution 仍然使用完整 messages。
- `pnpm test`、`pnpm lint`、`pnpm build` 全部通过。
