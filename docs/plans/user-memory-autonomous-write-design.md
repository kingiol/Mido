# 用户 Memory 自主写入设计说明

> 作为 [User Memory Design](./user-memory-design.md) 的补充说明，本文记录“自动写入 memory”的设计讨论、边界和落地顺序。

**目标：** 让系统能够在合适的时机自动沉淀稳定的用户偏好、事实和纠正信息，同时避免把临时上下文、误判内容或敏感信息直接写入长期记忆。

**核心结论：** 不让模型直接操作存储；采用 `candidate extraction -> policy decision -> write/update` 的三段式流程。`userMemoryKey` 必须由服务端显式提供，不能从通用 `storageScope` 反推用户身份。

---

## 一、问题定义

当前系统已经可以读取并注入用户 memory，但还没有自动写入的完整闭环。自动写入的核心难点不在“能不能写”，而在于以下四件事：

1. 写什么：哪些内容值得长期保存
2. 什么时候写：run 结束、工具调用后，还是用户显式确认后
3. 写到哪：哪个 `userKey`、哪个类型、哪个状态
4. 写错了怎么办：冲突、误判、过期、删除

如果把“自动写入”直接做成模型直写数据库，会非常容易把临时上下文、猜测内容和跨用户 scope 混进长期记忆。

---

## 二、推荐架构

```text
对话 / 工具结果 / 用户纠正
    ↓
MemoryCandidate 提取
    ↓
MemoryPolicy 裁决
    ↓
MemoryWriter 执行
    ↓
UserMemoryStore
```

### 2.1 三个职责

| 组件 | 职责 | 不做什么 |
|---|---|---|
| `MemoryCandidateExtractor` | 从消息、工具结果、摘要里提取候选记忆 | 不直接落库 |
| `MemoryPolicy` | 判断候选是否值得保存、是否需要人工确认 | 不解析原始对话 |
| `MemoryWriter` | 负责写入、更新、supersede、删除 | 不自己决定语义价值 |

### 2.2 推荐状态机

```text
candidate -> pending -> active
candidate -> rejected
active -> superseded
active -> expired
```

`pending` 适合高风险或低置信度信息，`active` 适合长期稳定信息。

---

## 三、什么可以自动写

优先级从高到低：

1. 用户明确说出的稳定偏好
2. 用户明确确认的长期事实
3. 用户纠正旧记忆
4. 多次重复出现的稳定约束
5. 线程结束时的情景摘要

不建议自动写入：

- 闲聊和寒暄
- 一次性任务状态
- 低置信度推断
- 明显可能变化的临时信息
- 原始 PII，除非经过脱敏和额外保护

---

## 四、什么时候写

推荐的触发点不是单一的，而是多源触发：

| 触发源 | 说明 | 适合的写入类型 |
|---|---|---|
| `memory_write` tool | 模型显式调用 | semantic / episodic |
| run 结束后提取 | 从最近消息提候选 | episodic -> semantic 候选 |
| 工具结果 | 例如部署、配置、选型结果 | semantic |
| 用户纠正 | “我已经迁到 Vercel 了” | supersede / replace |
| 用户显式要求 | “记住这个” | 高优先级 active |

当前代码仍然只支持显式写入；自动触发的部分是下一阶段设计。

---

## 五、什么时候更新

更新规则建议如下：

1. 同一 `userKey + type + contentHash` 重复出现时，合并而不是新建
2. 新内容与旧内容冲突时，旧条目标记 `superseded`
3. 用户明确否认旧事实时，优先让旧条目失效
4. 记忆被多次命中时，可提升 `importance` 或 `confidence`
5. 过期信息进入 `expired`，但保留审计痕迹

---

## 六、userKey 约束

自动写入必须使用显式 `userMemoryKey`，不能把通用 `storageScope` 当成用户身份的等价物。

原因很直接：

- `storageScope` 可能只是 workspace、tenant 或匿名会话
- 不同 scope 不一定等于不同用户
- 自动写入一旦跨错边界，记忆会污染别的用户

因此，推荐在接入方服务端显式提供：

```ts
userMemoryKey: (context) => `user:${req.auth.userId}`
```

或在需要更细粒度隔离时提供更具体的键。

---

## 七、安全与回滚

### 7.1 高风险条目

以下内容建议默认进入 `pending` 或需要额外确认：

- 邮箱、电话、地址
- 支付、账号、密钥类信息
- 容易误判的身份信息
- 依赖上下文推断出的事实

### 7.2 回滚能力

任何自动写入都应该保留来源信息：

- `sourceRunId`
- `sourceThreadId`
- `reason`
- `confidence`

这样当用户纠正记忆时，系统可以快速定位并替换。

---

## 八、落地顺序

建议分三阶段：

1. **Phase 1**：显式 `memory_write` + 显式 `userMemoryKey`
2. **Phase 2**：run 结束后做候选提取，但先进入 `pending`
3. **Phase 3**：对低风险、高置信度记忆做自动 `active` 写入

---

## 九、待确认问题

1. `pending` 是否需要客户端 UI 参与确认
2. episodic 到 semantic 的自动巩固频率
3. 哪些敏感字段必须始终走脱敏流程
4. 自动写入失败时是否要退回到工具日志或单独队列
