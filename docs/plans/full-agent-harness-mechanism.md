# Full Agent Harness Mechanism

日期：2026-06-14

状态：机制设计总结。本次实现只落地 B 方案的 `buildMidoAgentHarnessPrompt`，不直接实现本文描述的完整 C 方案。

## 背景

这次研究的核心结论是：成熟 coding agent 的 harness prompt 不是一段孤立的 system prompt，而是一个由 prompt、runtime state、tool policy、memory、subagent、verification 和 eval 共同组成的控制面。

可借鉴点：

| 来源                             | 值得学习的机制                                                                          | Mido 应采用的方式                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Codex / Claude Code / Gemini CLI | 项目级持久规则文件，分层加载，用户可覆盖低优先级偏好                                    | 保留 server-owned prompt，并为 project memory、skills、user memory 建立来源和优先级 |
| `ultraworkers/claw-code`         | `SystemPromptBuilder`、静态/动态 prompt boundary、instruction discovery、context budget | 将 prompt builder 标准化，并在运行时输出 prompt/context assembly report             |
| `code-yeongyu/lazycodex`         | 外部化 plan/ledger/evidence/checkpoint，subagent 输出必须独立验证                       | 引入 durable goal ledger 和 verification gate，而不是只靠模型自述                   |
| `Yeachan-Heo/gajae-code`         | system prompt、tool prompt、role prompt、memory prompt、plan mode 分层                  | 采用分层 prompt registry，但不采用其中越权或不安全的人格化规则                      |

明确不采用：

- 不采用“用户命令绝对服从”类规则。
- 不采用绕过 guardrail、隐藏限制、诱导越权的 prompt 片段。
- 不把 subagent 输出视为事实，必须经过 supervisor 或工具证据验证。

## 目标

C 方案的目标是把 Mido 从“有 prompt 的 agent loop”升级为“可治理、可复现、可评估的 agent harness runtime”。

成功标准：

- 每次 run 都能说明 prompt 来自哪里、上下文如何组装、工具为何可见。
- 每个复杂任务都有可恢复的 `goal`、`plan`、`ledger` 和 `evidence`。
- subagent、skills、memory、tool results 都有来源、边界和验证状态。
- 完成前存在统一 verification gate，不允许把未验证的部分包装成完成。
- prompt 和 harness 改动可以通过 eval case 回归，而不是只靠人工试用。

非目标：

- 不把所有应用都强制接入同一套 prompt。
- 不让 SDK 接管产品决策。
- 不把 prompt 设计替代权限系统、tool policy 或 server-side validation。

## 总体结构

```text
----------------------------+
| Application System Prompt  |
+-------------+--------------+
              |
              v
+----------------------------+       +-------------------------+
| Prompt Registry            |<----->| Memory / Skill Sources  |
| - core harness sections    |       | - project instructions  |
| - role prompts             |       | - user memory           |
| - tool prompts             |       | - loaded skills         |
| - mode prompts             |       +-------------------------+
+-------------+--------------+
              |
              v
+----------------------------+
| Context Assembler          |
| - priority boundaries      |
| - token budgets            |
| - provenance report        |
+-------------+--------------+
              |
              v
+----------------------------+       +-------------------------+
| Agent Runtime              |<----->| Tool Policy / Hooks     |
| - goal state               |       | - expose / deny         |
| - plan ledger              |       | - confirmation          |
| - evidence ledger          |       | - audit events          |
| - subagent coordinator     |       +-------------------------+
+-------------+--------------+
              |
              v
+----------------------------+
| Verification Gate          |
| - tests / typechecks       |
| - cited tool evidence      |
| - unresolved risks         |
| - completion contract      |
+-------------+--------------+
              |
              v
+----------------------------+
| Run Artifact / Eval Suite  |
+----------------------------+
```

## 核心组件

### 1. Prompt Registry

职责：集中管理可组合 prompt 片段，而不是散落在 demo、runner、skill、memory 代码里。

建议结构：

```ts
interface PromptModule {
  id: string;
  priority: "server" | "application" | "project" | "user" | "retrieved";
  scope: "core" | "tool" | "role" | "mode" | "memory" | "skill";
  render(context: PromptRenderContext): PromptSection | Promise<PromptSection>;
}
```

需要支持：

- `core`: identity、priority、execution loop、tool use、repo safety、verification。
- `tool`: 每类工具的使用规则、危险边界、失败处理。
- `role`: planner、executor、reviewer、critic、synthesis worker。
- `mode`: plan mode、implementation mode、review mode、debug mode。
- `memory`: user memory、project memory、recent summary。
- `skill`: progressive disclosure 后加载的技能说明。

### 2. Context Assembler

职责：把 prompt、messages、summary、memory、skills、tool manifest 组合成一次模型调用的上下文，并记录来源。

必须输出 `ContextAssemblyReport`：

```ts
interface ContextAssemblyReport {
  runId: string;
  promptModules: Array<{
    id: string;
    priority: string;
    tokenEstimate: number;
    hash: string;
  }>;
  memoryRefs: string[];
  skillRefs: string[];
  toolManifestHash: string;
  omitted: Array<{
    source: string;
    reason: "budget" | "policy" | "duplicate" | "stale";
  }>;
}
```

