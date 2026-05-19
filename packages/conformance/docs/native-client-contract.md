# Native Client Contract

This package defines the v1 contract for non-TypeScript clients.

## Required behavior

- Consume `CoreEvent` over an SSE stream.
- Persist `runId` for the lifetime of the run.
- Send serializable registered client tool definitions in `RunStartRequest.clientTools`.
- Execute `client_auto` tools without blocking the UI thread.
- Surface `client_interactive` tools to the UI as pending actions.
- Execute approved `client_interactive` tools, then submit their tool results.
- Do not execute rejected `client_interactive` tools; submit an error tool result instead.
- Submit tool results back with `RunResumeRequest`.

## Required validation

- Validate outgoing tool results against the exported `resultSchema`.
- Do not include execute handlers or platform objects in `clientTools`.
- Only send `client_auto` and `client_interactive` tools in `clientTools`.
- Preserve `toolCallId`, `messageId`, and `runId` unchanged.
- Treat duplicate tool result submissions with the same payload as idempotent.

## Recommended implementation split

- Transport: `SSE down + POST up`
- State machine: `idle -> running -> awaiting_client_tool -> running -> finished`
- Tool registry: keep the same `name/inputSchema/resultSchema/executionPolicy` contract as the server
- Client-side MCP: register MCP tools as `client_auto`, advertise their definitions in `clientTools`, and execute `callTool` locally when the server streams the tool call.

## Native Skill Manager

Native clients can manage user skills locally, but skill loading and script execution remain server-owned.

Required split:

- Native client imports, displays, enables, disables, and syncs skills.
- Server validates skill archives, stores the canonical copy, computes digest, loads `SKILL.md`, reads resources, and runs scripts through sandbox.
- Native client sends enabled skill references in `RunStartRequest.metadata`.

Recommended metadata shape:

```json
{
  "skills": {
    "enabled": [
      {
        "id": "support-triage",
        "digest": "sha256:abc",
        "source": "user"
      }
    ]
  }
}
```

Native clients must treat local skill parsing as a preview only. The server must re-validate ownership, digest, review status, script eligibility, and policy before using any skill.

Native scripts should not execute on mobile clients. Desktop clients that need local script execution should expose it as an explicit `client_interactive` tool with a platform sandbox and user approval.
