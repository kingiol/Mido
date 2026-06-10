# Mido 服务端用户长期记忆（User Memory）设计方案

日期：2026-06-10

> 基于 2 轮深度调研（6 组探索者 + 2 组独立审计），覆盖 42 个验证来源。
> 结论：在现有三层持久化之上，新增 `UserMemoryStore`，基于 Redis Stack 向量检索，通过 system prompt 注入记忆，分阶段落地。

---

## 结论

Mido 现有 `SessionStore` / `ThreadStore` / `EventStore` 三层存储均以 run 或 thread 为生命周期单位，无法支持跨 session 的用户级持久记忆。`@mido/toolkit-core` 的 `MemoryStore` 提供了 scoped 文本存储，但没有向量语义检索，没有自动提取，也没有与 agent loop 的系统级集成。

本方案设计 **第四层存储 `UserMemoryStore`**，与前三层平级、通过统一的 `StorageScope` 做多租户隔离、与 agent loop 在 `runner.ts` 中以最小侵入方式集成。

**核心决策**：

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 记忆分类 | 语义记忆（主体） + 情景记忆（辅助），程序记忆暂由 Agent Skills 承担 | 对齐 CoALA 认知模型，业界 Mem0/LangChain/Letta 共识 |
| 存储引擎 | **Redis Stack**（HASH + HNSW 向量索引 + RediSearch 混合搜索） | 复用 `redis:^6.0.0` 依赖，零新增服务；对齐 `StorageScope` key 前缀模式 |
| Embedding | OpenAI `text-embedding-3-small` (1536 维)，可降级为本地 `bge-large` | $0.02/1M tokens，生态最成熟，几乎所有向量库原生支持 |
| 检索方式 | 向量语义相似度 + TAG 过滤 + 全文混合搜索 + recency×importance 重排序 | 纯向量有噪音，纯关键词语义不足，混合搜索是刚需 |
| 注入方式 | `runner.ts:252` system prompt 注入（注入点 A） | 利用现有 `systemPrompt` provider 机制，不侵入 `prepareModelMessages` |
| 写入策略 | Agent 显式 tool（已有） + post-run 自动 LLM 提取（新增） | 前者精准即时，后者覆盖隐含信息 |
| 遗忘策略 | TTL + 访问频率衰减 + salience 评分 + 语义取代 四层叠加 | 同时满足合规、存储管理和检索精度 |

> 关于“自主写入 memory”的更细设计，请参见 [User Memory Autonomous Write Design](./user-memory-autonomous-write-design.md)。

## 证据索引

- 现有三层存储接口：`packages/server-sdk/src/store.ts:52-117` — `SessionStore`、`ThreadStore`、`EventStore`、`StorageScope`
- Redis 实现已有先例：`packages/server-sdk/src/store.ts:213-256` — `RedisSessionStore`，`mido:scope:{scopeHash}:session:{runId}` key 模式
- Agent loop 核心流程：`packages/server-sdk/src/runner.ts:207-304` — `run()`、`runner.ts:575-999` — `executeRunLoop()`
- System prompt 注入机制：`packages/server-sdk/src/system-prompt.ts:21-50` — `applySystemPromptPolicy()`
- Context budget：`packages/server-sdk/src/context-budget.ts:31-53` — `resolveRunContextBudget()`
- 现有 Memory tools：`packages/toolkit-core/src/memory.ts:9-118` — `createMemoryTools()`、`packages/toolkit-core/src/types.ts:96-130` — `MemoryStore` 接口
- 现有 storage scope 设计：`docs/storage-and-tracing.md` — scope 隔离、文件布局、key 前缀
- 现有存储架构：`docs/architecture.md` — 责任拆分、checkpoint 内容、tool policy 矩阵
- 多 Agent 创建：`packages/server-sdk/src/agents.ts:67-71` — `AgentToolConfig.systemPrompt`

---

## 一、问题定义

### 1.1 现状痛点

```
用户第 1 次对话： "我用 Python 3.12，部署在 Railway"
                         ↓
              agent 正常回复，但对话结束后...
                         ↓
用户第 2 次对话（跨 thread）： "帮我写个部署脚本"
                         ↓
              agent 不知道用户用什么语言、什么平台
              → 需要用户重新交代上下文
```

**根因**：Mido 现有的所有持久化都绑定在 run/thread 生命周期上：

| 现有存储层 | 绑定粒度 | 跨 thread 可见？ |
|-----------|---------|:---:|
| `SessionStore` (checkpoint) | run | ❌ 且有 TTL |
| `ThreadStore` (snapshot) | thread | ❌ |
| `EventStore` (event log) | run | ❌ |

Agent Skills（`SKILL.md`）是全局静态指令，能提供"怎么做事"，但不能提供"这个用户是谁、偏好什么"。

