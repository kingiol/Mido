# Evaluator Reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first P0 evaluation and reproducibility loop for Mido.

**Architecture:** Add `@mido/evaluator` as a pure SDK package that consumes `CoreEvent[]`, reuses `buildRunTrace(events)`, and emits metrics, artifacts, suite reports, and deterministic grading results. Add local JSONL eval cases plus a CLI runner that uses fixture events so smoke/safety checks run without external API keys.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, `@mido/protocol-core`.

---

### Task 1: Package API And Tests

**Files:**
- Create: `tests/evaluator.test.ts`
- Create: `packages/evaluator/src/index.ts`
- Create: `packages/evaluator/src/types.ts`
- Create: `packages/evaluator/src/metrics.ts`
- Create: `packages/evaluator/src/artifact.ts`
- Create: `packages/evaluator/src/report.ts`

- [x] Write failing tests for `calculateRunMetrics`, `aggregateEvalSuite`, `buildRunArtifact`, `hashMessages`, `hashToolManifest`, and `renderEvalReport`.
- [x] Run `pnpm test -- tests/evaluator.test.ts` and confirm expected missing-module failure.
- [x] Implement the package APIs.
- [x] Run `pnpm test -- tests/evaluator.test.ts` and confirm pass.

### Task 2: Runner, Graders, And Local Fixtures

**Files:**
- Create: `tests/evaluator-runner.test.ts`
- Create: `packages/evaluator/src/graders.ts`
- Create: `packages/evaluator/src/runner.ts`
- Create: `packages/evaluator/src/cli.ts`
- Create: `docs/evals/harness-smoke.jsonl`
- Create: `docs/evals/harness-safety.jsonl`
- Modify: `package.json`

- [x] Write failing tests for deterministic graders and suite runner.
- [x] Run `pnpm test -- tests/evaluator-runner.test.ts` and confirm expected missing exports.
- [x] Implement graders, runner, CLI, and fixtures.
- [x] Run `pnpm test -- tests/evaluator-runner.test.ts` and `pnpm eval:smoke`.

### Task 3: Wiring And Docs

**Files:**
- Create: `packages/evaluator/package.json`
- Modify: `tsconfig.base.json`
- Modify: `vitest.config.ts`
- Create: `docs/evaluation.md`
- Modify: `README.md`

- [x] Add workspace package metadata and path aliases.
- [x] Document metrics, artifacts, privacy defaults, and smoke eval usage.
- [x] Run `pnpm lint`, `pnpm build`, and full targeted tests.
