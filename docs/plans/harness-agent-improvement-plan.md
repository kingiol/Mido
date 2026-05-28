# Harness Agent Capability Audit and Improvement Plan

日期：2026-05-13

> Current roadmap source of truth: [Roadmap](../roadmap.md). This document is a
> detailed implementation plan for the evaluator, run artifact, recovery,
> memory, tool-control, context-report, and CI-gate workstreams.

## 结论

Mido 现在已经不是一个裸 agent。它有稳定的 server-owned loop、工具路由、checkpoint/resume、thread/event store、context summary、tool policy、trace 和 demo inspector。

真正的短板在 harness 层：没有标准 evaluator，没有批量指标聚合，没有 run artifact 复现包，没有统一 retry/cost budget，也没有把 memory、safety、robustness 纳入可回归测试。下一步最应该先做评估闭环，再补运行控制。

## 证据索引

- Server loop、工具注册、run/resume/cancel 都集中在 `packages/server-sdk/src/runner.ts`。
- `SessionStore`、`ThreadStore`、`EventStore` 已拆开，支持 checkpoint、thread snapshot 和 event replay。见 `packages/server-sdk/src/store.ts`。
- `ToolPolicyProvider` 已支持 `allow`、`deny`、`require_confirmation` 三种决策，但 runner 目前只把 `allow` 当可执行，其余会阻断。见 `packages/server-sdk/src/policy.ts` 和 `packages/server-sdk/src/runner.ts`。
- `TraceMetadata`、`RunTraceSummary`、`buildRunTrace(events)` 已经能从事件流得到 model/tool span、duration、usage 和 errors。见 `packages/protocol-core/src/index.ts`。
- Context budget、summary trigger、token estimation 已经独立成模块。见 `packages/server-sdk/src/context-budget.ts`。
- Client runtime 已有 conversation memory、shared state、tool state、cancel、retryLastRun、auto tool timeout 和 interactive approval。见 `packages/client-core/src/index.ts`。
- Toolkit memory 有 list/search/read/write/delete，但默认 store 是 in-memory。见 `packages/toolkit-core/src/memory.ts`。
- Web demo 的 Run Inspector 已展示 status、duration、event count、usage、model/tool spans、errors，并能导出 JSONL。见 `apps/web-demo/src/App.tsx`。
- Conformance 目前覆盖协议事件顺序，不覆盖成功率、成本、鲁棒性、安全性、一致性这些评估指标。见 `packages/conformance/src/index.ts`。

## 能力评估

| 维度 | 当前状态 | 主要缺口 | 优先级 |
| --- | --- | --- | --- |
| Tool Execution | 有 registry、schema validation、server/client 分流、timeout、abort、policy expose/execute/resume | 缺少并发控制、retry budget、circuit breaker、统一 cost/rate budget、标准 permission event | P1 |
| Memory | 有 thread snapshot、summary message、client conversation memory、scoped memory tools | 缺少 durable memory store、memory write policy、memory promotion/evaluation、冲突和过期策略 | P1 |
| State Persistent | 有 checkpoint/thread/event 三类 store，filesystem thread/event 和 Redis checkpoint | demo checkpoint 仍是 in-memory；缺少 FileSystemSessionStore、run lease、multi-process append guarantees、replay recovery API | P1 |
| Error Recovery | 有 error events、tool timeout、cancel、checkpoint resume、duplicate resume idempotency、MCP stale retry once | 缺少 provider/server tool retry policy、retry attempt trace、从 event log 重建恢复状态、故障注入评估 | P0 |
| Context Orchestration | 有 server prompt policy、skill prompt composition、summary window、context freeze | 缺少 context assembly report、工具输出压缩策略、context provenance、budget 使用指标 | P1 |
| Logging and Reproducibility | 有 CoreEvent JSONL、TraceMetadata、buildRunTrace、demo export | 缺少 run manifest、tool/prompt/skill/model config hash、replay CLI、环境和版本记录 | P0 |
| Evaluation and Metrics | 只有 conformance scenario 和 inspector，不是 evaluator | 缺少 success rate、efficiency、cost、robustness、safety、consistency 的标准数据模型和聚合器 | P0 |

## 目标形态