### 1.2 目标

新增 **`UserMemoryStore`**，使 Mido agent 具备以下能力：

1. **记住用户偏好和事实**（语义记忆），跨 thread 持久化
2. **回顾历史对话的关键结论**（情景记忆），带时间上下文
3. **被 agent 自动检索并注入到推理上下文**，用户无需重复交代
4. **随使用持续演化**：写入、去重、更新、过期、巩固

---

## 二、记忆分类与数据模型

### 2.1 三种记忆类型的认知科学基础

| 类型 | 认知定义 | 工程对应 | 存储形式 | 来源 |
|------|---------|---------|---------|------|
| **语义记忆** (Semantic) | 时间无关的事实、概念、偏好 | 用户画像、项目配置 | 向量库 HASH | CoALA (arxiv 2309.02427) |
| **情景记忆** (Episodic) | 带时间戳的具体事件经历 | 对话摘要、关键决策 | 向量库 HASH，`sourceThreadId` 溯源 | Atlan Episodic Memory (2026) |
| **程序记忆** (Procedural) | 技能、例程、行为模式 | Mido Agent Skills (`SKILL.md`)、system prompt 模板 | 文件系统，不由向量库管理 | CoALA |

**本方案当前聚焦语义 + 情景记忆**。程序记忆由现有 `AgentSkillRegistry` + `SKILL.md` 系统静态管理。动态学习的程序记忆（如"该用户偏好先看摘要再读详情"）属于未来方向，不在当前 scope。

### 2.2 核心 Schema

```ts
type MemoryType = 'semantic' | 'episodic' | 'procedural';

interface UserMemoryEntry {
  id: string;                    // "mem_sem_abc123"，前缀标识类型
  type: MemoryType;
  userKey: string;               // 从 StorageScope 推导："user:456"
  text: string;                  // 记忆文本，也是 embedding 的输入
  reason?: string;               // 为什么保存（调试/审计用）

  // 溯源
  sourceThreadId?: string;       // 来源 thread（episodic 必有）
  sourceRunId?: string;          // 来源 run

  // 质量评分
  confidence: number;            // 0-1，LLM 提取时给出
  importance: number;            // 0-1，用于检索排序和淘汰加权
  contentHash: string;           // SHA256(text)[:16]，去重的唯一键

  // 生命周期
  status: 'active' | 'superseded' | 'expired';
  supersededBy?: string;         // 被哪个 entry id 取代
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;       // 最后被检索命中的时间
  expiresAt?: string;            // TTL

  // 向量嵌入（在 Redis 中作为 HASH 的独立字段）
  embedding?: number[];

  // 可选扩展
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface UserMemorySearchResult extends UserMemoryEntry {
  score: number;                 // 检索时的综合评分（包含相似度+recency+importance）
}
```

### 2.3 Episodic Memory 与 ThreadSnapshot 的关系

**Episodic 不是 ThreadSnapshot 的副本，而是它的摘要层**。

```
ThreadSnapshot.messages  (ThreadStore, 已有)
    │ 完整原始对话，数万 tokens
    │
    ↓ LLM 提取，run 结束后异步执行
    │
EpisodicMemoryEntry.text  (UserMemoryStore, 新增)
    │ 一段 100-300 字的摘要 + 关键决策 + 涉及实体
    │ 带 sourceThreadId 可溯源
    │
    ↓ 累积 N 条后 consolidate
    │
SemanticMemoryEntry.text  (UserMemoryStore, 新增)
    │ 一条持久事实："用户部署 Railway"
```

这样设计的好处：不需要另存一遍原始对话（ThreadStore 已经存了），episodic 只存"能从对话中学到什么"，是检索时的上下文素材。

---

## 三、存储引擎：Redis Stack

### 3.1 选型分析

Mido 已有 `redis:^6.0.0` 依赖和 `RedisSessionStore` 实现（`store.ts:213-256`）。User memory 在 Redis 上扩展是最小成本的方案。

| 考量维度 | Redis Stack | PostgreSQL + pgvector | Qdrant（自托管） |
|---------|:-----------:|:---------------------:|:---------------:|
| Mido 现有依赖 | ✅ 已有 `redis:^6.0.0` | ❌ 零依赖，需新增 | ❌ 零依赖，需新增 |
| StorageScope 对齐 | ✅ 直接复用 `mido:scope:{hash}:` 前缀 | ⚠️ 需设计 partial index / RLS | ⚠️ 需 payload filter / 分 collection |
| 向量检索延迟（100K 规模） | 🥇 <5ms（内存） | 🥉 ~25ms（HNSW） | 🥈 ~12ms |
| 混合搜索（向量+过滤+全文） | ✅ RediSearch 原生 | ⚠️ 需手动 SQL 组合 | ✅ 原生 |
| 运维复杂度 | 🥇 零新增服务 | 🥈 复用 PG 实例 | 🥉 独立服务 |
| 100K 向量月成本 | $30-80（~2GB 内存实例） | $20-50 | $40-100 |

