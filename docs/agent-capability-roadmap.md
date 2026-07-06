# Agent Capability Backlog

> Current roadmap source of truth: [Roadmap](./roadmap.md).

This document keeps the detailed capability notes behind the roadmap. Treat it
as a backlog and decision record, not as the top-level priority index.

这份文档记录当前 Mido Agent SDK 里值得补强的能力，并把它们整理成后续可以逐项推进的 backlog。

Mido 现在最有价值的部分不是内置一个完整任务型 agent，而是提供清晰稳定的 SDK 边界：服务端掌控 agent loop，客户端暴露本地工具，运行过程可以通过中立协议暂停和恢复。下面的优化都应该保留这个方向。

## 当前基础

- agent loop 运行在服务端，由 `@mido-agent/server-sdk` 负责。
- 客户端通过 `@mido-agent/client-core` 注册本地工具。
- 工具执行策略分成 `server`、`client_auto` 和 `client_interactive`。
- 服务端已经支持 opt-in 的 `toolPolicy`，工具可以声明轻量 `metadata.policy`。
- 服务端已经支持 Agent Skills：索引 `SKILL.md` frontmatter，按需加载被选中的 skill 正文，支持 `references/` 和 `assets/`；`scripts/` 只有显式配置 sandbox 后才能执行。
- 客户端工具调用会创建 checkpoint，并通过 `RunResumeRequest` 恢复运行。
- MCP 可以作为服务端和客户端的工具来源。
- web demo 展示了 SSE events、本地工具状态和交互式审批。
- JSON Schemas 和 conformance docs 已经能支撑 native client 接入。

## 推荐优先级

### 1. 权限和风险策略层（低打扰首版已完成）

当前工具策略很清楚，但对真实产品来说还太粗。SDK 已经加入低打扰首版策略层：默认不启用，工具上的 `metadata.policy` 只是描述信息；应用显式传入 `toolPolicy` 后，runner 才会在工具暴露、执行和 resume 前做判断。

为什么重要：

- 删除、写入、支付、发消息这类破坏性操作需要比普通交互工具更强的保护。
- 有风险的不只是客户端工具，服务端工具同样可能造成真实影响。
- 产品侧需要在本地工具、MCP 工具和未来工具包之间保持一致的权限行为。

首版已经完成：

- `createAgentRunner({ toolPolicy })` 是 opt-in，不配置时旧行为不变。
- 工具可以用 `metadata.policy` 声明 `risk`、`effects` 和 `scopes`。
- 新增 `createDefaultToolPolicy()`，balanced 模式默认允许未声明 metadata 的工具。
- 默认策略会隐藏并拦截 destructive 的非交互工具。
- destructive 的 `client_interactive` 工具继续可见，复用现有用户确认流程。
- 策略 provider 可以自定义，接入方可以根据用户、租户、角色、run metadata 做判断。

剩余范围：

- 发出明确的 permission events，让 UI 能直接展示阻止或确认原因。
- 增加强确认协议，比如二次验证、管理员审批或带上下文的确认。
- 把策略结果纳入更完整的审计模型，而不只作为 tool error 进入事件流。
- 给客户端本地自动工具补充对称的轻量 policy hook。
- 为 MCP 工具包和未来内置工具包统一补齐风险 metadata。

首版验收状态：

- 破坏性操作不能绕过策略直接执行。
- 应用显式开启默认策略后，破坏性非交互工具会被隐藏并在执行前拦截。
- 现有 `server`、`client_auto`、`client_interactive` 行为在未配置 `toolPolicy` 时保持向后兼容。
- 需要用户确认的高风险动作优先使用 `client_interactive`，避免调用者学习新的确认协议。

### 2. 运行取消、重试和恢复（取消与 demo 重试首版已完成）

协议里已经有 `cancelled`。SDK 现在已经暴露 run 级取消能力，web demo 也提供了停止当前运行和重试上一条失败/取消消息的 UI。后续还需要继续补齐更细粒度的工具重试、checkpoint 指定恢复和断线后自动恢复。

为什么重要：

