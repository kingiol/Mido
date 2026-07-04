# Mido Documentation

This directory is organized around how a reader usually approaches the SDK:
start with the product shape, then read runtime contracts, then use roadmap and
plans for future work.

## Start here

| Document | Purpose |
| --- | --- |
| [Roadmap](./roadmap.md) | Current product direction, priority order, and near-term backlog. |
| [Architecture](./architecture.md) | Package boundaries, runtime ownership, and server/client responsibilities. |
| [Data Flow](./data-flow.md) | End-to-end run, pause, tool execution, and resume sequence. |
| [Evaluation](./evaluation.md) | Run metrics, reproducible artifacts, deterministic graders, and local smoke evals. |

## Runtime contracts

| Document | Purpose |
| --- | --- |
| [Storage and Tracing](./storage-and-tracing.md) | Checkpoints, thread/event stores, storage scope, trace metadata, and inspector data. |
| [Agent Skills](./agent-skills.md) | Skill directory shape, server/client integration, progressive loading, audit, and script sandboxing. |
| [Evaluation](./evaluation.md) | Evaluator package APIs, artifact privacy defaults, fixture JSONL, and report outputs. |
| [Native Client Contract](../packages/conformance/docs/native-client-contract.md) | Rules native clients must follow when implementing the Mido protocol. |
| [Event Sequence](../packages/conformance/docs/event-sequence.md) | Expected event ordering for conformance and replay. |

## Planning documents

| Document | Purpose |
| --- | --- |
| [Capability Backlog](./agent-capability-roadmap.md) | Detailed capability notes behind the roadmap. |
| [Full Agent Harness Mechanism](./plans/full-agent-harness-mechanism.md) | Prompt registry, context assembly, goal ledger, role agents, verification gates, and eval migration plan. |
| [Harness Improvement Plan](./plans/harness-agent-improvement-plan.md) | Evaluator, run artifact, retry, memory, and CI gate implementation plan. |
| [User Memory Design](./plans/user-memory-design.md) | Redis Stack-based long-term memory store, semantic search, post-run extraction, and agent loop integration. |
| [User Memory Autonomous Write Design](./plans/user-memory-autonomous-write-design.md) | Candidate extraction, policy gating, explicit user keys, and autonomous write lifecycle. |

## Archive

Historical implementation plans live under [archive/plans](./archive/plans/).
They are useful for tracing previous decisions, but they are not the current
source of truth for priority.
