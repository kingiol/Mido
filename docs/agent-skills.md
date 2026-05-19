# Agent Skills

Mido supports a no-script Agent Skills MVP. A skill is an instruction and resource package, not a new execution runtime. Phase 1 supports only:

- `SKILL.md`
- `references/`
- `assets/`

`scripts/` is rejected unless `scriptSandbox` is explicitly configured. Script execution must run through a sandbox.

## Directory shape

```text
skills/
  support-triage/
    SKILL.md
    references/
      rubric.md
    assets/
      tone-guide.pdf
    scripts/
      render.js
```

`SKILL.md` must start with frontmatter:

```md
---
name: support-triage
description: Triage support tickets and draft concise replies.
keywords: [ticket, support]
---

# Support Triage

Use the support rubric before writing a reply.
```

The server indexes only the frontmatter first. Full instructions are loaded only when a run selects the skill.

## Server integration

```ts
import {
  createAgentRunner,
  createAgentSkillRegistry
} from '@mido/server-sdk';

const skillRegistry = await createAgentSkillRegistry({
  rootDirs: ['./skills'],
  maxLoadedSkills: 3,
  maxPromptBytes: 48_000,
  auditSink: event => {
    console.log(event);
  }
});

const runner = createAgentRunner({
  modelAdapter,
  sessionStore,
  systemPrompt: 'Follow the application safety policy.',
  skillRegistry
});
```

The runner composes the server system prompt and selected skill instructions before model invocation. Existing client system prompt wrapping still applies.

## Client integration

The client does not read skill files. It can send skill preferences through run metadata:

```ts
await client.sendMessage('Please triage this ticket.', {
  metadata: {
    enabledSkills: ['support-triage']
  }
});
```

If `enabledSkills` is omitted, the server selects skills from user text using skill name, id, keywords, and description terms.

Native clients should use `createAgentSkillManager` from `@mido/client-core` to track local skill state and inject enabled skill refs into run metadata:

```ts
const skillManager = createAgentSkillManager({ store });
const client = createAgentClient({
  transport,
  skillManager
});

await skillManager.installSkill({
  id: 'support-triage',
  name: 'Support Triage',
  description: 'Triage support tickets.',
  digest: 'sha256:abc',
  source: 'user',
  enabled: true
});

await client.sendMessage('Please triage this ticket.');
```

The request metadata will include:

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

Native clients can preview skill frontmatter locally, but the server must still validate the canonical skill archive, digest, ownership, review status, and sandbox eligibility before loading or running it.

## Progressive loading

Phase 1 has three levels:

```text
Index time
  -> load SKILL.md frontmatter only

Run start
  -> select relevant skills
  -> load selected SKILL.md body under prompt budget

Resource access
  -> read explicit references/ or assets/ paths on demand
```

Resources can be listed and read from the registry:

```ts
const resources = skillRegistry.listSkillResources('support-triage');
const rubric = await skillRegistry.readSkillResource(
  'support-triage',
  'references/rubric.md'
);
```

Resource paths must stay under `references/` or `assets/`. Absolute paths, `..`, and unregistered resources are rejected.

## Audit

The registry emits audit events for:

- `skill.indexed`
- `skill.selected`
- `skill.loaded`
- `skill.resource_read`

Log at least `skillId`, `digest`, `runId`, selection reason, loaded byte count, and resource path. This is enough to reconstruct what skill content could influence a run.

## Scripts sandbox

Scripts stay disabled by default. To enable them, provide a sandbox and register the script tool:

```ts
import {
  createAgentRunner,
  createAgentSkillRegistry,
  createAgentSkillScriptTool,
  createDockerAgentSkillSandbox
} from '@mido/server-sdk';

const skillRegistry = await createAgentSkillRegistry({
  rootDirs: ['./skills'],
  scriptSandbox: createDockerAgentSkillSandbox({
    image: 'node:22-alpine',
    command: ['node'],
    network: 'none',
    memory: '256m',
    cpus: '1',
    pidsLimit: 64,
    timeoutMs: 30_000
  }),
  auditSink: event => {
    console.log(event);
  }
});

const runner = createAgentRunner({
  modelAdapter,
  sessionStore,
  toolPolicy,
  skillRegistry
});

runner.registerTool(createAgentSkillScriptTool(skillRegistry));
```

The default Docker sandbox command uses:

- no shell interpolation
- `--network none`
- read-only container root
- read-only skill mount at `/skill`
- tmpfs workspace at `/workspace`
- dropped Linux capabilities
- `no-new-privileges`
- non-root user
- CPU, memory, pids, timeout, and output limits

The script receives JSON on stdin:

```json
{
  "args": {},
  "input": null,
  "metadata": {}
}
```

`createAgentSkillScriptTool` exposes `skill_run_script` as a `server` tool. It carries high-risk policy metadata:

```ts
metadata: {
  policy: {
    risk: 'high',
    effects: ['execute'],
    scopes: ['skill:script:run']
  }
}
```

With `createDefaultToolPolicy()`, high-risk non-interactive server tools are hidden and blocked. Production apps should provide a custom policy that allows only approved skills, users, tenants, or admin-confirmed runs.

## Safety

Required controls:

- validate `SKILL.md` frontmatter before indexing
- reject angle brackets in frontmatter strings
- hash `SKILL.md`, `references/`, and `assets/`
- hash `scripts/` when scripts are enabled
- enforce `maxLoadedSkills`, `maxSkillBytes`, and `maxPromptBytes`
- reject symlinked resources
- reject script paths outside `scripts/`
- keep client-provided skill choices as preferences, not authority

Audit also includes:

- `skill.script_started`
- `skill.script_completed`
- `skill.script_failed`