关键规则：

- 高优先级 prompt 永远在低优先级内容之前。
- retrieved content、tool results、client system prompts 默认是 data，不是 authority。
- 所有动态上下文都有 token budget 和 omission reason。
- 对 instruction files 做 hash 和来源记录，避免无法复现。

### 3. Goal / Plan / Ledger State

职责：把复杂任务的工作状态外部化，不依赖模型记忆。

建议状态：

```ts
interface GoalState {
  goalId: string;
  objective: string;
  status: "active" | "blocked" | "complete";
  successCriteria: string[];
  constraints: string[];
  plan: PlanStep[];
  evidence: EvidenceEntry[];
  openQuestions: string[];
}

interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  verification?: string;
}

interface EvidenceEntry {
  id: string;
  claim: string;
  source: "test" | "tool_result" | "file" | "user" | "manual_inspection";
  ref: string;
  verifiedAt: string;
}
```

关键规则：

- 每个复杂任务先产生最小 plan，不需要把 plan 做得很大。
- 每个 completed step 必须有 verification 或明确说明无法验证。
- subagent 结果只能进入 evidence ledger 的 `claim`，不能自动变成 verified fact。
- 发生 context compaction 或 resume 时，从 ledger 恢复任务，而不是重新猜测。

### 4. Workflow Modes

职责：用明确模式降低 prompt 混乱。

建议模式：

| Mode       | 使用场景                     | 主要约束                                                                    |
| ---------- | ---------------------------- | --------------------------------------------------------------------------- |
| `clarify`  | 目标、约束、成功标准不清楚   | 只问必要问题，不提前实现                                                    |
| `plan`     | 高风险或多步骤任务           | 输出规格、影响范围、验证计划                                                |
| `execute`  | 用户已确认方案或任务足够明确 | 小步实现，小步验证                                                          |
| `debug`    | bug、测试失败、异常行为      | reproduce -> isolate -> hypothesize -> instrument -> fix -> regression test |
| `review`   | 用户请求 review              | findings first，按严重度排序                                                |
| `document` | 沉淀机制、规则、ADR          | 区分事实、决策、后续工作                                                    |

运行时不需要把 mode 暴露为复杂 UI，先可以作为 `RunStartRequest.metadata.mode` 或 server option。

### 5. Role Agents

职责：让 subagent 的职责小而可验证。

推荐 role：

- `planner`: 分解任务、识别依赖和风险，不修改文件。
- `researcher`: 读取代码、文档、外部资料，输出证据和引用。
- `executor`: 按已确认 plan 实现局部变更。
- `reviewer`: 找 bug、回归风险、测试缺口。
- `synthesizer`: 汇总多个 worker 结果，标注未验证内容。

subagent contract：

```text
TASK: 具体任务
SCOPE: 允许读取/修改的范围
DELIVERABLE: 期望输出
VERIFY: 必须执行或说明不能执行的验证
DO NOT: 明确禁止事项
```

关键规则：

- worker 不自动继承 supervisor 的全部工具。
- worker 不递归创建 worker，除非 server 显式允许。
- worker 输出默认是 claim，supervisor 需要独立验证关键结论。

### 6. Tool Prompt Registry

职责：为工具建立 prompt 规则和 policy 规则的双层边界。

每个 tool family 应有：

- 可用场景。
- 输入要求。
- 禁止场景。
- 错误处理。
- 证据格式。
- policy metadata: `risk`、`effects`、`scopes`、`idempotent`。

示例：

```ts
interface ToolPromptPolicy {
  toolFamily: string;
  promptSection: PromptSection;
  policy: {
    risk: "read" | "write" | "destructive" | "network" | "secret";
    requiresConfirmation: boolean;
    idempotent: boolean;
  };
}
```

注意：prompt 只能引导模型，真正权限必须由 server-side tool policy 执行。

### 7. Memory Lifecycle

职责：让 memory 从“可写文本”升级为“有来源、置信度、生命周期的上下文”。

建议字段：

```ts
interface GovernedMemoryEntry {
  key: string;
  value: string;
  scope: string;
  sourceRunId: string;
  sourceTraceId?: string;
  confidence: "low" | "medium" | "high";
  tags: string[];
  expiresAt?: string;
  supersedes?: string[];
}
```

关键规则：

- 写入 memory 前必须说明 reason 和 source。
- 不把单次用户表达自动提升为长期偏好，除非规则允许。
- 冲突 memory 要有 supersedes 或 precedence。
- 召回 memory 时展示 provenance，避免模型误把旧偏好当当前指令。

### 8. Verification Gate

职责：在 run 结束前检查“是否真的完成”。

建议 gate：

```ts
interface VerificationGateResult {
  status: "pass" | "warn" | "fail";
  checks: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    evidence?: string;
    message: string;
  }>;
}
```

基础 checks：