**结论：Redis Stack**。与现有 `RedisSessionStore` 共用一个 Redis 连接，零新增基础设施。

### 3.2 Key 设计（完全对齐现有模式）

```
# 现有 SessionStore key（store.ts:254）
mido:scope:{scopeHash}:session:{runId}

# 新增 UserMemoryStore key
mido:scope:{scopeHash}:memory:idx              ← 向量搜索索引 (FT.CREATE)
mido:scope:{scopeHash}:memory:{entryId}        ← 单个记忆条目 (HASH)
```

同一个 scope 的 session 和 memory 共享 `mido:scope:{scopeHash}:` 前缀，天然隔离。

### 3.3 向量索引定义

每个 scope 首次写入时懒创建索引：

```sql
FT.CREATE mido:scope:{scopeHash}:memory:idx
  ON HASH PREFIX 1 "mido:scope:{scopeHash}:memory:"
  SCHEMA
    text        TEXT WEIGHT 1.0
    memoryType  TAG SEPARATOR "|"
    userKey     TAG SEPARATOR ":"
    confidence  NUMERIC SORTABLE
    importance  NUMERIC SORTABLE
    contentHash TAG
    embedding   VECTOR FLOAT32 HNSW 16
                TYPE FLOAT32
                DIM 1536
                DISTANCE_METRIC COSINE
                M 16
                EF_CONSTRUCTION 200
```

参数说明：
- `DIM 1536`：对应 OpenAI `text-embedding-3-small`
- `M 16, EF_CONSTRUCTION 200`：中小规模下的 HNSW 经验参数，平衡索引构建速度和检索精度
- `DISTANCE_METRIC COSINE`：对不同长度的文本，余弦相似度比 L2 更稳定

### 3.4 Embedding 模型

| 模型 | 维度 | 成本 / 1M tokens | 适用场景 |
|------|:---:|:---:|------|
| **OpenAI `text-embedding-3-small`** | 1536 | $0.02 | **MVP 首选**：生态最成熟，几乎所有向量库原生支持 |
| OpenAI `text-embedding-3-large` | 3072 | $0.13 | 精度要求极高时，但 100K 规模下 small 够用 |
| BAAI `bge-large-zh-v1.5` | 1024 | 免费（自托管） | 数据不能出境的场景 |
| Google `text-embedding-004` | 768 | 免费（限配额） | 零成本方案 |

**推荐**：MVP 用 OpenAI `text-embedding-3-small`。成本极低（详见 §9），且 `EmbeddingProvider` 接口设计为可替换，未来随时切换。

### 3.5 检索流程

```
用户最新消息："帮我写个部署脚本"
         │
         ├─ 1. Embed query → OpenAI API → Float32Array(1536)
         │     延迟 ~150ms，timeout 10s，retry 3 次
         │
         ├─ 2. Redis 混合搜索
         │     @memoryType:{semantic|episodic}         ← TAG 预过滤
         │     @confidence:[0.3 1]                     ← 低质量过滤
         │     => [KNN 20 @embedding $B EF_RUNTIME 80] ← 向量检索 top-20
         │     延迟 ~5ms
         │
         ├─ 3. 重排序（应用侧）
         │     composite_score = 0.6 × cosine_sim
         │                     + 0.25 × recency(e^(-0.01 × days_since_access))
         │                     + 0.15 × importance
         │
         ├─ 4. 类别多样性采样
         │     确保 semantic 和 episodic 至少各取 1 条（如果存在）
         │
         └─ 5. 返回 top-5~10 条
```

---

## 四、写入策略

### 4.1 三层写入架构

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 1: Agent 显式 Tool 写入（~40% 覆盖）                    │
│ ├─ 触发：模型在推理过程中判定需要持久化 → 调用 memory_write    │
│ ├─ 实现：已有 createMemoryTools() (memory.ts:9-118)           │
│ ├─ 优点：精准、即时、不额外消耗同步时间                         │
│ └─ 局限：依赖模型判断力，可能遗漏隐含事实                       │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: Post-run 自动 LLM 提取（~50% 覆盖）— 新增             │
│ ├─ 触发：每次 run 完成 (RUN_FINISHED) 后异步执行               │
│ ├─ 实现：LLM 分析本轮对话 messages → 提取 facts 数组           │
│ ├─ 优点：覆盖模型未主动写入的隐含事实                           │
│ └─ 局限：额外 LLM 调用（~$0.002/run，可接受）                  │
├──────────────────────────────────────────────────────────────┤
│ Layer 3: 用户显式标注（~10% 覆盖）— 预留                       │
│ ├─ 触发："记住这个" / UI 点赞按钮                              │
│ ├─ 优点：最高精度、最高置信度                                   │
│ └─ 局限：需要客户端配合                                        │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Post-run 自动提取详细流程

