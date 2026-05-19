import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type AgentMessage } from '@mido/protocol-core';
import {
  InMemorySessionStore,
  buildDockerAgentSkillSandboxCommand,
  createAgentRunner,
  createDockerAgentSkillSandbox,
  createAgentSkillScriptTool,
  createAgentSkillRegistry,
  loadAgentSkillsFromDirectory,
  type AgentSkillAuditEvent,
  type AgentSkillSandbox,
  type AgentSkillScriptExecutionRequest,
  type AgentSkillScriptExecutionResult,
  type ModelAdapter,
  type ModelAdapterEvent,
  type ModelAdapterRunInput
} from '@mido/server-sdk';

describe('agent skills', () => {
  it('indexes only SKILL.md frontmatter before loading instructions', async () => {
    const rootDir = await createSkillTree({
      'support-triage/SKILL.md': `---
name: support-triage
description: Triage support tickets and draft concise replies.
keywords:
  - ticket
  - support
---

# Support Triage

Use the private triage rubric.
`
    });

    const skills = await loadAgentSkillsFromDirectory(rootDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'support-triage',
      name: 'support-triage',
      description: 'Triage support tickets and draft concise replies.',
      keywords: ['ticket', 'support']
    });
    expect(JSON.stringify(skills[0])).not.toContain('private triage rubric');
  });

  it('selects relevant skills, loads them within budget, and emits audit events', async () => {
    const auditEvents: AgentSkillAuditEvent[] = [];
    const rootDir = await createSkillTree({
      'support-triage/SKILL.md': `---
name: support-triage
description: Triage support tickets and draft concise replies.
keywords: [ticket, support]
---

# Support Triage

Use the support rubric before writing a reply.
`,
      'spreadsheet-cleanup/SKILL.md': `---
name: spreadsheet-cleanup
description: Clean spreadsheet exports.
keywords: [spreadsheet]
---

# Spreadsheet Cleanup

Normalize columns.
`
    });
    const registry = await createAgentSkillRegistry({
      rootDirs: [rootDir],
      maxLoadedSkills: 1,
      maxPromptBytes: 220,
      auditSink: event => {
        auditEvents.push(event);
      }
    });

    const prompt = await registry.buildSystemPrompt({
      runId: 'run-1',
      request: {
        messages: [createUserMessage('Please triage this support ticket.')]
      },
      tools: []
    });

    expect(prompt).toContain('support-triage');
    expect(prompt).toContain('Use the support rubric');
    expect(prompt).not.toContain('Spreadsheet Cleanup');
    expect(Buffer.byteLength(prompt ?? '')).toBeLessThanOrEqual(220);
    expect(auditEvents.map(event => event.type)).toEqual(['skill.indexed', 'skill.indexed', 'skill.selected', 'skill.loaded']);
    expect(auditEvents.at(-1)).toMatchObject({
      type: 'skill.loaded',
      skillId: 'support-triage',
      runId: 'run-1'
    });
  });

  it('selects skills explicitly enabled through nested metadata refs', async () => {
    const rootDir = await createSkillTree({
      'support-triage/SKILL.md': `---
name: support-triage
description: Handle customer questions.
---

# Support Triage

Use the support rubric.
`
    });
    const registry = await createAgentSkillRegistry({
      rootDirs: [rootDir]
    });
    const skill = registry.listSkills()[0]!;

    const promptWithMismatchedDigest = await registry.buildSystemPrompt({
      runId: 'run-1',
      request: {
        messages: [createUserMessage('hello')],
        metadata: {
          skills: {
            enabled: [
              {
                id: skill.id,
                digest: 'sha256:wrong'
              }
            ]
          }
        }
      },
      tools: []
    });
    const promptWithMatchingDigest = await registry.buildSystemPrompt({
      runId: 'run-2',
      request: {
        messages: [createUserMessage('hello')],
        metadata: {
          skills: {
            enabled: [
              {
                id: skill.id,
                digest: skill.digest,
                source: 'user'
              }
            ]
          }
        }
      },
      tools: []
    });

    expect(promptWithMismatchedDigest).toBeUndefined();
    expect(promptWithMatchingDigest).toContain('Use the support rubric.');
  });

  it('rejects symlinked resource roots before indexing', async () => {
    const rootDir = await createSkillTree({
      'leaky/SKILL.md': `---
name: leaky
description: Try to read outside files.
---

# Leaky
`
    });
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'mido-secret-'));
    await writeFile(path.join(outsideDir, 'secret.md'), 'do not expose', 'utf8');
    await symlink(outsideDir, path.join(rootDir, 'leaky', 'references'), 'dir');

    await expect(loadAgentSkillsFromDirectory(rootDir)).rejects.toThrow(/symlink/);
  });

  it('rejects symlinked SKILL.md before reading instructions', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'mido-skills-'));
    const skillDir = path.join(rootDir, 'linked-skill');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'mido-external-skill-'));
    const outsideSkillPath = path.join(outsideDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(outsideSkillPath, `---
name: linked-skill
description: Should not be loaded through a symlink.
---

# Linked Skill
`, 'utf8');
    await symlink(outsideSkillPath, path.join(skillDir, 'SKILL.md'));

    await expect(loadAgentSkillsFromDirectory(rootDir)).rejects.toThrow(/SKILL\.md.*symlink|symlink.*SKILL\.md/);
  });

  it('uses structured skill digest input so path bytes cannot bleed into file bytes', async () => {
    const firstRoot = await createSkillTree({
      'ambiguous/SKILL.md': `---
name: ambiguous
description: Check digest boundaries.
---

# Ambiguous
`,
      'ambiguous/references/a': 'bc'
    });
    const secondRoot = await createSkillTree({
      'ambiguous/SKILL.md': `---
name: ambiguous
description: Check digest boundaries.
---

# Ambiguous
`,
      'ambiguous/references/ab': 'c'
    });

    const [firstSkill] = await loadAgentSkillsFromDirectory(firstRoot);
    const [secondSkill] = await loadAgentSkillsFromDirectory(secondRoot);

    expect(firstSkill?.digest).not.toBe(secondSkill?.digest);
  });

  it('rejects scripts directories in the no-script MVP', async () => {
    const rootDir = await createSkillTree({
      'writer/SKILL.md': `---
name: writer
description: Draft content.
---

# Writer
`,
      'writer/scripts/run.js': 'console.log("nope");'
    });

    await expect(loadAgentSkillsFromDirectory(rootDir)).rejects.toThrow(/scripts/);
  });

  it('indexes and executes scripts only through an explicit sandbox', async () => {
    const auditEvents: AgentSkillAuditEvent[] = [];
    const sandbox = new FakeSkillSandbox({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: '',
      timedOut: false
    });
    const rootDir = await createSkillTree({
      'report-writer/SKILL.md': `---
name: report-writer
description: Draft reports.
keywords: [report]
---

# Report Writer
`,
      'report-writer/scripts/render.js': 'process.stdout.write("ok");'
    });

    const registry = await createAgentSkillRegistry({
      rootDirs: [rootDir],
      scriptSandbox: sandbox,
      auditSink: event => {
        auditEvents.push(event);
      }
    });

    const skill = registry.listSkills()[0];
    expect(skill?.scripts).toMatchObject([
      {
        path: 'scripts/render.js',
        type: 'script'
      }
    ]);

    const result = await registry.runSkillScript({
      runId: 'run-1',
      skillId: 'report-writer',
      scriptPath: 'scripts/render.js',
      args: {
        title: 'Q1'
      }
    });

    expect(result).toMatchObject({
      skillId: 'report-writer',
      scriptPath: 'scripts/render.js',
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: ''
    });
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.requests[0]).toMatchObject({
      runId: 'run-1',
      scriptPath: 'scripts/render.js',
      args: {
        title: 'Q1'
      }
    });
    expect(auditEvents.map(event => event.type)).toContain('skill.script_started');
    expect(auditEvents.map(event => event.type)).toContain('skill.script_completed');
  });

  it('creates a policy-governed server tool for skill scripts', async () => {
    const sandbox = new FakeSkillSandbox({
      exitCode: 0,
      stdout: 'ok',
      stderr: ''
    });
    const rootDir = await createSkillTree({
      'report-writer/SKILL.md': `---
name: report-writer
description: Draft reports.
---

# Report Writer
`,
      'report-writer/scripts/render.js': 'process.stdout.write("ok");'
    });
    const registry = await createAgentSkillRegistry({
      rootDirs: [rootDir],
      scriptSandbox: sandbox
    });

    const tool = createAgentSkillScriptTool(registry);

    expect(tool).toMatchObject({
      name: 'skill_run_script',
      executionPolicy: 'server',
      metadata: {
        policy: {
          risk: 'high',
          effects: ['execute'],
          scopes: ['skill:script:run']
        }
      }
    });
    expect(tool.inputSchema).toMatchObject({
      properties: {
        skillId: { description: expect.any(String) },
        scriptPath: { description: expect.any(String) },
        args: { description: expect.any(String) },
        input: { description: expect.any(String) },
        timeoutMs: { description: expect.any(String) }
      }
    });

    const output = await tool.execute?.({
      skillId: 'report-writer',
      scriptPath: 'scripts/render.js',
      args: {
        title: 'Q1'
      }
    }, {
      runId: 'run-1',
      messages: [],
      state: {}
    });

    expect(output).toMatchObject({
      skillId: 'report-writer',
      scriptPath: 'scripts/render.js',
      exitCode: 0,
      stdout: 'ok'
    });
  });

  it('clamps model-requested script timeouts to the tool limit', async () => {
    const sandbox = new FakeSkillSandbox({
      exitCode: 0,
      stdout: 'ok',
      stderr: ''
    });
    const rootDir = await createSkillTree({
      'report-writer/SKILL.md': `---
name: report-writer
description: Draft reports.
---

# Report Writer
`,
      'report-writer/scripts/render.js': 'process.stdout.write("ok");'
    });
    const registry = await createAgentSkillRegistry({
      rootDirs: [rootDir],
      scriptSandbox: sandbox
    });
    const tool = createAgentSkillScriptTool(registry, {
      timeoutMs: 2500
    });

    await tool.execute?.({
      skillId: 'report-writer',
      scriptPath: 'scripts/render.js',
      timeoutMs: 60_000
    }, {
      runId: 'run-1',
      messages: [],
      state: {}
    });

    expect(sandbox.requests[0]?.timeoutMs).toBe(2500);
  });

  it('kills and removes Docker containers after sandbox timeout', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'mido-fake-docker-'));
    const dockerLogPath = path.join(tempDir, 'docker.log');
    const dockerPath = path.join(tempDir, 'docker');
    await writeFile(dockerPath, `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLogPath}"
if [ "$1" = "run" ]; then
  sleep 0.2
fi
exit 0
`, 'utf8');
    await chmod(dockerPath, 0o755);
    const rootDir = await createSkillTree({
      'report-writer/SKILL.md': `---
name: report-writer
description: Draft reports.
---

# Report Writer
`,
      'report-writer/scripts/render.js': 'process.stdout.write("ok");'
    });
    const [skill] = await loadAgentSkillsFromDirectory(rootDir, {
      allowScripts: true
    });
    const sandbox = createDockerAgentSkillSandbox({
      image: 'node:22-alpine',
      dockerBinary: dockerPath,
      timeoutMs: 20
    });

    const result = await sandbox.runScript({
      runId: 'run-1',
      skill: skill!,
      scriptPath: 'scripts/render.js'
    });
    const dockerLog = await readFile(dockerLogPath, 'utf8');

    expect(result.timedOut).toBe(true);
    expect(dockerLog).toContain('kill ');
    expect(dockerLog).toContain('rm -f ');
  });

  it('builds a Docker sandbox command with isolation defaults', () => {
    const command = buildDockerAgentSkillSandboxCommand({
      image: 'node:22-alpine',
      skillRoot: '/tmp/mido-skill',
      scriptPath: 'scripts/render.js',
      command: ['node'],
      timeoutMs: 2500
    });

    expect(command.file).toBe('docker');
    expect(command.timeoutMs).toBe(2500);
    expect(command.args).toEqual(expect.arrayContaining([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      'type=bind,src=/tmp/mido-skill,dst=/skill,readonly',
      '--tmpfs',
      '/workspace:rw,nosuid,nodev,noexec,size=64m',
      '--workdir',
      '/workspace',
      'node:22-alpine',
      'node',
      '/skill/scripts/render.js'
    ]));
    expect(command.args).not.toContain('/tmp/mido-skill/scripts/render.js');
  });

  it('injects selected skill instructions into runner system prompt', async () => {
    const rootDir = await createSkillTree({
      'support-triage/SKILL.md': `---
name: support-triage
description: Triage support tickets and draft concise replies.
keywords: [ticket]
---

# Support Triage

Use the support rubric.
`
    });
    const skillRegistry = await createAgentSkillRegistry({
      rootDirs: [rootDir]
    });
    const adapter = new RecordingAdapter([{ type: 'done', finishReason: 'stop' }]);
    const runner = createAgentRunner({
      modelAdapter: adapter,
      sessionStore: new InMemorySessionStore(),
      systemPrompt: 'Base server rules.',
      skillRegistry
    });

    await collect(runner.run({
      runId: 'run-1',
      messages: [createUserMessage('ticket from customer')]
    }));

    const systemText = adapter.inputs[0]?.messages[0]?.content.find(part => part.type === 'text')?.text ?? '';
    expect(systemText).toContain('Base server rules.');
    expect(systemText).toContain('Agent Skills');
    expect(systemText).toContain('Use the support rubric.');
  });
});

async function createSkillTree(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'mido-skills-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }

  return rootDir;
}

function createUserMessage(text: string): AgentMessage {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    createdAt: new Date().toISOString(),
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

class RecordingAdapter implements ModelAdapter {
  readonly inputs: ModelAdapterRunInput[] = [];

  constructor(private readonly events: ModelAdapterEvent[]) {}

  async run(input: ModelAdapterRunInput): Promise<AsyncIterable<ModelAdapterEvent>> {
    this.inputs.push(JSON.parse(JSON.stringify(input)) as ModelAdapterRunInput);
    return streamEvents(this.events);
  }
}

async function* streamEvents(events: ModelAdapterEvent[]): AsyncIterable<ModelAdapterEvent> {
  yield* events;
}

class FakeSkillSandbox implements AgentSkillSandbox {
  readonly requests: AgentSkillScriptExecutionRequest[] = [];

  constructor(private readonly result: AgentSkillScriptExecutionResult) {}

  async runScript(request: AgentSkillScriptExecutionRequest): Promise<AgentSkillScriptExecutionResult> {
    this.requests.push(request);
    return this.result;
  }
}
