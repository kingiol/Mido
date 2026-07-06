# User Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable server-side user memory vertical slice for Mido.

**Architecture:** Add a `UserMemoryStore` contract and `InMemoryUserMemoryStore` in `@mido-agent/server-sdk`, with deterministic text search and content-hash deduplication. Integrate retrieval into `createAgentRunner()` by composing a memory block into the existing server-owned system prompt at run start; leave Redis, embedding providers, and post-run extraction for later phases.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, `@mido-agent/protocol-core`, `@mido-agent/server-sdk`.

---

### Task 1: Memory Store Contract And Tests

**Files:**
- Create: `tests/server-user-memory.test.ts`
- Create: `packages/server-sdk/src/user-memory.ts`
- Modify: `packages/server-sdk/src/index.ts`

- [ ] **Step 1: Write failing store tests**

```ts
const store = new InMemoryUserMemoryStore();
const userKey = store.deriveUserKey({ segments: ['tenant', 'alpha'] });
const first = await store.write(userKey, {
  type: 'semantic',
  text: 'The user deploys FastAPI services on Railway.',
  confidence: 0.9,
  importance: 0.8
});
const duplicate = await store.write(userKey, {
  type: 'semantic',
  text: 'The user deploys FastAPI services on Railway.',
  confidence: 0.7
});
expect(duplicate.id).toBe(first.id);
expect(await store.search({ userKey, query: 'Railway deployment', limit: 1 })).toMatchObject([
  { id: first.id, type: 'semantic', score: expect.any(Number) }
]);
```

- [ ] **Step 2: Run store tests to verify RED**

Run: `pnpm exec vitest run tests/server-user-memory.test.ts`

Expected: FAIL because `InMemoryUserMemoryStore` is not exported yet.

- [ ] **Step 3: Implement minimal store**

```ts
export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly entriesByUserKey = new Map<string, Map<string, UserMemoryEntry>>();
  deriveUserKey(scope: StorageScope): string;
  search(input: UserMemorySearchInput): Promise<UserMemorySearchResult[]>;
  read(userKey: string, id: string): Promise<UserMemoryEntry | undefined>;
  write(userKey: string, input: UserMemoryWriteInput): Promise<UserMemoryEntry>;
  delete(userKey: string, id: string): Promise<boolean>;
  deleteAllForUser(userKey: string): Promise<number>;
}
```

- [ ] **Step 4: Run store tests to verify GREEN**

Run: `pnpm exec vitest run tests/server-user-memory.test.ts`

Expected: PASS for store behavior.

### Task 2: Runner Prompt Injection

**Files:**
- Modify: `tests/server-user-memory.test.ts`
- Modify: `packages/server-sdk/src/runner.ts`
- Modify: `packages/server-sdk/src/user-memory.ts`

- [ ] **Step 1: Write failing runner injection test**

```ts
const store = new InMemoryUserMemoryStore();
const scope = { segments: ['tenant', 'alpha'] };
await store.write(store.deriveUserKey(scope), {
  type: 'semantic',
  text: 'The user prefers Python 3.12 for backend services.',
  confidence: 0.95,
  importance: 0.9
});
const runner = createAgentRunner({
  modelAdapter: adapter,
  sessionStore: new InMemorySessionStore(),
  systemPrompt: 'Base instruction.',
  userMemoryStore: store
});
await collect(runner.run(createRunRequest('Write a backend deployment script'), { storageScope: scope }));
expect(systemText).toContain('Base instruction.');
expect(systemText).toContain('## User Memory');
expect(systemText).toContain('Python 3.12');
```

- [ ] **Step 2: Run injection test to verify RED**

Run: `pnpm exec vitest run tests/server-user-memory.test.ts`

Expected: FAIL because runner options do not accept or inject `userMemoryStore`.

- [ ] **Step 3: Implement prompt context builder and runner wiring**

```ts
const messages = await applySystemPromptPolicy(
  requestMessages,
  { runId, threadId, request, tools },
  composeSystemPromptProvider(systemPrompt, options.skillRegistry, {
    userMemoryStore: options.userMemoryStore,
    storageScope,
    requestMessages,
    limit: options.memorySearchLimit
  })
);
```

- [ ] **Step 4: Run injection tests to verify GREEN**

Run: `pnpm exec vitest run tests/server-user-memory.test.ts`

Expected: PASS for prompt injection and empty-memory no-op behavior.

### Task 3: Verification And Docs

**Files:**
- Modify: `docs/plans/README.md`
- Modify: `docs/plans/user-memory-design.md`
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [ ] **Step 1: Update docs with MVP status**

Add `user-memory-design.md` to the active plans README and record that Phase 1 started with the in-memory/text-search slice.

- [ ] **Step 2: Run targeted and package checks**

Run:

```bash
pnpm exec vitest run tests/server-user-memory.test.ts tests/server-sdk.test.ts
pnpm lint
pnpm --filter @mido-agent/server-sdk build
```

Expected: all commands exit 0.