- 长模型流和慢工具需要用户可见的停止路径。
- 浏览器刷新和 SSE 断线不应该让一次运行直接丢失。
- 工具失败后应该能恢复，而不是重开整段对话。

可能范围：

- 在服务端和客户端 API 增加 `cancelRun(runId)`。
- 在 model adapters 和工具执行里支持 abort signals。
- 增加重试上一次 run、重试失败工具、从 checkpoint 重试的 API。
- 定义 retry-safe 的事件顺序。
- 文档化客户端断线后的行为。

验收标准：

- 正在运行的 stream 可以被干净取消。
- 失败或断线的 run 在 checkpoint 有效时可以恢复。
- 重复 retry 在可行范围内保持确定性和幂等性。

### 3. 持久线程和事件存储（首版已完成）

当前 checkpoint 主要服务于等待客户端工具结果。SDK 应该把短期 checkpoint 存储和长期对话、事件存储区分开。

为什么重要：

- 产品接入需要跨 session 的对话历史。
- 调试需要完整事件轨迹，而不只是当前 client snapshot。
- native client 和 web client 都应该能稳定 replay 一次 run。

可能范围：

- 增加 `ThreadStore` 接口保存对话消息。
- 增加 `EventStore` 接口保存 `CoreEvent` 日志。
- 让 `SessionStore` 专注于可恢复的 run checkpoint。
- 根据需要提供 memory 和 Redis 实现。
- 增加从事件重建 client snapshot 的 replay helpers。

验收标准：

- 进程重启后可以重新加载 thread。
- 可以从已存事件检查一次 run。
- checkpoint TTL 可以保持较短，同时不删除长期历史。

### 4. Run Inspector 和标准 tracing（SDK 数据层增强已完成）

web demo 现在有 Event Timeline，但 tracing 应该成为 SDK 层能力。接入方需要看清模型调用、工具调用、延迟、错误、重试和状态变化。

为什么重要：

- 没有 tracing，工具密集型 agent 很难被信任。
- provider error 和 tool error 需要不同的调试路径。
- 多工具、多模型调用之后，延迟和成本都会变成关键问题。

可能范围：

- 给 run、model、tool events 增加标准 trace metadata。
- 在可用时记录 model latency、tool latency、timeout、provider request id 和 usage。
- 提供 inspector data model；web demo 提供基础 Run Inspector UI。
- 支持把 run trace 导出成 JSONL，便于调试和支持。

验收标准：

- 开发者不加自定义日志也能看懂一次 run 发生了什么。
- 工具失败、provider 失败和 model adapter 失败容易区分。
- 成功和失败的 run 都能导出 trace。

剩余增强：

- 标准化 retry count。
- 在更多 provider adapter 里补齐 usage 和 provider request id。
- 后续如果需要，再把 demo inspector 提炼成可复用 component。

### 5. Provider 能力抽象（首版已完成）

内部协议是 provider-neutral。首版已经在 `@mido-agent/server-sdk` 增加 `ModelAdapterCapabilities`，并让 runner 在模型调用前检查明确不支持的组合。现有 adapter 覆盖 DeepSeek、Vercel AI stream 归一化、OpenAI-compatible Chat Completions 和 OpenAI Responses。

需要覆盖的 provider 类型不止三类。更准确的分层是：

- 官方原生 API：OpenAI、Anthropic、Gemini、DeepSeek、Mistral、Cohere 等一手 provider。它们通常有自己的消息结构、reasoning 字段、工具调用格式、错误码和 usage 字段。
- OpenAI-compatible API：DeepSeek、OpenRouter、Together、Groq、Perplexity、Ollama、vLLM、LocalAI 等常见实现或网关。兼容只代表 transport 和部分 payload 形状相近，不代表能力完全等价。
- Anthropic-compatible API：主要用于 Claude 生态的兼容层、代理层或托管入口。它的 tool use、thinking、content block 和 OpenAI-compatible 不是同一种抽象。
- 云厂商托管统一 API：Azure OpenAI、AWS Bedrock Converse、Google Vertex AI、Azure AI Foundry 等。它们把模型接入统一到云平台接口，但认证、区域、模型 id、quota、guardrail、request id 和错误语义由云平台决定。
- 模型路由和网关：OpenRouter、LiteLLM Proxy、Vercel AI Gateway、Helicone Gateway 等。它们的价值是 fallback、路由、日志、成本控制和统一 key，但模型真实能力仍来自下游 provider。
- 自托管和本地推理运行时：Ollama、vLLM、llama.cpp server、Hugging Face TGI、SGLang 等。它们适合私有部署和低成本实验，但 tool calling、JSON schema、usage、并发和 streaming 质量差异很大。
- 框架级 adapter：Vercel AI SDK、LangChain、LlamaIndex 等。它们不是模型 provider，但可以作为 Mido adapter 的上游。Mido 需要把它们视为 adapter source，而不是内部协议来源。