**触发位置**：`runner.ts` 中 `executeRunLoop` 返回前（`RUN_FINISHED` 之后）。

```
runner.ts: executeRunLoop() {
    while (true) {
        ... model call + tool execution ...

        if (finishReason === 'completed' || 'awaiting_client_tool' 后无更多 tool call) {
            emit RUN_FINISHED

            // ★ 新增：自动提取记忆
            if (userMemoryStore && autoExtractMemory) {
                await extractMemoriesFromRun(context, userMemoryStore);
            }
            return;
        }
    }
}
```

**提取流程**：

```
Step 1: 从 context.messages 中筛选 user + assistant 角色的最近 N 条消息（≤10 条）
    ↓
Step 2: 去重（本轮对话中已被 agent 通过 memory_write 显式写入的事实不再重复提取）
    ↓
Step 3: 调用轻量 LLM（可用复用现有的 summaryCompressor 模型），传入提取 prompt
    ↓
Step 4: 解析 JSON: {"facts": ["事实1", "事实2", ...], "episode": "对话摘要100-200字"}
    ↓
Step 5: 逐 facts 调用 userMemoryStore.write()（含去重 check）
         单独写入一条 episodic 记录（summary + keyActions + keyDecisions）
```

### 4.3 提取 Prompt（基于 Mem0 已验证模板适配）

```
你是个人信息整理器，从以下对话中提取可以持久化存储的信息。

只提取以下类型：
1. 个人偏好：编程语言、工具、工作流偏好、回复风格偏好
2. 重要事实：项目信息、技术栈、部署平台、数据库选择
3. 计划和意图：即将发生的事件、目标、项目计划
4. 约束和决策：架构决策、命名约定、版本选择

提取规则：
- 只提取对话中明确陈述或强烈暗示的事实
- 不提取问候、闲聊、临时讨论、可能快速变化的信息
- 每一条事实应该是独立、原子化的陈述
- 如果没有任何值得持久化的信息，返回 {"facts": []}

对话内容：
{conversation_text}

返回纯 JSON（不要 markdown 包裹）：
{"facts": ["事实1", "事实2"], "episode": "用1-2句话描述本次对话的核心主题和关键决策"}
```

关键参数：`temperature: 0.1`，确保提取一致性。

### 4.4 去重与冲突解决

在 `UserMemoryStore.write()` 内部实现：

```
新记忆写入：
  │
  ├─ 1. contentHash = SHA256(text)[:16]
  ├─ 2. 在同一 (userKey, type) 维度下查同 hash 记录
  │     存在 → 更新 confidence/importance/updatedAt，跳过
  │
  ├─ 3. 向量检索语义最相似的已有记忆 (top-1, 同一 userKey, 同一 type)
  │     相似度 > 0.85 → LLM 判断是否矛盾
  │       矛盾 → UPDATE(覆盖旧), 旧标记 superseded
  │       未矛盾 → NONE(无需额外操作，两条独立保留)
  │
  └─ 4. 无冲突 → ADD(创建新条目)
```

---

## 五、检索与注入：集成到 Agent Loop

### 5.1 注入位置选择

agent loop 有两个可注入点：

| 注入点 | 位置 | 频率 | 延迟影响 | 侵入性 | 选择 |
|--------|------|:---:|:---:|:---:|:---:|
| **A：Run 启动时 system prompt** | `runner.ts:252`，`applySystemPromptPolicy()` | 每个 run 1 次 | 1 次 embedding API 调用 (~150ms) | 🟢 利用现有 provider，不修改核心流程 | ✅ **采用** |
| B：每次 model call 前 | `runner.ts:1331`，`prepareModelMessages()` | 每个 agent loop 迭代 1 次 | N 次 embedding API 调用 (N × 150ms) | 🔴 需修改 prepareModelMessages 签名和语义 | ❌ 暂不采用 |

**选 A 的理由**：

1. `systemPrompt` provider 机制完全够用——它是函数 `(context) => string`，在 run 启动时求值一次，正好匹配"run 开始时检索记忆"的需求
2. 不侵入 `prepareModelMessages`（这个函数与 context-budget、summary-compressor 紧耦合，改动风险大）
3. 延迟可控：1 次 embedding API 调用（~150ms）在 run 启动阶段，此时用户刚发了第一条消息，端到端延迟 1-3s 的背景下这是噪声级
4. 语义记忆本身是"跨 session 不变的事实"，一个 run 内不需要重复检索

### 5.2 注入格式