```text
+----------------------------------------------------------------------------+
| Eval Suite: harness-smoke                                                   |
+----------------------------------------------------------------------------+
| Version: git sha + model adapter + prompt hash + tool manifest hash          |
| Runs: 120       Success: 91.7%      Cost: $2.31      P95 latency: 8.4s       |
+----------------------------------------------------------------------------+
| Metric          Current    Baseline    Delta      Gate                      |
| Success Rate    91.7%      89.2%       +2.5%      pass                      |
| Efficiency      2.1 calls  2.4 calls   -12.5%     pass                      |
| Cost            $0.019/run $0.018/run  +5.6%      warn                      |
| Robustness      96.0%      94.0%       +2.0%      pass                      |
| Safety          100%       100%        0          pass                      |
| Consistency     0.84       0.86        -0.02      warn                      |
+----------------------------------------------------------------------------+
| Failed cases                                                                 |
| - memory-write-recall: expected durable recall after restart                  |
| - policy-confirm-server-tool: missing permission event                        |
+----------------------------------------------------------------------------+
```

## 可执行计划

### Phase 0: 建立 evaluator 包

目标：先让 harness 能量化自己，而不是继续只靠手工 inspector。

文件：
- Create: `packages/evaluator/package.json`
- Create: `packages/evaluator/src/index.ts`
- Create: `packages/evaluator/src/types.ts`
- Create: `packages/evaluator/src/metrics.ts`
- Create: `packages/evaluator/src/artifact.ts`
- Create: `packages/evaluator/src/report.ts`
- Create: `tests/evaluator.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `tsconfig.json`
- Modify: `README.md`
- Create: `docs/evaluation.md`

步骤：
- [ ] 新增 `@mido/evaluator` package，导出 `EvalCase`、`EvalRunArtifact`、`RunMetrics`、`EvalSuiteReport` 类型。
- [ ] 写 `calculateRunMetrics(events, options)`，输入 `CoreEvent[]`，内部复用 `buildRunTrace(events)`。
- [ ] 写 `aggregateEvalSuite(results)`，聚合 case 级指标。
- [ ] 写 `buildRunArtifact(input)`，保存 request、events、trace、metrics、tool manifest、model capabilities、skill refs、git sha、createdAt。
- [ ] 写 `renderEvalReport(report)`，输出 Markdown。
- [ ] 加测试覆盖 text-only、server tool、client tool pending/resume、tool error、provider error、usage missing。
- [ ] 文档写清 evaluator 是 SDK 组件，不绑定 web demo。

验收：
- `pnpm test -- tests/evaluator.test.ts` 通过。
- `pnpm lint` 通过。
- `pnpm build` 通过。
- 一个 `CoreEvent[]` 能生成完整 `RunMetrics` 和 Markdown report。

指标定义：
- `successRate`: passed cases / total cases。
- `efficiency`: durationMs、modelCallCount、toolCallCount、eventCount、retryCount、contextEstimate。
- `cost`: inputTokens、outputTokens、totalTokens、estimatedCostUsd、missingUsageCount。
- `robustness`: retryableErrorCount、toolErrorCount、providerErrorCount、recoveredErrorCount、timeoutCount。
- `safety`: policyDeniedCount、confirmationRequiredCount、unsafeToolAttemptCount、privateNetworkBlockedCount。
- `consistency`: repeated case pass variance、normalized output hash agreement、metric standard deviation。

### Phase 1: 定义 run artifact 和可复现格式

目标：任何一次 run 都能导出成一个可以复查、比较、部分 replay 的包。

文件：
- Modify: `packages/evaluator/src/artifact.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Modify: `apps/web-demo/src/export-jsonl.ts`
- Modify: `apps/web-demo/src/App.tsx`
- Create: `docs/run-artifacts.md`
- Test: `tests/evaluator.test.ts`
- Test: `tests/web-demo-export.test.ts`

步骤：
- [ ] 在 evaluator 中定义 `RunArtifactManifest`，包含 `runId`、`threadId`、`traceId`、`createdAt`、`sdkVersion`、`gitSha`、`model`、`provider`、`adapterKind`、`toolManifestHash`、`systemPromptHash`、`skillDigestList`。
- [ ] 增加 `hashToolManifest(tools)`，只 hash serializable tool definition，不包含 execute handler。
- [ ] 增加 `hashMessages(messages)`，用于识别输入是否变化，不存敏感原文时仍可比较。
- [ ] demo export 从单纯 JSONL 扩展成 artifact JSON，仍保留 JSONL export 入口。
- [ ] 文档说明敏感字段默认 hash，只有显式 `includePayload: true` 才导出完整 request/messages。

验收：
- 导出的 artifact 可以重新计算同一个 `RunTraceSummary`。
- 同一组 events 重复生成 artifact，除 `createdAt` 外 hash 稳定。
- demo export 测试覆盖 artifact 文件名和内容结构。

### Phase 2: 建立标准 eval cases 和批量 runner

目标：把“能跑”变成“每次改动都知道有没有退步”。

文件：
- Create: `docs/evals/harness-smoke.jsonl`
- Create: `docs/evals/harness-safety.jsonl`
- Create: `packages/evaluator/src/runner.ts`
- Create: `packages/evaluator/src/graders.ts`
- Create: `tests/evaluator-runner.test.ts`
- Modify: `package.json`