为什么重要：

- 不同 provider 在 reasoning、tool call streaming、parallel tool calls、structured output、usage reporting 和 retry semantics 上都不一样。
- SDK 用户应该能提前知道某个模型不支持哪些能力。
- adapter 特有行为不应该泄漏到应用代码里。
- 同名能力也可能只有部分支持，比如 OpenAI-compatible API 支持 tool calls，但不支持 tool args streaming 或严格 JSON schema。

核心判断：

- Provider 分类只决定接入路径，不决定运行行为。
- SDK 需要读取的是能力 descriptor，而不是 provider 名字。
- 能力 descriptor 应该挂在 `ModelAdapter` 上，并允许按 model 覆盖。
- `metadata` 继续表达一次调用的观测结果，`capabilities` 表达调用前可判断的能力边界。

Provider capability descriptor 首版：

- `provider`: provider id，比如 `deepseek`、`openai`、`anthropic`、`bedrock`、`ollama`。
- `adapterKind`: `native`、`openai_compatible`、`anthropic_compatible`、`cloud_gateway`、`router_gateway`、`local_runtime`、`framework_adapter`。
- `models`: model pattern 或明确 model id 列表。
- `streaming`: 是否支持文本流、reasoning 流、tool args 流。
- `tools`: 是否支持工具调用、并行工具调用、严格 JSON schema、工具结果 resume。
- `reasoning`: 是否支持 reasoning 输出、是否要求把 reasoning 内容写回 assistant message、tool resume 时是否必须保留。
- `structuredOutput`: 是否支持 JSON mode、schema-constrained output、response format。
- `usage`: token 字段支持度，是否支持 streaming usage，字段是否可信。
- `finishReasons`: 原始 finish reason 到 Mido 标准 finish reason 的映射。
- `errors`: rate limit、auth、quota、content filter、overloaded、timeout 等错误是否可归一化，并标记是否 retryable。
- `transport`: auth 方式、base URL、request id header、区域或 deployment 约束。
- `limits`: context window、max output tokens、tool 数量、tool name 约束、request body 限制。
- `knownGaps`: adapter 已知缺口，用于文档、运行时警告和测试豁免。

Mido 标准能力命名：

- `text.streaming`
- `reasoning.streaming`
- `reasoning.resumePreservation`
- `tools.calling`
- `tools.argumentStreaming`
- `tools.parallelCalls`
- `tools.strictSchema`
- `tools.resumeWithResults`
- `structuredOutput.jsonMode`
- `structuredOutput.schema`
- `usage.inputTokens`
- `usage.outputTokens`
- `usage.totalTokens`
- `usage.streamingFinal`
- `finishReason.normalized`
- `errors.retryableNormalized`
- `transport.abortSignal`
- `transport.requestId`

执行阶段：