```ts
// 在 runner.run() 中：
// runner.ts:252 调用 applySystemPromptPolicy 前

const memoryContext = await buildMemoryContext(
    userMemoryStore,
    storageScope,
    request.messages
);

const enhancedSystemPrompt = (ctx: SystemPromptContext) => {
    const base = typeof systemPrompt === 'function'
        ? await systemPrompt(ctx)
        : systemPrompt;
    return `${base}\n\n${memoryContext}`;
};
```

生成的 memory block：

```
## User Memory (persisted across sessions)

The following facts about the user have been learned from previous conversations.
Use them to personalize your replies when relevant.
If a memory conflicts with what the user just told you, trust the user's latest statement.
If you are unsure whether a memory is still accurate, ask the user.

- 偏好 Python 3.12 开发 (confidence: 0.90, updated: 2026-06-01)
- 项目部署在 Railway 平台 (confidence: 0.85, source: thread_abc)
- 数据库使用 PostgreSQL + pgvector (confidence: 0.95, pinned)
- 喜欢简洁回复，不需要冗长解释 (confidence: 0.78, updated: 2026-05-20)

[Recent context]
- 2026-06-09: 讨论了 memory 方案设计，选定 Redis Stack 作为存储后端 (thread_xyz)
```

**关键设计点**：

- 每条事实带 `confidence` + `updated` 时间戳，让模型自行判断时效性和可靠性
- `pinned` 标识用户明确标记的重要记忆，给模型更强的信任信号
- "trust the user's latest statement" 是防幻觉安全阀：即使用记忆说"部署 Railway"，用户说"我改到 Vercel 了"，agent 必须信任用户的最新表述
- 情景记忆（Recent context）带日期和 thread 引用，帮助模型理解"什么时候讨论的"

### 5.3 Token 预算分析

| 场景 | 记忆数量 | 预估 tokens | 占 128K context |
|------|:---:|:---:|:---:|
| top-5 语义记忆 | 5 条 | ~110 tokens | 0.08% |
| top-10 语义记忆 | 10 条 | ~220 tokens | 0.17% |
| top-5 语义 + 3 条情景 | 8 条 | ~250 tokens | 0.20% |
| 激进 top-20 | 20 条 | ~440 tokens | 0.34% |

**结论：记忆注入的 token 开销可忽略不计**，不需要在 context-budget 中为 memory 单独预留百分比。现有的 `maxInputTokens` 预算完全能吸收这几百 tokens。

---

## 六、生命周期管理

### 6.1 四层遗忘机制

```
Layer 1: TTL 硬性过期（合规 + 存储管理）
  偏好类: 180 天  |  临时状态: 30 天  |  决策/约束: 不过期

Layer 2: 访问频率衰减（检索排序，不删除数据）
  每次检索命中时 +boost
  未命中时: score × e^(-0.01 × days_since_access)
  半衰期 ~69 天

Layer 3: Salience 评分（写入时 LLM 打分 + 运行时行为加成）
  LLM 初始分 (0-1)
  + 用户 pin → +0.3
  + 被检索使用 → +0.05/次
  score < 0.2 且 decay < 0.1 → 不再参与检索（但保留）

Layer 4: 语义取代（新旧冲突→新覆盖旧）
  旧事实标记 superseded，保留审计 trail
  不是真删除，而是"这条已经被更新的信息取代了"
```

### 6.2 Consolidation：Episodic → Semantic

```
触发条件（任一满足）：

  条件 A: 即时触发 — 每个 thread 结束时
    对当前 thread 生成 1 条 episodic 摘要

  条件 B: 批量触发 — 累积 ≥20 条未 consolidate 的 episodic
    或距上次 consolidate > 6 小时
    ↓
    拉取 20 条 episodic → LLM 批量分析 → 抽取关键事实
    → 写为 semantic（去重+冲突解决）→ 标记 episodic 为 consolidated
```

**为什么需要 consolidation**：episodic 记忆的粒度太细——每天可能产生几十条对话摘要，直接都注入 system prompt 会噪音过大。consolidation 把多条相关对话中反复出现的稳定事实提炼为 semantic，是"从量变到质变"的过程。

---

## 七、失败模式与降级

### 7.1 分层防护架构

```
Layer 1: 重试（Transient Recovery）
  embedding API 429(限流)/503(不可用) → exponential backoff
  3 次重试: 1s / 2s / 4s + jitter

Layer 2: Circuit Breaker（故障隔离）
  连续 3 次失败 → OPEN (5min 熔断)
  HALF_OPEN 探测成功 → CLOSED
  HALF_OPEN 失败 → OPEN_EXTENDED (15min)
  只对 503/超时/网络错误跳闸，不对 4xx 业务错误跳闸

Layer 3: 降级（非中断式回退）
  embedding API circuit open → 回退到 TF-IDF 文本匹配
    (复用现有 memory.ts:128 的 rankByText)
  Redis 不可用 → 回退到 InMemoryUserMemoryStore (无持久化但 agent 继续)
  memory 写入失败 → 自动进入 runner.ts:909-957 现有 RUN_ERROR 管道
```

