# Mido 路线图

这是当前 roadmap 的事实来源。它只保留方向、优先级和近期 backlog，
详细执行步骤链接到对应计划文档，避免在多个地方重复维护同一组任务。

## 产品方向

Mido 是一个 TypeScript-first SDK，面向这样的产品形态：agent loop 运行在
服务端，客户端拥有本地能力，一次 run 可以通过 provider-neutral 协议暂停、
恢复、检查和 replay。

路线图需要保持这个边界清晰：

- 服务端拥有 agent loop、model adapter、checkpoint、thread/event store、
  policy、tracing 和 orchestration。
- 客户端拥有本地工具、设备上下文、UI 审批、凭据和 native transport。
- MCP、Agent Skills、provider adapters 和 toolkit tools 都接入同一套协议，
  不变成彼此割裂的新 runtime。

## 当前状态

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| Server-owned agent loop | 已完成 | 已在 `@mido/server-sdk` 中实现。 |
| Client tool execution | 已完成 | 已支持 `server`、`client_auto` 和 `client_interactive`。 |
| Checkpoint/resume | 已完成 | Client tools 会暂停 run，并通过 `RunResumeRequest` 恢复。 |
| Run cancel and demo retry | 首版完成 | Tool-level retry 和 reconnect recovery 仍需补齐。 |
| Thread/event storage | 首版完成 | Checkpoint、thread 和 event store 已拆分。 |
| Trace and run inspector data | 首版完成 | SDK trace 数据已存在；可复用 inspector UI 仍是后续工作。 |
| Tool risk policy | 首版完成 | Opt-in policy 已存在；standard permission events 仍待补齐。 |
| Provider capability checks | 首版完成 | Adapter capabilities 和 preflight checks 已存在。 |
| Managed MCP lifecycle | 首版完成 | Managed connection helpers 和 refresh diffs 已存在。 |
| Agent Skills | 首版完成 | 已支持 progressive loading 和 sandboxed script tool。 |
| Toolkit tools | 首版完成 | 已有 workspace、retrieval、browser adapter 和 scoped memory tools。 |
| Evaluator and run artifacts | 计划中 | 见 harness improvement plan。 |

## 优先级

### P0: Evaluation and reproducibility

目标：让每一次有意义的 agent 改动都可以被度量。

工作项：

- 新增 `@mido/evaluator`，支持 run metrics、suite aggregation 和
  Markdown/JSON reports。
- 定义 run artifact manifest，包含 request hash、event trace、tool manifest、
  model capabilities、skill refs 和 git metadata。
- 增加不依赖外部 API key 的本地 smoke 和 safety eval cases。

详细计划：[Harness Improvement Plan](./plans/harness-agent-improvement-plan.md)。

### P1: Error recovery and durable resume

目标：让失败可以恢复，而不只是被记录下来。

工作项：

- 增加 provider/server tool retry policy，并明确 idempotency 规则。
- 把 retry attempts 写入 trace attributes 和 evaluator metrics。
- 增加 durable checkpoint storage 和面向 multi-worker deployment 的 run lease
  语义。
- 文档化 reconnect 和 replay recovery 路径。

### P1: Permission events and tool execution limits

目标：让高风险动作可检查、可确认、可预算。

工作项：

- 为 denied 和 confirmation-required tool decisions 增加标准 permission events。
- 增加 per-run 和 per-tool execution limits。
- 对有副作用的 tool retry 和 concurrency 继续保持 opt-in。
- 扩展 policy denial、confirmation、timeout 和 budget overflow 指标。

### P1: Context assembly reporting

目标：解释每次 model call 为什么收到了这一组上下文。

工作项：

- 为 model calls 发出 context assembly reports。
- 跟踪 selected messages、dropped messages、summary usage、estimated input
  tokens 和 tool count。
- 通过 evaluator reports 展示 context metrics。

### P2: Provider and toolkit maturity

目标：扩展支持面，同时不削弱核心协议边界。

工作项：

- 增加更多 provider capability presets 和 conformance helpers。
- 按需要增加 Anthropic/native cloud gateway 示例。
- 用 policy metadata、trace coverage 和文档加固 toolkit tools。
- 增加 durable scoped memory store 和 memory write governance。

## 非目标

- 不把完整 agent loop 移到 web、iOS、desktop 或其他客户端。
- 不把 MCP 做成主要 app transport。
- 不把 OpenAI-compatible、Anthropic-compatible、routers、cloud gateways 和
  local runtimes 视为能力完全相同。
- 不在缺少 policy metadata、tracing 和清晰 confirmation behavior 的情况下发布
  高影响内置工具。
- 不让 web demo 成为唯一支持的 inspector 方案。

## 相关文档

- [Capability Backlog](./agent-capability-roadmap.md)
- [Harness Improvement Plan](./plans/harness-agent-improvement-plan.md)
- [Storage and Tracing](./storage-and-tracing.md)
- [Agent Skills](./agent-skills.md)
- [Architecture](./architecture.md)