1. 已在 `server-sdk` 增加 `ModelAdapterCapabilities` 类型，并把 `ModelAdapter` 扩展为可选 `capabilities` 字段。现有 adapter 不需要破坏性改造。
2. 已给 DeepSeek V4 adapter 按 `thinking` 模式声明不同能力。普通 V4 模式支持 tool resume；开启 `thinking` 时继续标记为 `tools.resumeWithResults: false` 和 `reasoning.resumePreservation: required_but_missing`。
3. 已给 Vercel AI adapter 增加可传入的 capabilities。因为它只是上游 SDK 的 stream 形状，默认能力由接入方传入。
4. 已在 run 开始时做 capability checks。明确不支持工具调用、工具结果 resume、工具数量、工具名长度、reasoning resume preservation 时会提前返回清晰错误。
5. 已在 DeepSeek、OpenAI-compatible 和 OpenAI Responses adapter 中保留 `rawFinishReason`，并输出 Mido 可识别的 `finishReason`。
6. 已增加 focused tests，覆盖 capability preflight、DeepSeek 能力差异、Vercel AI capability 透传、OpenAI-compatible request/stream，以及 OpenAI Responses request/stream。
7. 后续仍需要补 adapter 作者文档，并把 capability tests 提炼成更通用的 conformance helper。

验收标准：

- model adapter 可以声明自己支持什么。
- 不支持的组合会尽早报出清晰错误。
- 支持 reasoning 的模型能在工具调用之间保留必要上下文。
- OpenAI-compatible 和 Anthropic-compatible adapter 不会被默认当成完整 OpenAI 或 Anthropic 能力。
- DeepSeek adapter 至少能准确区分 V4 普通模式和 V4 thinking 模式的 tool resume 能力。
- Vercel AI adapter 可以接收接入方传入的能力声明，并把未知能力保持为 unknown，而不是误报支持。
- conformance tests 可以让新 adapter 证明自己支持哪些能力，也能明确跳过不支持项。

剩余增强：

- 增加 Anthropic native adapter。
- 增加 cloud gateway adapter 示例，比如 Bedrock Converse 或 Vertex AI。
- 把 focused tests 抽成 adapter conformance test kit。
- 给 `ModelAdapterCapabilities` 增加文档页和更多真实 provider presets。

### 6. MCP 连接生命周期管理

状态：已完成第一版。

MCP 工具现在可以从远端 Streamable HTTP server 注册，也可以使用 managed connection 包一层连接生命周期。第一版保持 MCP 是工具来源，不把 MCP 升级成新的 runtime。

已完成：

- `@mido-agent/mcp-core` 增加 `createManagedMcpConnection` 和 `createManagedMcpHttpConnection`。
- managed connection 暴露 `getStatus`、`subscribe`、`healthCheck`、`reconnect`、`close`、`terminateSession` 和 `refreshTools`。
- tool call 或 list tools 发现连接失效时，会标记 `degraded`，重连一次，再重试当前操作。
- `refreshTools()` 返回 added、updated、removed、unchanged diff。
- client SDK 增加 `refreshMcpClientTools`，可以更新和移除已注册的 MCP client tools。
- server SDK 增加 `refreshMcpServerTools`，返回映射后的 definitions，由调用方决定何时应用，避免运行中的 runner registry 被隐式热替换。
- web demo 的浏览器侧和服务端 MCP 注册都已切到 managed helper。

保留给后续：

- 文档化浏览器 CORS 和代理预期。
- 如果产品需要，可以再加后台 health polling、自动工具刷新策略和服务端 registry 热替换能力。

验收标准：

- MCP 连接失效能在工具执行前或执行中被发现：已覆盖。
- 应用可以展示连接状态：已覆盖。
- 刷新工具列表不会产生重复注册：已覆盖。

### 7. 常用能力工具包

控制面更稳之后，Mido 可以增加可选工具包。这些工具包应该留在 core loop 外面，让 SDK 继续保持 provider-neutral 和 app-neutral。

核心首版：

- File and workspace tools：提供文件枚举、全文搜索、文件读取、受控写入或 patch、命令执行等基础能力。这是 agent 处理本地任务的最小执行面。
- Search and retrieval tools：提供 web search、URL fetch、文档读取、本地资料索引和查询等能力。这解决 agent 获取外部事实和项目资料的问题。
- Browser automation tools：提供打开页面、点击、输入、截图、提取页面文本等能力。这让 agent 可以验证网页、操作 SaaS 流程和检查 UI 状态。
- Scoped memory tools：提供按 scope 读取、写入和删除长期记忆的能力。首版只保存用户偏好、项目约定和可复用事实，不替代 thread store。