步骤：
- [ ] 定义 `EvalCaseRunner` 接口，让应用传入自己的 `runCase(case)`，避免 evaluator 绑定某个 model provider。
- [ ] 实现 deterministic grader：exact text、contains text、event sequence、tool called、tool not called、run status、error code。
- [ ] 实现 metric gate：例如 success rate 不能低于 baseline，cost 不能高于 10%，safety 必须 100%。
- [ ] 新增 `pnpm eval:smoke`，使用 fake model adapter 跑本地 smoke cases。
- [ ] 写 smoke cases：text-only、server tool、client auto tool、client interactive rejection、policy deny、context budget exceeded、memory write/read、provider capability rejection。
- [ ] 写 safety cases：private network fetch blocked、destructive server tool hidden/denied、memory delete requires interactive or policy allow。

验收：
- `pnpm eval:smoke` 在无外部 API key 下可运行。
- 报告输出 Markdown 和 JSON。
- 任意 case failure 都能定位到 run artifact。

### Phase 3: 补齐 error recovery 和 retry policy

目标：失败不只被记录，还能按策略恢复，并能被评估。

文件：
- Modify: `packages/server-sdk/src/runner.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Modify: `packages/conformance/schemas/*.json`
- Test: `tests/server-sdk.test.ts`
- Test: `tests/evaluator.test.ts`
- Modify: `docs/data-flow.md`
- Modify: `docs/storage-and-tracing.md`

步骤：
- [ ] 增加 `RetryPolicy` 类型：按 `source`、`code`、`retryable`、`attempt`、`toolName`、`provider` 决定是否 retry。
- [ ] provider error 支持 retry：仅对 `retryable: true` 或 policy 明确允许的错误重试。
- [ ] server tool error 支持 retry：只对声明 idempotent 的工具启用。
- [ ] 每次 retry 都写入 trace attributes：`retryAttempt`、`retryReason`、`maxAttempts`。
- [ ] evaluator 读取 retry attempt，计算 `retryCount`、`recoveredErrorCount`、`retryExhaustedCount`。
- [ ] 文档说明默认不重试有副作用工具。

验收：
- retryable provider error 第一次失败、第二次成功时，最终 run completed。
- non-idempotent server tool 不会被自动 retry。
- retry attempts 在 metrics 中可见。

### Phase 4: 持久 checkpoint 和 run lease

目标：进程重启或多 worker 部署时，等待客户端工具的 run 不容易丢。

文件：
- Modify: `packages/server-sdk/src/store.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Test: `tests/server-sdk.test.ts`
- Modify: `apps/web-demo/server.ts`
- Modify: `docs/storage-and-tracing.md`

步骤：
- [ ] 增加 `FileSystemSessionStore`，用 atomic write 保存 checkpoint，并按 TTL 清理。
- [ ] 给 `SessionStore` 增加可选 compare-and-set 风格 lease 方法，或者新增 `RunLeaseStore`，避免同一个 checkpoint 被多个 worker 同时 resume。
- [ ] demo server 支持 `MIDO_SESSION_STORE=file`，默认开发仍可用 in-memory。
- [ ] resume 时记录 lease acquisition failure 为可评估错误。
- [ ] evaluator 增加 checkpoint lost 和 lease conflict 指标。

验收：
- 保存 checkpoint 后重建 runner，仍可 resume。
- 同一 checkpoint 并发 resume 时只能一个成功，另一个得到确定错误。
- event store 里能看到冲突原因。

### Phase 5: Memory 从工具变成受治理能力

目标：memory 不只是可写 KV，而是有来源、置信度、生命周期和评估。

文件：
- Modify: `packages/toolkit-core/src/types.ts`
- Modify: `packages/toolkit-core/src/memory.ts`
- Create: `packages/toolkit-core/src/memory-file-store.ts`
- Test: `packages/toolkit-core/src/index.test.ts`
- Test: `tests/evaluator-runner.test.ts`
- Modify: `docs/agent-capability-roadmap.md`

步骤：
- [ ] 增加 `FileSystemMemoryStore`，按 scope 存 JSONL 或 JSON files。
- [ ] 给 `MemoryEntry` 增加 `sourceTraceId`、`expiresAt`、`tags`、`supersedes`。
- [ ] 增加 memory write policy helper：要求 `reason`、`sourceRunId` 或 `sourceTraceId`。
- [ ] evaluator 增加 memory cases：写入后重启仍可读；过期 memory 不召回；冲突 memory 只召回最新可信版本。
- [ ] 文档区分 thread summary、client conversation memory、scoped long-term memory。

验收：
- memory 写入跨进程保留。
- 删除和过期行为可测试。
- memory recall 的成功率进入 eval report。

### Phase 6: Tool execution controller

目标：把工具执行从“能调用”提升到“可调度、可预算、可保护”。

文件：
- Modify: `packages/server-sdk/src/runner.ts`
- Modify: `packages/server-sdk/src/policy.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Test: `tests/server-sdk.test.ts`
- Modify: `docs/architecture.md`

步骤：
- [ ] 增加 `ToolExecutionLimits`：per-run max tool calls、per-tool max attempts、parallel server tool concurrency、total tool time budget。
- [ ] runner 在执行前检查 limits，超限返回标准 tool error 或 run error。
- [ ] 对 side-effect-free server tools 允许并发执行；默认保持顺序执行。
- [ ] `require_confirmation` 不再只被当成 deny，增加标准 permission event 或 checkpoint reason。
- [ ] metrics 增加 `toolBudgetExceededCount`、`toolConcurrencyWaitMs`。

验收：
- 超过 per-run tool call limit 时 run 清晰失败。
- 并发只对显式 safe 的工具启用。
- policy `require_confirmation` 能被 UI 和 evaluator 区分出来。

### Phase 7: Context assembly report

目标：每次 model call 都能解释“为什么这些上下文进了模型”。

文件：
- Modify: `packages/server-sdk/src/runner.ts`
- Modify: `packages/server-sdk/src/context-budget.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Test: `tests/server-summary-messages.test.ts`
- Modify: `docs/storage-and-tracing.md`

步骤：
- [ ] 生成 `ContextAssemblyReport`：selectedMessageCount、estimatedInputTokens、maxInputTokens、triggerTokens、summaryUsed、summaryCreated、droppedMessageCount、toolCount。
- [ ] 把 report 放入 `MODEL_CALL_START.trace.attributes.context`。
- [ ] evaluator 提取 context metrics：contextUtilization、summaryCreateCount、contextFreezeCount。
- [ ] 对过大的 tool output 增加 summary hint，避免原始大 payload 进入长期上下文。

验收：
- summary 创建和 context freeze 都能从 metrics 中看到。
- context 超预算失败能解释是哪一类上下文占用过大。

### Phase 8: CI gate 和 baseline 管理

目标：让评估进入日常开发，而不是一次性报告。

文件：
- Create: `.github/workflows/eval.yml` 或项目当前 CI 等价文件
- Create: `docs/evals/baselines/harness-smoke.json`
- Modify: `package.json`
- Modify: `docs/evaluation.md`

步骤：
- [ ] `pnpm eval:smoke -- --baseline docs/evals/baselines/harness-smoke.json` 支持 gate。
- [ ] gate 失败时输出 failed cases、metric deltas、artifact 路径。
- [ ] baseline 更新需要显式命令：`pnpm eval:update-baseline`。
- [ ] 文档说明哪些指标是 hard gate，哪些是 warning。

验收：
- success rate 和 safety regression 会让 CI 失败。
- cost/latency 默认 warning，超过项目配置阈值才失败。
- 每次 CI 保存 eval report artifact。

## 建议执行顺序

先做 Phase 0 到 Phase 2。原因很简单：没有 evaluator，后面的 retry、memory、tool controller 都只能靠单元测试证明局部行为，证明不了 agent 是否真的变强。

然后做 Phase 3 和 Phase 4。它们直接提升错误恢复和状态持久化，是 harness 稳定性的底座。

最后做 Phase 5 到 Phase 8。memory、tool controller、context report 和 CI gate 都应该接入同一套 metrics，否则会变成彼此孤立的功能。

## 不建议现在做的事

- 不建议先上复杂多 agent 调度。当前缺口不是 agent 数量，而是每次 run 是否可评估、可恢复、可复现。
- 不建议把 evaluator 绑死在 web demo。Mido 是 SDK，评估层应该吃协议事件和 runner adapter。
- 不建议默认自动重试所有工具。带副作用工具必须先证明 idempotent，否则 retry 会制造真实破坏。
- 不建议把长期 memory 和 thread summary 合并。summary 是当前 thread 的压缩上下文，memory 是跨 thread 的可治理事实。

## 完成定义

这份计划完成时，Mido 应该能回答以下问题：

- 这个版本相对 baseline 成功率有没有变高？
- 每个 case 花了多少 model call、tool call、token、时间和钱？
- 失败是 provider、tool、policy、context，还是 client resume 导致的？
- 同一个 case 重复跑，答案是否稳定？
- 高风险工具有没有被阻止或确认？
- 给定一个失败 run，能不能拿 artifact 复查当时的 prompt、tools、skills、model capability 和 event trace？
