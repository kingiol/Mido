# Evaluation and Reproducibility

Mido evaluates agent changes from the protocol event stream. The evaluator is an
SDK package, not a web-demo feature, so it can run in CI, local scripts, or app
specific harnesses.

## Package

`@mido-agent/evaluator` exports:

- `calculateRunMetrics(events)` for run-level efficiency, cost, robustness, and
  safety metrics.
- `aggregateEvalSuite(...)` for suite totals and success rate.
- `buildRunArtifact(...)` for reproducible run artifacts.
- `renderEvalReport(report)` for Markdown reports.
- `gradeEvalCase(...)` and `runEvalSuite(...)` for deterministic local evals.

The metrics implementation reuses `buildRunTrace(events)` from
`@mido-agent/protocol-core`, so evaluator behavior stays aligned with the core run
inspector trace shape.

## Run artifacts

Artifacts use schema version `mido.run-artifact.v1` and contain:

- manifest: run/thread/trace ids, SDK version, git metadata, provider/model,
  adapter kind, request hash, event trace hash, tool manifest hash, optional
  system prompt/model-capability hashes, and skill refs.
- trace: `RunTraceSummary`.
- metrics: `RunMetrics`.
- events: raw `CoreEvent[]`.

Request payloads are not included by default. `buildRunArtifact(...)` stores a
request hash for comparison and only includes the full request when
`includePayload: true` is passed.

Tool manifest hashes only include serializable tool definitions. Runtime
handlers such as `execute` are excluded from the hash.

## Local smoke and safety evals

The default local evals do not require provider credentials:

```bash
pnpm eval:smoke
```

The command reads:

- `docs/evals/harness-smoke.jsonl`
- `docs/evals/harness-safety.jsonl`

It writes JSON and Markdown reports under `artifacts/evals/`. A failing case
sets a non-zero exit code.

Each JSONL line is a deterministic fixture case:

```json
{"id":"text-only","expectations":[{"type":"run_status","status":"completed"}],"events":[]}
```

Supported deterministic expectations:

- `run_status`
- `exact_text`
- `contains_text`
- `event_sequence`
- `tool_called`
- `tool_not_called`
- `error_code`

Applications can replace fixture events with a real `runCase(case)` callback
that drives their own runner, model adapter, or fake adapter. The evaluator only
requires returned `CoreEvent[]`.

## Local store evaluation

Use local store evaluation to inspect real run event logs written by
`FileSystemEventStore`:

```bash
pnpm eval:store
```

The command scans `.mido-store/**/events.jsonl`, calculates metrics for each
run, aggregates the suite, and writes JSON and Markdown reports under
`artifacts/evals/`.

By default, the JSON report does not include raw event arrays because real
events can contain user text, tool arguments, and tool results. To include raw
events for local debugging, opt in explicitly:

```bash
pnpm eval:store -- --include-events
```

You can point at another store root or output directory:

```bash
pnpm eval:store -- /path/to/.mido-store --out-dir /tmp/mido-evals
```

Historical runs are treated as evaluatable samples, not expectation-based
grading cases. A run with status `error` still counts as a scanned sample; the
report exposes that error through metrics such as provider errors, tool errors,
missing usage, and safety counts.
