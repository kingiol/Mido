# Mido 快速商业化改造与商业闭环计划报告

## 0. 报告目的

本报告用于指导 Mido 后续从开源/研发型 Agent SDK 演进为可商业化 SaaS Agent 平台。报告基于 `kingiol/Mido` 公开仓库当前内容进行分析，重点回答三件事：

1. Mido 当前有哪些可商业化资产。
2. 为了快速商业化，需要按哪些模块改造。
3. 如何形成从获客、激活、使用、付费到续费扩张的商业闭环。

## 1. 信息来源与判断边界

- 分析对象：[`kingiol/Mido`](https://github.com/kingiol/Mido)
- 读取版本：`cad2b47`，commit message 为 `feat(server-sdk): add opt-in agent delegation`。
- 读取范围：根 [`README.md`](https://github.com/kingiol/Mido/blob/cad2b47/README.md)、[`docs/`](https://github.com/kingiol/Mido/tree/cad2b47/docs)、[`packages/`](https://github.com/kingiol/Mido/tree/cad2b47/packages)、[`apps/web-demo`](https://github.com/kingiol/Mido/tree/cad2b47/apps/web-demo)、[`apps/ios-demo`](https://github.com/kingiol/Mido/tree/cad2b47/apps/ios-demo)、[`tests/`](https://github.com/kingiol/Mido/tree/cad2b47/tests)。
- 未运行 Mido 测试或 demo；本报告是产品/商业化计划，不是源码质量审计。
- 当前结论以仓库文档与导出面为准，未来如 Mido 代码结构变化，应以新版本仓库重新校准。

## 2. 一句话结论

Mido 当前不是一个可直接售卖的终端 SaaS，而是一个已经具备较强底层能力的 **Agent Runtime / Agent Protocol SDK**。最快商业化路径不是马上做“大而全的 Devin/Roomote”，而是：

> 保留 Mido Core 开源 SDK 作为获客入口，优先推出 **Mido Cloud：托管 Agent Runtime + Run Inspector + Evaluation**，再用 **GitHub PR Agent / Human-in-the-loop 本地工具 Agent** 作为旗舰模板打通端到端商业闭环。

推荐商业化顺序：

1. **Mido Core OSS**：继续提供协议、SDK、conformance、基础工具，作为开发者入口。
2. **Mido Cloud Runtime**：托管 runner、checkpoint、event store、trace、inspector、usage/billing。
3. **Mido Eval & Observability**：把已有 `@mido/evaluator` 和 event trace 产品化，形成低门槛付费点。
4. **Mido Connectors / Templates**：GitHub、Linear、Slack、Figma、Vercel 等连接器，以及 GitHub PR Agent 模板。
5. **Mido Enterprise**：SSO/RBAC/audit/私有化/合规/高级策略。

## 3. 当前项目资产盘点

### 3.1 核心技术定位

Mido 根 README 明确定位为：TypeScript-first SDK，用于构建“agent loop 运行在服务端、客户端执行本地工具、run 可暂停/恢复/检查”的 Agent 应用。现有设计目标包括：

- server-owned agent loop；
- provider-neutral model adapters；
- resumable client-side tools；
- human-in-the-loop approval；
- MCP integration；
- AG-UI adapters；
- JSON Schema / conformance；
- durable checkpoints、thread/event stores、tracing、本地 run inspection。

商业价值：这不是普通聊天 SDK，而是适合构建“真实产品级 Agent”的运行底座，尤其适合需要本地工具、用户审批、跨端能力和可恢复执行的产品。

### 3.2 已有 package 与商业价值映射

| Package / 模块 | 当前能力 | 商业化价值 |
|---|---|---|
| `@mido/protocol-core` | CoreEvent、RunStart/Resume/Cancel、tool contract、schemas | 形成稳定协议，支撑多端 SDK、托管 API、合规审计 |
| `@mido/protocol-agui` | CoreEvent 与 AG-UI 事件适配 | 可接入 AG-UI 生态，降低前端迁移成本 |
| `@mido/server-sdk` | 服务端 agent loop、工具路由、checkpoint/resume、store、policy、skills、memory、provider adapters、多 agent orchestration | Mido Cloud Runner 的核心执行引擎 |
| `@mido/client-core` | transport-agnostic client runtime、本地工具注册、`client_auto`、`client_interactive`、resume | 支撑 web/desktop/mobile 本地能力执行 |
| `@mido/client-web` | SSE transport、React hooks、reference panel | 可升级为商业 dashboard/嵌入式 approval UI |
| `packages/client-ios` / `MidoClient` | Swift 6 SDK、Codable models、AgentClient actor、URLSessionSSETransport | 移动端 Agent 产品差异化入口 |
| `@mido/mcp-core` | MCP 连接管理、health check、refresh diff、server/client MCP 映射 | 连接器生态和企业内部工具接入基础 |
| `@mido/toolkit-core` | workspace、search/fetch/retrieval、browser adapter、memory tools | GitHub PR Agent、浏览器 Agent、知识库 Agent 的基础工具面 |
| `@mido/conformance` | schema export、native contract、event sequence | 企业/第三方 SDK 接入的稳定性保障 |
| `@mido/evaluator` | run metrics、suite aggregation、run artifact、smoke/safety eval | 最容易独立商业化的 Agent observability/eval 产品线 |
| `apps/web-demo` | 本地 demo API、web client、skills、MCP、toolkit 示例 | Mido Cloud Dashboard / Playground 的原型 |
| `apps/ios-demo` | iOS demo | 移动端 Agent SDK 销售样例 |

### 3.3 已具备的产品化优势

#### 3.3.1 Server loop + client local tools 是差异化核心

多数 Agent 产品要么完全云端，要么完全本地。Mido 的价值在于：

- 模型推理与 agent loop 留在服务端，便于控制 prompt、policy、storage、eval、计费。
- 客户端保留本地工具、设备能力、凭据、用户审批，避免把敏感能力全部交给云端。
- `client_auto` 和 `client_interactive` 形成天然的人类审批边界。

这非常适合：

- 浏览器插件 Agent；
- 桌面/移动端 Copilot；
- 企业内部工具 Agent；
- 需要用户本地凭据或设备权限的应用；
- 高风险动作需要审批的自动化系统。

#### 3.3.2 事件协议与持久化适合做可观测性

Mido 已经将运行过程抽象为 `CoreEvent` 流，并拆分：

- `SessionStore`：短期 checkpoint；
- `ThreadStore`：长期 thread snapshot；
- `EventStore`：run event log。

这天然适合商业化为：

- Run Inspector；
- Replay；
- Evaluation；
- Audit log；
- Support bundle export；
- 成本/错误/安全指标分析。

#### 3.3.3 Evaluator 是低门槛商业入口

`@mido/evaluator` 已具备：

- `calculateRunMetrics(events)`；
- `aggregateEvalSuite(...)`；
- `buildRunArtifact(...)`；
- Markdown/JSON report；
- smoke/safety fixtures；
- local store evaluation。

这意味着 Mido 不必一开始就和所有云端编码 Agent 正面竞争，可以先卖“Agent 可观测性 + 回归评估”，用低侵入方式切入已有 Agent 团队。

#### 3.3.4 Toolkit 已能支撑第一个垂直场景

`@mido/toolkit-core` 已覆盖 workspace、search/fetch/retrieval、browser、memory 等通用工具。尤其 workspace 工具已包括：

- list/read/stat；
- apply patch/write file；
- run command；
- allowlist、timeout、output limit、policy metadata。

这为“GitHub PR Agent / Coding Agent 模板”提供基础，但还需要补齐 repo lifecycle、sandbox、PR connector、测试报告和审批策略。

## 4. 当前离 SaaS 商业化的主要缺口

### 4.1 产品形态缺口

当前 Mido 更像 SDK + demo，缺少真正 SaaS 所需的产品层：

- 用户注册、登录、组织、workspace、project；
- API key / service token 管理；
- hosted runner 配置；
- provider key / BYOK 管理；
- run 列表、thread 列表、trace viewer；
- usage / cost dashboard；
- billing / plans / quota；
- connector 授权管理；
- approval inbox；
- team audit log；
- onboarding、template、quickstart、示例市场。

### 4.2 多租户与鉴权缺口

Mido storage 文档明确说明：SDK 不负责鉴权，也不内置 `tenantId`、`userId`、JWT、登录态。`storageScope` 只是 namespace，不是权限系统。

商业 SaaS 必须补：

- AuthN：邮箱登录、GitHub OAuth、SSO/OIDC/SAML；
- AuthZ：org/workspace/project role；
- API token：user token、project token、service token；
- storageScope 与真实 tenant/user/workspace 的可信绑定；
- 所有 `/run`、`/resume`、`/cancel`、artifact、trace 查询都必须做权限校验；
- 审计日志按真实身份记录，而不是只按 runId/threadId。

### 4.3 托管执行缺口

当前 `apps/web-demo/server.ts` 具备 `/api/run`、`/api/resume`、`/api/cancel` 等 demo endpoint，但还不是生产托管执行平台。

需要补：

- API Gateway；
- queue/job system；
- runner worker；
- long-running run lease；
- distributed checkpoint；
- worker heartbeat；
- timeout/retry/cancel；
- horizontal scaling；
- isolated sandbox；
- run artifact store；
- per-run budget；
- provider/model fallback；
- failure recovery。

### 4.4 权限与审批产品化缺口

Mido 已有 `client_interactive` 与 opt-in `toolPolicy`，但 SaaS 还需要将其产品化：

- standard permission events；
- confirmation-required event；
- denied event；
- budget-overflow event；
- policy rule builder；
- approval inbox；
- Slack / email / mobile push 审批；
- 管理员审批；
- 二次确认；
- high-risk tool audit；
- 按 tenant/project/user 的 tool allowlist/denylist。

### 4.5 Provider 生态缺口

当前已有 DeepSeek、Vercel AI、OpenAI-compatible、OpenAI Responses。若做 SaaS，需要进一步补：

- Anthropic native；
- Gemini native；
- Azure OpenAI；
- AWS Bedrock Converse；
- Google Vertex AI；
- OpenRouter / LiteLLM / Vercel AI Gateway presets；
- provider capability presets；
- request id / usage / rate limit / retryable errors 归一化；
- BYOK 与托管 key 双模式；
- model routing / fallback / cost guardrails。

### 4.6 连接器缺口

Mido 现有 MCP 与 toolkit 基础很好，但商业 SaaS 需要业务连接器：

- GitHub / GitLab；
- Linear / Jira；
- Slack / Teams；
- Vercel；
- Figma；
- Notion / Confluence；
- Sentry / Datadog；
- Zendesk / Intercom；
- Google Drive / SharePoint。

每个连接器都要有：OAuth、权限 scope、tool definition、risk metadata、审计、rate limit、token refresh、断连处理。

### 4.7 文档与 go-to-market 缺口

现有文档偏架构和研发 roadmap。商业化需要按用户旅程重写：

- 5 分钟 hosted quickstart；
- “Build your first resumable agent” 教程；
- “Add local tools to a web app” 教程；
- “Add iOS local tools” 教程；
- “Run inspector and eval in CI” 教程；
- “GitHub PR Agent template” 教程；
- 价格页、案例页、比较页；
- 安全白皮书；
- 迁移指南：从 LangChain / Vercel AI SDK / AG-UI / MCP-only 迁移。

## 5. 推荐商业化定位

### 5.1 首选定位：Mido Cloud Runtime

一句话：

> 面向正在构建 AI Agent 应用的团队，提供托管的 server-owned agent loop、client tool resume、checkpoint、tracing、evaluation 和 approval runtime。

目标客户：

- 正在做 AI-native 产品的创业团队；
- 企业内部平台团队；
- 有 web/mobile/desktop 本地能力需求的 Agent 团队；
- 需要人类审批和可恢复执行的自动化产品。

核心卖点：

- 不只是一次模型调用，而是完整可恢复 agent run；
- 本地工具和凭据留在客户端；
- 高风险动作可审批；
- 每次 run 可检查、可 replay、可评估；
- provider-neutral，支持 BYOK。

### 5.2 第二定位：Mido Eval & Observability

一句话：

> 面向已有 Agent 的团队，提供事件流接入、run artifact、trace、eval、回归报告和安全指标。

这个方向商业化最快，因为客户可以不替换现有 agent runtime，先上传或接入 `CoreEvent` / artifact 即可获得价值。

核心卖点：

- 快速看清 agent 为什么失败；
- 工具调用、模型调用、成本、错误、policy 决策可追踪；
- CI 中做 smoke/safety/regression gate；
- 默认不上传敏感 payload，只上传 hash/metadata，降低隐私门槛。

### 5.3 第三定位：Human-in-the-loop Local Tools Framework

一句话：

> 为 web、desktop、mobile Agent 提供安全的本地工具执行、审批、MCP 接入和恢复协议。

这是 Mido 与纯云端 Agent 的差异点，尤其适合：

- 浏览器插件；
- 桌面自动化；
- 移动端助手；
- 企业内部系统；
- 需要用户本地授权或审批的任务。

## 6. 推荐产品形态

### 6.1 产品线拆分

| 产品线 | 面向用户 | 免费/开源内容 | 付费内容 |
|---|---|---|---|
| Mido Core | 开发者 | protocol、SDK、client runtime、server SDK、基础 conformance | 商业支持、LTS、私有化 |
| Mido Cloud Runtime | Agent 产品团队 | 本地 demo、limited free runs | Hosted runner、durable storage、inspector、team、quota |
| Mido Eval | Agent 工程团队 | local evaluator、JSON/MD report | Cloud dashboard、CI baseline、regression alerts、team reports |
| Mido Connectors | 团队/企业 | 基础 MCP 示例 | 托管 OAuth、GitHub/Slack/Linear/Jira、connector logs |
| Mido Enterprise | 企业 | N/A | SSO、RBAC、audit export、private deployment、custom policy、SLA |

### 6.2 免费层策略

免费层要服务于开发者获客，而不是承担完整成本：

- 免费：本地 SDK、local demo、local evaluator、少量 cloud runs、公开项目。
- Pro：更多 cloud runs、private projects、run history、basic inspector。
- Team：成员管理、shared projects、connectors、approval inbox、usage dashboard。
- Enterprise：SSO/RBAC、audit export、BYOK enforcement、VPC/private deploy、custom retention、SLA。

### 6.3 收费指标

建议组合计费，避免只按 seat 或只按 token：

1. **Seat**：团队协作、审批、dashboard 权限。
2. **Run / execution minutes**：托管 runner 成本。
3. **Event / artifact retention**：trace 和 storage 成本。
4. **Connector count / premium connectors**：OAuth 与维护成本。
5. **Eval cases / CI runs**：可观测性产品价值。
6. **Enterprise add-ons**：SSO、audit、private deployment。

## 7. 目标 SaaS 架构

### 7.1 目标架构图

```text
                         ┌──────────────────────────┐
                         │       Mido Dashboard      │
                         │ projects / runs / billing │
                         └─────────────┬────────────┘
                                       │
┌──────────────┐      HTTPS/SSE        │        ┌────────────────────┐
│ Web/iOS/App  │ ──────────────────────┼──────▶ │ Mido API Gateway    │
│ Client SDKs  │ ◀──── events/resume ──┘        │ auth / rate limit   │
└──────┬───────┘                                └─────────┬──────────┘
       │ local tools / approval                           │
       ▼                                                   ▼
┌──────────────┐                                ┌────────────────────┐
│ Local Tools  │                                │ Control Plane       │
│ browser/iOS  │                                │ org/project/config  │
└──────────────┘                                └─────────┬──────────┘
                                                          │ enqueue
                                                          ▼
                                                ┌────────────────────┐
                                                │ Runner Workers      │
                                                │ server-sdk loop     │
                                                │ leases/checkpoints  │
                                                └──────┬───────┬─────┘
                                                       │       │
                                        model calls    │       │ tools/connectors
                                                       ▼       ▼
                                              ┌────────────┐ ┌──────────────┐
                                              │ Providers  │ │ MCP/Connectors│
                                              │ BYOK/cloud │ │ GitHub/Slack  │
                                              └────────────┘ └──────────────┘
                                                       │
                                                       ▼
                                                ┌────────────────────┐
                                                │ Data Plane          │
                                                │ checkpoints/events  │
                                                │ threads/artifacts   │
                                                │ eval metrics/audit  │
                                                └────────────────────┘
```

### 7.2 新增应用与包建议

| 建议新增路径 | 作用 |
|---|---|
| `apps/cloud-api` | 生产 API：auth、project、run、resume、cancel、artifact、billing webhook |
| `apps/cloud-dashboard` | SaaS 控制台：projects、runs、trace、billing、connectors、approvals |
| `apps/landing` | 商业官网与文档入口 |
| `packages/inspector-ui` | 从 `apps/web-demo` 提炼可复用 Run Inspector 组件 |
| `packages/cloud-store` | Postgres/Redis/Object Storage 的生产 store 实现 |
| `packages/cloud-runner` | queue、lease、worker、sandbox、budget、retry、artifact upload |
| `packages/connectors-github` | GitHub OAuth、repo clone、branch、PR、issue tools |
| `packages/connectors-linear` | Linear ticket tools |
| `packages/connectors-slack` | Slack command、approval card、notification tools |
| `packages/billing` | metering、usage aggregation、Stripe/Paddle webhook adapter |
| `packages/security-policy` | permission events、policy templates、approval workflows |
| `packages/templates` | GitHub PR Agent、Browser QA Agent、Mobile Local Tools Agent 模板 |

## 8. 按当前代码的具体改造点

### 8.1 `apps/web-demo`：从 demo 拆成产品原型

当前价值：已展示 `/api/run`、`/api/resume`、`/api/cancel`、skills、toolkit、MCP、event timeline。

改造方向：

1. 保留 `apps/web-demo` 作为本地开发体验。
2. 提炼通用 UI 到 `packages/inspector-ui`：
   - run timeline；
   - tool calls；
   - pending approvals；
   - event JSONL export；
   - trace summary；
   - errors/cost/latency。
3. 新建 `apps/cloud-dashboard`：
   - 登录后 project 列表；
   - run list；
   - thread list；
   - run detail；
   - approval inbox；
   - connector settings；
   - usage/billing。
4. 新建 `apps/cloud-api` 替代 demo server：
   - 鉴权；
   - tenant/project/user scope 解析；
   - 调用 hosted runner；
   - 落库 event/thread/artifact；
   - 做 rate limit 和 quota。

验收标准：

- 不登录不能调用 production `/run`。
- 每个 run 必须绑定 `orgId/projectId/userId`。
- dashboard 能按权限查看 run 与 trace。
- demo server 与 cloud API 边界清晰，避免 demo 逻辑进入生产路径。

### 8.2 `@mido/server-sdk`：补 SaaS 运行时能力

当前价值：已有 runner、tool routing、checkpoint、policy、skills、memory、adapters。

改造点：

1. **标准 permission events**
   - 新增 `PERMISSION_REQUIRED`、`PERMISSION_DENIED`、`PERMISSION_APPROVED`、`BUDGET_EXCEEDED` 等事件。
   - 所有 toolPolicy 决策进入 event stream。

2. **run lease / multi-worker resume**
   - `runner.run` / `runner.resume` 支持 lease owner。
   - 防止同一个 run 被多个 worker 并发 resume。
   - heartbeat 过期后允许接管。

3. **execution budgets**
   - per-run max model calls；
   - max tool calls；
   - max wall time；
   - max token/cost；
   - max high-risk actions。

4. **retry policy**
   - provider retry；
   - server tool retry；
   - client resume idempotency；
   - retry 计入 trace/eval metrics。

5. **context assembly reporting**
   - 每次 model call 记录：选入消息、drop 消息、summary 使用、token 估算、tool count、skill refs。

6. **production store interface hardening**
   - 更明确的 transaction/append guarantee；
   - event append ordering；
   - checkpoint TTL；
   - run-index 查询。

验收标准：

- 同一 run 在多 worker 场景下不会双执行。
- 所有高风险工具决策都有事件和审计记录。
- 超预算 run 会可解释地停止，而不是无限消耗。
- 失败 run 可以被 dashboard 清楚解释。

### 8.3 `@mido/client-web`：产品化审批与嵌入组件

当前价值：已有 browser transport、React hooks、reference panel。

改造点：

1. 提供生产级组件：
   - `MidoProvider`；
   - `RunConsole`；
   - `ApprovalCard`；
   - `ToolCallTimeline`；
   - `RunStatusBadge`。
2. approval card 标准化展示：
   - tool name；
   - risk level；
   - effects/scopes；
   - args diff；
   - expected impact；
   - approve/reject/modify。
3. 支持 cloud auth headers / token refresh。
4. 支持 reconnect/replay，刷新页面后恢复 pending tool。
5. 增加 UI 级 error boundary 和 telemetry hook。

验收标准：

- 第三方 app 10 分钟内能嵌入审批 UI。
- 用户刷新页面后 pending approval 不丢。
- destructive tool 默认显示高风险说明。

### 8.4 `packages/client-ios`：移动端商业化增强

当前价值：Swift 6 SDK 已支持 protocol models、AgentClient actor、URLSessionSSETransport、本地工具处理。

改造点：

1. SwiftUI 组件：
   - chat/run view；
   - approval card；
   - tool call list；
   - reconnect banner。
2. iOS push resume：
   - agent 等待审批时通过 push 通知用户；
   - 用户点击后回到 pending action。
3. secure local tool templates：
   - Contacts/Calendar/Files/Location 等能力模板；
   - permission explanation。
4. Android SDK 规划：
   - Kotlin models；
   - SSE/HTTP transport；
   - local tool registry；
   - approval UI。

验收标准：

- iOS demo 可以接入 Mido Cloud 而非只连 local server。
- 移动端 pending approval 可被恢复。
- 本地敏感能力不会被自动无提示执行。

### 8.5 `@mido/toolkit-core`：从基础工具到安全工具市场

当前价值：已有 workspace、search/fetch/retrieval、browser、memory tools。

改造点：

1. 全工具补齐 policy metadata、trace metadata、budget metadata。
2. workspace tools 增加：
   - Git diff artifact；
   - patch preview；
   - command allowlist presets；
   - sandbox command runner；
   - secret redaction。
3. browser tools 增加：
   - origin allowlist；
   - form submission confirmation；
   - password/payment/message send guard；
   - screenshot artifact。
4. retrieval tools 增加：
   - durable vector store adapter；
   - namespace ACL；
   - ingestion job；
   - document source audit。
5. memory tools 增加：
   - tenant/user/project scope；
   - sensitive memory policy；
   - delete/export memory。

验收标准：

- 高风险工具默认不自动执行。
- 所有工具结果结构化，能进入 trace/artifact/eval。
- 工具不泄露 secret 到 event log。

### 8.6 `@mido/evaluator`：产品化为 Mido Eval

当前价值：已有 metrics、artifact、report、local eval。

改造点：

1. 增加 cloud upload client：
   - 上传 artifact；
   - 默认只上传 hash/metadata；
   - payload 明确 opt-in。
2. 增加 CI 集成：
   - GitHub Action；
   - GitLab CI template；
   - baseline comparison；
   - failure gate。
3. 增加 dashboard：
   - success rate；
   - tool error rate；
   - provider error rate；
   - latency/cost；
   - safety violation；
   - regression trend。
4. 增加 eval case management：
   - suites；
   - versions；
   - tags；
   - expected event sequence；
   - golden trace diff。

验收标准：

- 任意 Mido run 可生成 artifact 并上传 dashboard。
- CI 可在 regression 时失败。
- 默认不会上传用户原文和 tool sensitive output。

### 8.7 `@mido/mcp-core`：连接器控制台基础

当前价值：已有 managed connection、health check、refresh diff。

改造点：

1. MCP registry：
   - server-side MCP；
   - client-side MCP；
   - tool list preview；
   - status/health。
2. OAuth / secret vault integration。
3. Tool refresh 审计与版本管理。
4. CORS/proxy 配置产品化。
5. MCP tool risk metadata 自动补全或人工 review。

验收标准：

- dashboard 可看到 MCP 连接状态。
- tool 变化不会静默影响生产 run。
- 连接失效有告警和降级路径。

### 8.8 `@mido/conformance`：第三方生态门槛

当前价值：已有 schema 和 native client contract。

改造点：

1. 发布 conformance CLI。
2. 提供 provider adapter conformance kit。
3. 提供 client SDK conformance kit。
4. 提供 connector/tool conformance kit。
5. Dashboard 显示 conformance badge。

验收标准：

- 新 provider adapter 必须声明并验证 capabilities。
- 第三方 client 能通过标准 event sequence 测试。
- 商业客户能确认自己的私有部署与 Mido Cloud 协议兼容。

## 9. 第一款可销售产品：Mido Cloud MVP

### 9.1 MVP 范围

第一版不要做完整 Agent Marketplace，也不要同时覆盖所有垂直行业。MVP 只做：

> 托管 Mido Runner + Run Inspector + Evaluation + 一个 GitHub PR Agent 模板。

必须包含：

- 用户登录；
- org/project；
- API key；
- BYOK provider key；
- hosted `/run`、`/resume`、`/cancel`；
- durable event/thread/checkpoint store；
- run list；
- run detail / inspector；
- artifact export；
- local evaluator upload；
- usage metering；
- basic billing；
- GitHub connector beta；
- approval inbox beta。

明确不做：

- 复杂 workflow builder；
- marketplace；
- 全量企业权限；
- 所有模型 provider；
- 所有连接器；
- 复杂 mobile SDK 全平台；
- 自动化执行高风险外部动作。

### 9.2 MVP 用户路径

```text
访问官网
  ↓
GitHub 登录 / 邮箱登录
  ↓
创建 Project
  ↓
选择模型：BYOK OpenAI/DeepSeek/OpenAI-compatible
  ↓
复制 Mido Cloud API Key
  ↓
选择 Quickstart：Web / iOS / GitHub PR Agent
  ↓
运行第一条 hosted run
  ↓
Dashboard 看到 event timeline、tool call、trace、artifact
  ↓
开启 eval/report 或连接 GitHub
  ↓
产生持续使用和付费
```

### 9.3 MVP 价值证明

MVP 要证明三个核心价值：

1. **集成快**：用户 10 分钟内跑通第一个 resumable agent。
2. **可检查**：每次 run 都能看到模型、工具、暂停、恢复、错误、成本。
3. **能交付**：GitHub PR Agent 能从 issue/task 生成可 review 的 PR 或至少结构化 patch artifact。

## 10. 商业闭环设计

### 10.1 获客入口

| 渠道 | 内容 |
|---|---|
| OSS GitHub | Mido Core SDK、examples、local demo、eval CLI |
| 技术文章 | server-owned loop、client local tools、HITL、Agent eval、MCP 双边集成 |
| 模板项目 | Web local tools、iOS local tools、GitHub PR Agent、Browser QA Agent |
| 对比页 | vs LangChain、Vercel AI SDK、AG-UI-only、MCP-only、cloud-only agents |
| 社区 | MCP/AG-UI/AI agent communities、Hacker News、X、Reddit、GitHub Discussions |

关键策略：让开发者先因 SDK 和 demo 进来，再因 hosted runner / inspector / eval 付费。

### 10.2 激活路径

核心激活事件：

- 用户创建 project；
- 成功发起第一条 cloud run；
- 看到第一条 run trace；
- 第一次审批 `client_interactive` tool；
- 第一次生成 eval report；
- 第一次接入 GitHub/Slack/Linear connector。

产品要围绕这些事件优化，而不是先堆功能。

### 10.3 付费转化点

| 用户痛点 | 付费能力 |
|---|---|
| 本地 demo 不适合生产 | Hosted Runner、durable storage、SLA |
| 出错不知道原因 | Run Inspector、trace、artifact、support bundle |
| 每次改 prompt 都怕回归 | Eval suites、CI gates、baseline diff |
| 多人协作需要共享 | Team workspace、shared projects、RBAC |
| 需要真实业务工具 | GitHub/Slack/Linear connectors、OAuth vault |
| 企业担心安全 | SSO、audit、BYOK、retention、private deployment |

### 10.4 留存与扩张

留存来自三类“切换成本”：

1. **运行数据沉淀**：run history、trace、eval baseline、artifact。
2. **连接器配置**：OAuth、tool policy、approval workflow。
3. **团队流程嵌入**：CI gate、Slack approval、GitHub PR、Linear ticket。

扩张路径：

- 从个人 developer 到 team；
- 从一个 project 到多个 project；
- 从 observability 到 hosted runner；
- 从 BYOK 到托管模型路由；
- 从 basic connectors 到 enterprise governance；
- 从 public cloud 到 private deployment。

## 11. 12 周路线图

### Phase 0：定位与可销售包装（第 1-2 周）

目标：让 Mido 看起来像一个可以买/试的产品，而不是只有 SDK。

任务：

- 定义产品线：Mido Core、Mido Cloud、Mido Eval、Mido Connectors。
- 新增 landing page 文案与 pricing draft。
- 新增 hosted quickstart 文档。
- 从 `apps/web-demo` 提炼第一版 Run Inspector 设计。
- 明确免费/付费边界。
- 准备 3 个 template：Web Local Tools、iOS Local Tools、GitHub PR Agent。

验收：

- 用户能在 README/官网 30 秒内理解 Mido Cloud 卖什么。
- 有一个清晰 CTA：Start local / Try cloud / View demo。

### Phase 1：Mido Cloud Runtime MVP（第 3-6 周）

目标：跑通第一条生产级 hosted run。

任务：

- `apps/cloud-api`：auth、project、API key、run/resume/cancel。
- `packages/cloud-store`：Postgres/Redis backed Session/Thread/Event store。
- `packages/cloud-runner`：queue、worker、lease、heartbeat、timeout。
- `apps/cloud-dashboard`：project list、run list、run detail。
- Provider BYOK：DeepSeek / OpenAI-compatible / OpenAI Responses。
- Usage metering：run count、model calls、tool calls、event bytes。

验收：

- 多租户用户只能看到自己的 run。
- 生产 run 不依赖 in-memory checkpoint。
- run 可暂停、resume、cancel。
- dashboard 能展示事件流与最终状态。

### Phase 2：Inspector + Eval 产品化（第 7-8 周）

目标：形成第一个明确付费价值点。

任务：

- `packages/inspector-ui`：timeline、tool call、errors、trace summary。
- `@mido/evaluator` 增加 upload client。
- Cloud dashboard 增加 eval reports。
- GitHub Action：上传 artifact、对比 baseline。
- 默认 payload privacy：默认 hash，不上传原文。

验收：

- 用户能从 CI 看到 regression。
- 用户能在 dashboard 中比较两次 run。
- Run detail 能解释失败原因。

### Phase 3：Approval + Policy 商业化（第 9-10 周）

目标：让 Mido 在高风险工具场景中可信。

任务：

- standard permission events。
- approval inbox。
- tool risk UI。
- policy templates：read-only、balanced、strict、enterprise。
- Slack approval beta。
- per-run budget / per-tool limit。

验收：

- destructive tool 不能无审批执行。
- 审批记录可审计。
- 超预算 run 可解释停止。

### Phase 4：GitHub PR Agent 模板（第 11-12 周）

目标：形成可演示、可销售的端到端 Agent 应用。

任务：

- GitHub OAuth connector。
- repo clone/sandbox/branch lifecycle。
- workspace tools 接入 patch/diff。
- test command allowlist。
- PR creation。
- PR artifact：diff summary、test report、run trace。
- Linear/Slack 只做轻量触发或通知，不做完整连接器。

验收：

- 用户连接一个 repo 后，可以输入 issue/task，Mido 创建 branch/patch/PR。
- PR 附带测试输出和 trace 链接。
- 高风险命令或写操作有明确审批/策略。

## 12. 6 个月路线图

| 时间 | 目标 | 关键交付 |
|---|---|---|
| M1 | 可试用 Cloud MVP | hosted run、dashboard、BYOK、event store、basic billing |
| M2 | 可观测性付费 | eval dashboard、CI gate、artifact compare、inspector UI |
| M3 | 第一个垂直闭环 | GitHub PR Agent、GitHub connector、PR artifact |
| M4 | 团队协作 | org/team/RBAC、approval inbox、Slack approval、usage budget |
| M5 | 连接器扩展 | Linear、Jira、Vercel、Figma、Sentry beta |
| M6 | 企业化 | SSO、audit export、retention policy、private deployment、SLA |

## 13. 关键指标

### 13.1 产品激活指标

- Time to first cloud run：目标 < 10 分钟。
- Quickstart completion rate：目标 > 40%。
- First run success rate：目标 > 80%。
- First trace viewed rate：目标 > 70%。
- First eval report generated rate：目标 > 30%。

### 13.2 运行质量指标

- Resume success rate：目标 > 99%。
- Duplicate resume conflict rate：目标 < 0.1%。
- Worker lease conflict rate：目标 < 0.1%。
- Tool schema validation failure rate：持续监控。
- Provider error normalized coverage：目标 > 90%。
- p95 run event latency：目标 < 2s 到达 dashboard。

### 13.3 商业指标

- Free-to-paid conversion：目标 5%-10%。
- Weekly active projects。
- Runs per active project。
- Eval suites per team。
- Connector attach rate。
- Team expansion seats。
- Monthly recurring revenue。
- Gross margin by run。

### 13.4 安全与信任指标

- High-risk tool approval coverage：目标 100%。
- Secret redaction incidents：目标 0。
- Cross-tenant access incidents：目标 0。
- Audit log completeness：目标 100% for high-risk actions。
- Payload opt-in upload ratio：监控，不强推。

## 14. 风险与缓解方案

| 风险 | 影响 | 缓解 |
|---|---|---|
| 一开始做太泛的 Agent 平台 | 交付慢、定位模糊 | 先做 Hosted Runtime + Eval + GitHub PR Agent |
| 与 Devin/Roomote 正面竞争 | 获客成本高 | 强调 SDK/runtime/local tools/HITL/observability 差异 |
| 高风险工具误执行 | 信任崩塌 | 默认 strict policy、permission events、approval inbox、audit |
| 多租户隔离错误 | 严重安全事故 | 服务端解析 storageScope，禁止客户端传权威 tenant/user 字段 |
| 成本失控 | 毛利下降 | per-run budget、model routing、usage dashboard、rate limit |
| Provider 差异导致不稳定 | 用户体验差 | capability presets、preflight checks、adapter conformance |
| Secret 泄露到日志 | 合规风险 | secret vault、redaction、artifact payload 默认 hash |
| Demo 代码直接进生产 | 技术债 | 明确 `apps/web-demo` 与 `apps/cloud-*` 分离 |
| 工具生态难维护 | 支持成本高 | 优先 GitHub/Slack/Linear，其他通过 MCP/community |

## 15. 不建议做的事

1. 不要把完整 agent loop 移到客户端，这违背 Mido 当前架构边界。
2. 不要让客户端提交可信 `tenantId/userId/storageScope`。
3. 不要在没有 permission events 和 audit 前发布高风险托管工具。
4. 不要一开始做 marketplace。
5. 不要一开始支持所有 provider 和所有连接器。
6. 不要把 `apps/web-demo` 当 production dashboard 直接上线。
7. 不要只卖“又一个聊天机器人 SDK”，应强调 resumable agent runtime、local tools、HITL、eval。

## 16. 近期实施任务拆分

### P0：必须先做

| 编号 | 任务 | 影响范围 | 验收 |
|---|---|---|---|
| P0-1 | 产品线与官网定位 | docs/landing | 用户能理解 Mido Cloud 卖点 |
| P0-2 | `apps/cloud-api` 骨架 | cloud API | 登录后可创建 project/API key |
| P0-3 | 多租户 storageScope 绑定 | cloud API/server-sdk | 所有 run 绑定可信 org/project/user |
| P0-4 | Durable Session/Event/Thread store | cloud-store | 进程重启后 run/thread/event 不丢 |
| P0-5 | Hosted runner worker + lease | cloud-runner/server-sdk | 多 worker 不双执行 |
| P0-6 | Run list/detail dashboard | cloud-dashboard/inspector-ui | 可查看 run timeline |
| P0-7 | BYOK provider secrets | cloud API/security | provider key 不进入 event log |
| P0-8 | Usage metering | billing | 能按 run/model/tool/event 统计用量 |

### P1：形成付费价值

| 编号 | 任务 | 影响范围 | 验收 |
|---|---|---|---|
| P1-1 | Evaluator cloud upload | evaluator/cloud-api | CI 上传 artifact |
| P1-2 | Eval dashboard | dashboard | 可看 suite 和 regression |
| P1-3 | Permission events | protocol/server-sdk/client-web | dashboard 可展示 policy 决策 |
| P1-4 | Approval inbox | dashboard/client-web | 高风险 tool 可审批 |
| P1-5 | Basic billing | billing/dashboard | 超额限制/升级路径生效 |
| P1-6 | GitHub connector alpha | connectors-github | 可授权 repo 并读 issue/branch |

### P2：端到端闭环

| 编号 | 任务 | 影响范围 | 验收 |
|---|---|---|---|
| P2-1 | GitHub PR Agent template | templates/toolkit/connectors | 输入 issue 后产出 PR/patch |
| P2-2 | Test report artifact | evaluator/cloud-runner | PR 附测试结果 |
| P2-3 | Slack approval beta | connectors-slack | Slack 卡片审批 tool |
| P2-4 | Linear trigger beta | connectors-linear | Linear ticket 触发 run |
| P2-5 | Provider presets | server-sdk/docs | OpenAI/Anthropic/Gemini 等配置清晰 |

### P3：企业化

| 编号 | 任务 | 影响范围 | 验收 |
|---|---|---|---|
| P3-1 | SSO/OIDC/SAML | auth | 企业用户可 SSO |
| P3-2 | RBAC | cloud API/dashboard | 角色权限生效 |
| P3-3 | Audit export | cloud API/dashboard | 可导出高风险动作审计 |
| P3-4 | Retention policy | stores/dashboard | 可配置 trace/artifact 保留期 |
| P3-5 | Private deployment | infra/docs | 企业可私有化部署 |

## 17. 商业闭环最终形态

完整闭环如下：

```text
开源 SDK / 技术内容获客
  ↓
本地 demo 跑通 Mido Core
  ↓
用户需要生产部署、团队协作、可观测性
  ↓
注册 Mido Cloud
  ↓
创建 project + 接入 BYOK + 发起 hosted run
  ↓
Dashboard 查看 trace / approval / eval
  ↓
连接 GitHub/Slack/Linear，进入真实工作流
  ↓
产生持续 run、artifact、baseline、approval 数据
  ↓
按 seat + run + eval + connector + retention 付费
  ↓
企业因安全、审计、SSO、私有化扩容
```

这条闭环的关键不是让用户“聊天”，而是让用户把 Agent 放进真实产品和真实流程里，并持续依赖 Mido 的运行、审计、评估和连接器能力。

## 18. 下一次迭代建议

建议下次更新 Mido 项目时，优先创建以下设计文档或任务文件：

1. `docs/product/mido-cloud-positioning.md`：产品定位、用户画像、pricing draft。
2. `docs/architecture/cloud-runtime.md`：Mido Cloud API / runner / store / dashboard 架构。
3. `docs/security/multi-tenant-authz.md`：tenant、project、user、storageScope、API key 的权威边界。
4. `docs/security/permission-events.md`：permission event 协议和 UI 展示。
5. `docs/product/run-inspector.md`：Run Inspector 页面结构与数据模型。
6. `docs/product/eval-cloud.md`：Evaluator cloud upload、CI gate、dashboard。
7. `docs/templates/github-pr-agent.md`：GitHub PR Agent 的工具、流程、风险和验收。

如果只做一个最小闭环，优先顺序应是：

```text
cloud-api + durable store + hosted runner
  → run inspector
  → evaluator cloud upload
  → billing
  → GitHub PR Agent template
```

## 19. 最终建议

Mido 快速商业化的核心不是“继续堆更多 SDK 功能”，而是把已有底座包装成可购买的产品能力：

- 用 **Mido Core OSS** 获客；
- 用 **Mido Cloud Runtime** 承接生产需求；
- 用 **Run Inspector + Eval** 提供第一付费价值；
- 用 **GitHub PR Agent / Local Tools Agent 模板** 展示端到端产出；
- 用 **connectors、approval、audit、SSO** 完成团队和企业扩张。

只要第一版能稳定做到“10 分钟接入、每次 run 可检查、失败可定位、GitHub PR Agent 能产出可 review 结果”，Mido 就可以从 SDK 项目进入商业化验证阶段。