建议工具清单：

File and workspace tools：

- `workspace_list`：列出允许 root 下的目录和文件，支持 depth、glob 和 ignore rules。
- `workspace_search`：搜索文件名或文件内容，默认限制结果数量和单条 preview 长度。
- `workspace_read_file`：读取文件全文或指定行范围，限制最大字节数。
- `workspace_stat`：读取文件大小、类型、mtime 和权限等 metadata。
- `workspace_apply_patch`：按结构化 patch 修改已有文件，默认走写入权限检查。
- `workspace_write_file`：创建新文件或覆盖文件，覆盖已有文件时需要更高风险标记。
- `workspace_run_command`：在指定 cwd 执行命令，必须支持 timeout、output limit、env allowlist 和 command allowlist。

Search and retrieval tools：

- `search_web`：执行 web search，返回标题、URL、摘要和来源时间，不直接把网页正文塞进上下文。
- `fetch_url`：抓取 URL 内容，限制 content type、redirect、大小、超时和是否允许内网地址。
- `read_document`：把 PDF、HTML、Markdown、DOCX 等资料解析成文本块和基础 metadata。
- `retrieval_index`：把指定资料写入应用提供的索引，必须带 namespace。
- `retrieval_query`：在指定 namespace 里检索相关资料，返回片段、来源和 score。
- `retrieval_delete`：删除索引里的指定资料，作为写操作纳入 policy。

Browser automation tools：

- `browser_open`：打开 URL 或切换已有 page，限制可访问 origin。
- `browser_snapshot`：获取当前页面的可访问性树、标题、URL 和关键文本。
- `browser_click`：点击可定位元素，高风险页面或跨 origin 操作需要确认。
- `browser_type`：向输入框写入文本，涉及密码、支付、消息发送时必须拦截或确认。
- `browser_wait`：等待 navigation、selector、network idle 或固定时间。
- `browser_screenshot`：截取当前页面或元素截图，用于 UI 验证和调试。
- `browser_extract`：按 selector 或自然语言目标提取结构化数据，默认只读。

Scoped memory tools：

- `memory_list_scopes`：列出当前用户或项目可用的 memory scope。
- `memory_search`：在指定 scope 里检索长期记忆，返回来源、时间和 confidence。
- `memory_read`：读取指定 memory entry。
- `memory_write`：写入长期记忆，必须带 scope、reason 和 source run id。
- `memory_delete`：删除指定 memory entry，必须纳入审计。

首版默认策略：

- 只读工具默认是 `server` 或 `client_auto`，具体取决于资源在服务端还是客户端。
- 写文件、删 memory、写索引、执行命令、浏览器输入和点击都需要明确 policy metadata。
- `workspace_run_command`、`browser_type`、`browser_click` 这类工具应该优先设计成 `client_interactive` 或由接入方显式放行。
- 所有工具都应该输出结构化结果，避免只返回不可解析的纯文本日志。

延后：

- Database tools。
- Notification and messaging tools。
- Payment or external action tools。

为什么应该放后面：

- 常用工具会显著放大风险。
- 权限、取消、tracing、持久化应该先于高影响工具完成。
- 工具包应该复用同一套 policy、trace 和 checkpoint 流程，而不是各自发明行为。
- Database tools 容易把 SDK 拖进业务语义，首版最多适合提供只读查询示例。

验收标准：

- 工具包是可选的。
- 每个工具包都声明风险 metadata。
- 每个工具包都能接入同一套 policy、trace 和 checkpoint 流程。
- 高风险工具默认需要明确 scope，并能被 `toolPolicy` 隐藏或拦截。

### 8. Agent Skills（sandboxed scripts 已完成）

Agent Skills 现在作为服务端 instruction/resource package 存在，不新增运行时，也不把它们变成第四种 tool execution policy。默认只加载 `SKILL.md`、`references/` 和 `assets/`；当应用显式配置 `scriptSandbox` 后，可以通过 `skill_run_script` server tool 执行 `scripts/`。

为什么重要：