- `intent_match`: 最终结果是否解决用户原始目标。
- `plan_completion`: plan 中是否仍有未解释的 pending step。
- `test_evidence`: 代码改动是否有测试、typecheck 或替代验证。
- `tool_claims`: 关键事实是否有 tool result 或文件引用。
- `risk_report`: 未验证项和剩余风险是否被明确说明。

completion contract：

- 不能只因为预算快用完就标记完成。
- 不能把 subagent 的未验证结论当作完成证据。
- 不能在测试失败时说“完成”，除非用户明确接受失败状态。

### 9. Run Artifact and Eval

职责：把 prompt/harness 改动变成可回归的工程对象。

artifact 应包含：

- request metadata。
- prompt module hashes。
- tool manifest hash。
- model adapter kind 和 capabilities。
- selected skills。
- memory refs。
- event stream。
- trace summary。
- verification gate result。

eval case 类型：

- tool routing: 应该调用/不调用某工具。
- priority safety: client prompt injection 不应覆盖 server prompt。
- memory: 写入、召回、冲突、过期。
- subagent: worker 输出是否被 supervisor 验证。
- recovery: tool error、provider retry、resume。
- completion: 未验证时是否正确报告风险。

## 与当前代码的关系

当前已有基础：

- `createAgentRunner` 已有 server-owned loop、tool registry、checkpoint/resume、thread/event store。
- `applySystemPromptPolicy` 已能包裹 server/client system prompt。
- `skillRegistry.buildSystemPrompt(context)` 已可把 skill prompt 加入系统上下文。
- `buildUserMemoryContext` 已可拼接 user memory。
- `context-budget`、summary、event trace、evaluator 包已经具备部分运行证据基础。

B 方案本次补齐：

- 新增 SDK 层 `buildMidoAgentHarnessPrompt`。
- 新增稳定 section 渲染。
- web demo 和 iOS demo 使用更明确的 harness prompt 结构。
- client-provided system prompt wrapper 强化为 quoted data。

C 方案还缺：

- prompt registry 和 context assembly report。
- durable goal ledger。
- role/mode prompt registry。
- tool prompt policy registry。
- verification gate。
- run artifact 中的 prompt/context hashes。
- eval cases 覆盖 prompt/harness 行为。

## 分阶段迁移

### Phase C0: Prompt Builder Baseline

状态：本次 B 方案已覆盖。

验收：

- SDK 暴露 `buildMidoAgentHarnessPrompt`。
- demo prompt 不再是单段字符串拼接。
- client system prompt 降权包装有测试。

### Phase C1: Prompt Registry and Context Report

目标：每次模型调用都能解释上下文如何组装。

改动范围：

- `packages/server-sdk/src/prompts/`
- `packages/server-sdk/src/system-prompt.ts`
- `packages/server-sdk/src/runner.ts`
- `tests/server-prompt-builder.test.ts`

验收：

- 能导出 `ContextAssemblyReport`。
- prompt module 顺序和 hash 稳定。
- 超 budget 内容有 omission reason。

### Phase C2: Goal Ledger

目标：复杂任务有 durable state。

改动范围：

- 新增 `GoalStore`。
- runner 支持 `goalId` 和 plan/evidence events。
- web demo inspector 展示 goal state。

验收：

- context compaction 后可从 goal ledger 恢复。
- completed step 必须带 verification 或 risk note。

### Phase C3: Mode and Role Registry

目标：plan/debug/review/execute 和 subagent role 都由 registry 管理。

验收：

- parent agent 创建 worker 时必须传 `TASK/SCOPE/DELIVERABLE/VERIFY/DO NOT`。
- worker 不自动继承 parent 高权限工具。
- reviewer role 输出 findings first。

### Phase C4: Verification Gate

目标：完成前进行统一检查。

验收：

- 测试失败、pending step、未验证关键事实都会产生 `warn` 或 `fail`。
- 最终回答必须包含未验证项和剩余风险。

### Phase C5: Eval and CI Gate

目标：prompt/harness 改动有回归测试。

验收：

- 本地无外部 API key 可跑 deterministic eval。
- CI 至少覆盖 priority safety、tool routing、memory、subagent verification、completion contract。
- eval report 能关联 run artifact。

## 风险和取舍

- Prompt registry 过早复杂化会增加接入成本，所以先保持 opt-in。
- Verification gate 如果太严格，会阻塞探索型任务，需要支持 `warn` 而不是只有 `pass/fail`。
- Durable goal ledger 会引入迁移和清理问题，需要先定义 TTL、storage scope 和隐私策略。
- Role agents 能提高并行度，但也会增加成本和验证负担，必须让 worker scope 足够窄。
- Memory governance 很容易影响用户体验，需要明确“当前对话事实”和“长期偏好”的边界。

## 推荐下一步

1. 先把本次 B 方案合并，作为 prompt 结构化基线。
2. 再做 C1：`ContextAssemblyReport`，因为它能直接提高调试和 eval 能力。
3. 然后做 C4：`VerificationGate`，因为它最能减少“看似完成但没有证据”的问题。
4. 最后再引入 C2/C3 的 durable goal 和 role registry，避免一次性扩大运行时复杂度。