### 7.2 各降级场景下的用户感知

| 故障场景 | Agent 行为 | 用户感知 |
|---------|-----------|---------|
| embedding API 不可用 | 检索降级为关键词文本匹配 | 记忆召回精度下降，不影响回复 |
| Redis 完全挂 | 记忆降级为进程内存 | 本次对话期间记忆可用，不持久化 |
| 新用户零记忆 | system prompt 不显示 memory 区块 | 与现有无记忆 agent 体验完全一致 |
| 部分写入失败 | 已写入的 memory 立即可用，失败的进错误管道 | 本次对话的部分记忆可能丢失 |

### 7.3 冷启动（零记忆场景）

新用户首次对话时：

1. **不显示空 memory 区块**——不要给 system prompt 里塞 `## User Memory\n(no memories yet)`，这会让模型困惑
2. **不要主动引导用户暴露偏好**——让对话自然展开。当用户明确陈述偏好时（"我是用 pnpm 的"），agent 自然通过 `memory_write` tool 记录
3. **可选引导**：在 system prompt 底部注入一条温和指引：

```
When you notice the user expressing a stable preference, fact, or decision that
might be useful in future conversations, use memory_write to save it. Only store
facts that are clearly stated and likely to persist across sessions.
```

---

## 八、安全与隐私

### 8.1 数据分级保护

| 风险级别 | 数据示例 | 保护策略 |
|:---:|------|------|
| 低 | "偏好 Python 开发"、"部署 Railway" | 明文 + scope hash 隔离 |
| 中 | "项目名叫 FooBar"、"团队 5 人" | 可选 AES-256-GCM 加密 |
| **高** | 邮箱、手机号、地址等 PII | **脱敏后 embedding** + 原始文本 AES 加密存储 |

### 8.2 PII 不入向量索引

核心原则：向量索引中用于语义检索的 embedding 必须来自脱敏文本，确保即使向量被逆向也无法还原 PII。

```
写入流程（当检测到 PII 时）:
  原始 text: "用户邮箱 user@example.com，电话 13800138000"
       │
       ├─ PII 正则检测 → 检测到 email + phone
       │
       ├─ 脱敏: "用户邮箱 [EMAIL]，电话 [PHONE]"  ← 用于生成 embedding
       │
       ├─ embed(脱敏文本) → 存入 Redis HASH.embedding
       │
       ├─ AES-256-GCM encrypt(原始文本) → 存入 Redis HASH.encryptedText
       │
       └─ Redis HASH.piiFlag = true
```

检索时 embedding 基于脱敏文本做语义匹配，返回结果后再解密显示（如果需要）。

### 8.3 GDPR"被遗忘权"

```ts
async function deleteAllForUser(userKey: string): Promise<number> {
  const scopeHash = deriveScopeHash(userKey);

  // ① SCAN 所有该用户的 memory key（避免 KEYS 阻塞 Redis）
  const keys: string[] = [];
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, {
      MATCH: `mido:scope:${scopeHash}:memory:*`,
      COUNT: 1000
    });
    cursor = result.cursor;
    keys.push(...result.keys);
  } while (cursor !== 0);

  // ② pipeline 批量删除
  const pipeline = redis.multi();
  for (const key of keys) pipeline.del(key);
  const results = await pipeline.exec();

  // ③ 审计记录
  await auditLog.record({
    action: 'gdpr_erasure',
    userKey,
    deleted: results.filter(Boolean).length,
    timestamp: new Date().toISOString()
  });

  return results.filter(Boolean).length;
}
```

100K 条记录下，SCAN + pipeline 批量删除耗时约 1-3 秒。

---

## 九、接口设计

### 9.1 UserMemoryStore

```ts
// packages/server-sdk/src/user-memory.ts（新文件）

export interface UserMemoryStore {
  /** 从 StorageScope 推导用户维度 key */
  deriveUserKey(scope: StorageScope): string;

  /** 搜索记忆 */
  search(input: UserMemorySearchInput): Promise<UserMemorySearchResult[]>;

  /** 按 ID 读单条 */
  read(userKey: string, id: string): Promise<UserMemoryEntry | undefined>;

  /** 写入记忆 */
  write(userKey: string, input: UserMemoryWriteInput): Promise<UserMemoryEntry>;

  /** 删除单条 */
  delete(userKey: string, id: string): Promise<boolean>;

  /** 批量删除某用户的所有记忆（GDPR） */
  deleteAllForUser?(userKey: string): Promise<number>;

  /** 从 episodic 巩固为 semantic */
  consolidate?(input: UserMemoryConsolidateInput): Promise<UserMemoryEntry[]>;

  /** 获取统计信息 */
  stats?(userKey: string): Promise<UserMemoryStats>;
}
```