- Skill 的核心价值是告诉 agent 怎么完成一类任务，而不是直接执行代码。
- 渐进加载可以降低上下文成本：先读 frontmatter，相关时再读正文，资源文件按需读取。
- `scripts/` 必须走 sandbox 和 tool policy，不能直接在宿主进程执行。

已完成：

- `loadAgentSkillsFromDirectory` 扫描本地 skill 目录，索引 `SKILL.md` frontmatter。
- `createAgentSkillRegistry` 提供 list、select、build prompt、list/read resource 能力。
- runner 增加 `skillRegistry` 选项，把被选中的 skill instructions 拼进 server-owned system prompt。
- 支持 `metadata.enabledSkills` 作为客户端偏好，但最终选择在服务端完成。
- 增加 `maxLoadedSkills`、`maxSkillBytes` 和 `maxPromptBytes` 控制上下文成本。
- 增加 `skill.indexed`、`skill.selected`、`skill.loaded` 和 `skill.resource_read` 审计事件。
- 默认拒绝 `scripts/` 目录，防止下载的 Claude-style skill 意外获得代码执行能力。
- 配置 `scriptSandbox` 后，`scripts/` 会进入 manifest digest，并可通过 registry 执行。
- 新增 `createAgentSkillScriptTool`，把脚本执行暴露成 `server` tool。
- 新增 `createDockerAgentSkillSandbox` 和 `buildDockerAgentSkillSandboxCommand`。
- Docker sandbox 默认关闭网络，不注入宿主环境变量，只挂载只读 skill 目录和 tmpfs 工作目录，并限制 CPU、内存、pids、输出和超时。
- 脚本 tool 声明 `metadata.policy`：`risk: high`、`effects: ['execute']`、`scopes: ['skill:script:run']`。
- 增加 `skill.script_started`、`skill.script_completed` 和 `skill.script_failed` 审计事件。

保留给后续：

- 增加非 Docker sandbox provider，比如 Firecracker、nsjail、gVisor 或远端隔离 worker。
- 增加标准 permission event，让高风险 server tool 能走用户确认，而不是只能依赖自定义 policy。

## 建议执行顺序

1. 权限和风险策略层低打扰首版。已完成。
2. 运行取消、重试和恢复。取消与 demo 重试首版已完成，剩余工具级重试和断线恢复。
3. 持久线程和事件存储。首版已完成。
4. Run Inspector 和标准 tracing。SDK 数据层已完成，剩余 inspector 复用组件。
5. Provider 能力抽象。首版已完成，剩余更多 provider 分类细化。
6. 可选常用能力工具包。

这个顺序会先把 SDK 的运行底座做稳，再扩展 agent 能做的具体事情。

## 下一阶段非目标

- 不把完整 agent loop 移到客户端。
- 不把 MCP 做成主要 app transport。
- 不把某个 provider 的形状硬编码成内部协议。
- 不在强确认、审计和工具包风险 metadata 完善前发布高风险内置工具。
- 不把 demo UI 当成 SDK 唯一的 inspector 方案。

## 当前代码参考点

- `packages/protocol-core/src/index.ts`：协议类型、工具执行策略、run events 和 schemas。
- `packages/server-sdk/src/runner.ts`：服务端 loop、checkpoint、server tools 和 client tool suspension。
- `packages/server-sdk/src/policy.ts`：opt-in 工具风险策略、默认策略和 policy metadata 解析。
- `packages/client-core/src/index.ts`：客户端 runtime、本地工具注册、自动执行、交互审批和 resume flow。
- `packages/server-sdk/src/store.ts`：checkpoint stores。
- `packages/mcp-core/src/index.ts`：共享 MCP 连接和工具映射 helpers。
- `packages/server-sdk/src/adapters/deepseek.ts`：真实 provider adapter，以及 reasoning/tool-call normalization。
- `packages/toolkit-core/src/index.ts`：可选常用能力工具包，包含 workspace、search/retrieval、browser adapter 和 scoped memory tools。
- `apps/web-demo/src/App.tsx`：demo client tools、审批 UI、event timeline 和工具状态展示。