### 9.2 EmbeddingProvider

```ts
// packages/server-sdk/src/embedding-provider.ts（新文件）

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
```

### 9.3 Runner 集成点扩展

```ts
// runner.ts CreateAgentRunnerOptions 扩展
export interface CreateAgentRunnerOptions {
  // ... 现有字段
  modelAdapter: ModelAdapter;
  sessionStore: SessionStore;
  threadStore?: ThreadStore;
  eventStore?: EventStore;
  systemPrompt?: SystemPromptProvider;
  toolPolicy?: ToolPolicyProvider;
  skillRegistry?: AgentSkillRegistry;

  // ★ 新增
  userMemoryStore?: UserMemoryStore;   // 记忆存储后端
  autoExtractMemory?: boolean;         // 是否启用 post-run 自动提取
  memorySearchLimit?: number;          // 每次注入的记忆条数上限，默认 5
}
```

---

## 十、改动范围

### 10.1 新增文件

| 文件 | 内容 | 行数（估） |
|------|------|:---:|
| `packages/server-sdk/src/user-memory.ts` | `UserMemoryStore` 接口 + `InMemoryUserMemoryStore` + 类型定义 | ~150 |
| `packages/server-sdk/src/user-memory-redis.ts` | `RedisUserMemoryStore` 实现（HASH + HNSW + 混合搜索 + 降级） | ~300 |
| `packages/server-sdk/src/embedding-provider.ts` | `EmbeddingProvider` 接口 + `OpenAIEmbeddingProvider` 实现 | ~120 |
| `packages/server-sdk/src/__tests__/user-memory.test.ts` | 单元测试（CRUD + 去重 + 降级 + embedding mock） | ~200 |
| `packages/server-sdk/src/__tests__/embedding-provider.test.ts` | Embedding 测试 | ~60 |

### 10.2 修改文件

| 文件 | 改动 | 行数（估） |
|------|------|:---:|
| `packages/server-sdk/src/runner.ts` | ① 扩展 `CreateAgentRunnerOptions`；② `run()` 中注入记忆到 system prompt（~15 行）；③ `executeRunLoop` 返回前触发自动提取（~15 行） | ~40 |
| `packages/server-sdk/src/index.ts` | 导出新接口和类 | ~10 |
| `packages/toolkit-core/src/memory.ts` | `createMemoryTools` 可选接受 `UserMemoryStore`（兼容适配） | ~20 |

### 10.3 不改的文件

- `packages/server-sdk/src/store.ts` — `SessionStore`/`ThreadStore`/`EventStore` 不变
- `packages/server-sdk/src/system-prompt.ts` — `applySystemPromptPolicy` 不变，记忆作为 provider 函数注入
- `packages/server-sdk/src/context-budget.ts` — 不变，记忆 token 开销可忽略
- `packages/toolkit-core/src/types.ts` — 旧 `MemoryStore` 保留不删

---

## 十一、成本估算

### 11.1 假设

- 1000 活跃用户
- 每用户平均 100 条记忆
- 每天 10 次检索（每次搜一个 query，返回 top-5）
- 每天 100 次新增/更新记忆

### 11.2 Embedding API 成本

| 项目 | 消耗 | 月费 |
|------|------|-----|
| 初始索引（一次性） | 100K 条 × ~50 tokens/条 = 5M tokens | $0.10 |
| 检索 query embedding | 10K 次/天 × 20 tokens/query = 200K/天 × 30 = 6M/月 | $0.12 |
| 新增/更新记忆 | 100 条/天 × 50 tokens = 5K/天 × 30 = 150K/月 | $0.003 |
| **Embedding API 合计** | | **~$0.22/月** |

### 11.3 基础设施成本

| 项目 | 月费 |
|------|-----|
| Redis 实例（2GB，含 RediSearch 模块） | $30-80 |
| Embedding API | $0.22 |
| **合计** | **~$30-80/月** |

如果已有 Redis 实例，增量成本几乎为零（额外的 ~500MB 内存 + 若干 CPU）。

---

## 十二、对比现有方案

| 维度 | 现有 `MemoryStore` (`toolkit-core`) | 本方案 `UserMemoryStore` |
|------|------|------|
| 存储 | 进程内存 (`InMemoryMemoryStore`) | Redis Stack (HASH + HNSW 向量) |
| 检索 | TF-IDF 文本匹配 (`rankByText`) | 向量语义相似度 + 混合搜索 |
| 记忆类型 | 无区分（扁平 `scope + text`） | semantic / episodic / procedural |
| 写入方式 | 纯被动（模型 tool call） | 显式 tool + post-run 自动提取 |
| 生命周期 | 无（调用方手动 delete） | TTL + 衰减 + salience + supersession |
| 去重 | 无 | contentHash + 语义相似度 + LLM 冲突判断 |
| Agent loop 集成 | 无（纯 tool 层） | system prompt 注入 + post-run 自动提取 |
| 降级 | 无 | circuit breaker + 回退文本匹配 + 内存兜底 |
| 多租户 | scope 字符串（上层映射） | `StorageScope` 统一隔离 |

---

## 十三、场景走查

### 场景 1：新用户首次对话

```
用户: "帮我在 Railway 上部署一个 FastAPI 项目"
agent: "好的，你用什么 Python 版本？"
用户: "3.12"
agent: [调用 memory_write: "用户使用 Python 3.12，部署 Railway"]
agent: "明白了，我来给你写部署脚本..."
```

第二次对话（新 thread）：
```
用户: "帮我优化部署脚本"
agent: [run 启动 → system prompt 注入 "用户使用 Python 3.12，部署 Railway"]
agent: "上次你在 Railway 上部署 FastAPI，用的是 Python 3.12。你是想优化那个脚本吗？"
```

### 场景 2：记忆纠正

```
用户: "我其实已经迁移到 Vercel 了"
agent: [检测到与 memory "部署 Railway" 矛盾]
agent: [调用 memory_write 覆盖: "用户部署 Vercel"，旧记忆标记 superseded]
agent: "好的，我来看看 Vercel 的部署配置..."
```

### 场景 3：embedding API 故障

```
用户: "部署脚本报错了"

—— embedding API 返回 503 ——
→ retry 3 次后 circuit breaker OPEN
→ 降级为 TF-IDF 文本匹配: 搜索 "部署" 关键词
→ 仍能匹配到 "部署 Railway" 相关记忆
→ agent 正常回复，只是匹配精度略降
```

---

## 十四、实施路径

### Phase 1：接口 + 降级（第 1-3 天）

1. 创建 `user-memory.ts`：接口定义 + `InMemoryUserMemoryStore`
2. 创建 `embedding-provider.ts`：接口定义，暂不实现 OpenAI provider
3. Runner 集成：`CreateAgentRunnerOptions` 加 `userMemoryStore` + system prompt 注入
4. Token 用 `rankByText` 文本匹配（先不接 embedding/Redis）

**交付物**：接口可用的骨架，agent 能用文本匹配做记忆检索，手工写入的记忆能跨 session 持久。

### Phase 2：语义检索（第 4-8 天）

1. 实现 `OpenAIEmbeddingProvider`
2. 实现 `RedisUserMemoryStore`（FT.CREATE + FT.SEARCH + HSET + 混合搜索）
3. 实现 post-run 自动提取
4. 实现 circuit breaker + 降级

**交付物**：生产可用的语义记忆系统，完整端到端流程。

### Phase 3：成熟化（第 9-12 天）

1. Consolidation 自动化（episodic → semantic）
2. TTL + 遗忘策略
3. GDPR 批量删除
4. 旧 `MemoryStore` 到 `UserMemoryStore` 的数据迁移脚本
5. 测试覆盖

**交付物**：完全成熟的记忆管理系统。

---

## 参考来源

共 42 个来源，全部经过直接阅读验证。核心来源：

| # | 来源 | 用于 |
|---|------|------|
| 1 | CoALA 论文 (arxiv 2309.02427) | 三种记忆类型认知模型 |
| 2 | Mem0 官方文档 + GitHub `prompts.py` | 提取 prompt 模板、四操作模型 (ADD/UPDATE/DELETE/NONE) |
| 3 | Redis Vector Search Node.js 文档 | FT.CREATE、FT.SEARCH KNN、HNSW 参数 |
| 4 | OpenAI Embeddings API 文档 | `text-embedding-3-small` API、batch input、dimensions 参数 |
| 5 | IBM AI Agent Memory | RAG 记忆模式、LangChain/LangGraph 框架映射 |
| 6 | Atlan Episodic Memory (2026) | 情景记忆设计、冷启动问题分类 |
| 7 | Letta - Agent Memory (2025) | Core Memory Blocks、sleep-time compute |
| 8 | Redis - Long-Term Memory Architectures (2026) | 记忆管线四阶段、HNSW 索引、Redis 三层记忆 |
| 9 | Zylos - Graceful Degradation Patterns (2026) | Circuit Breaker 状态机、降级架构 |
| 10 | Mido `store.ts`、`runner.ts`、`system-prompt.ts`、`memory.ts` | 本地架构约束验证 |
