import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue } from '@mido/protocol-core';

import type { ServerToolRuntimeDefinition, ToolExecutionContext } from './runner.js';
import type { SystemPromptContext } from './system-prompt.js';
import { SKILL_SECTION_HEADER } from './prompts/skills.js';

export interface AgentSkillManifest {
  id: string;
  name: string;
  description: string;
  rootDir: string;
  digest: string;
  keywords?: string[];
  references: AgentSkillResource[];
  assets: AgentSkillResource[];
  scripts: AgentSkillResource[];
  metadata?: JsonObject;
}

export interface AgentSkillResource {
  path: string;
  type: 'reference' | 'asset' | 'script';
  bytes: number;
}

export type AgentSkillAuditEvent =
  | AgentSkillIndexedAuditEvent
  | AgentSkillSelectedAuditEvent
  | AgentSkillLoadedAuditEvent
  | AgentSkillResourceReadAuditEvent
  | AgentSkillScriptStartedAuditEvent
  | AgentSkillScriptCompletedAuditEvent
  | AgentSkillScriptFailedAuditEvent;

export interface AgentSkillIndexedAuditEvent {
  type: 'skill.indexed';
  timestamp: string;
  skillId: string;
  name: string;
  description: string;
  digest: string;
}

export interface AgentSkillSelectedAuditEvent {
  type: 'skill.selected';
  timestamp: string;
  runId: string;
  threadId?: string;
  skillId: string;
  score: number;
  reason: string;
}

export interface AgentSkillLoadedAuditEvent {
  type: 'skill.loaded';
  timestamp: string;
  runId: string;
  threadId?: string;
  skillId: string;
  digest: string;
  bytes: number;
  truncated: boolean;
}

export interface AgentSkillResourceReadAuditEvent {
  type: 'skill.resource_read';
  timestamp: string;
  skillId: string;
  resourcePath: string;
  bytes: number;
}

export interface AgentSkillScriptStartedAuditEvent {
  type: 'skill.script_started';
  timestamp: string;
  runId: string;
  threadId?: string;
  skillId: string;
  scriptPath: string;
  timeoutMs?: number;
}

export interface AgentSkillScriptCompletedAuditEvent {
  type: 'skill.script_completed';
  timestamp: string;
  runId: string;
  threadId?: string;
  skillId: string;
  scriptPath: string;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs: number;
}

export interface AgentSkillScriptFailedAuditEvent {
  type: 'skill.script_failed';
  timestamp: string;
  runId: string;
  threadId?: string;
  skillId: string;
  scriptPath: string;
  message: string;
  durationMs: number;
}

export type AgentSkillAuditSink = (event: AgentSkillAuditEvent) => void | Promise<void>;

export interface LoadAgentSkillsOptions {
  maxSkillBytes?: number;
  allowScripts?: boolean;
}

export interface CreateAgentSkillRegistryOptions extends LoadAgentSkillsOptions {
  rootDirs?: string[];
  skills?: AgentSkillManifest[];
  maxLoadedSkills?: number;
  maxPromptBytes?: number;
  auditSink?: AgentSkillAuditSink;
  scriptSandbox?: AgentSkillSandbox;
}

export interface AgentSkillSelection {
  skill: AgentSkillManifest;
  score: number;
  reason: string;
}

export interface AgentSkillResourceReadOptions {
  encoding?: 'utf8' | 'base64';
}

export interface AgentSkillResourceContent {
  skillId: string;
  path: string;
  type: 'reference' | 'asset';
  bytes: number;
  encoding: 'utf8' | 'base64';
  content: string;
}

export interface AgentSkillScriptExecutionRequest {
  runId: string;
  threadId?: string;
  skill: AgentSkillManifest;
  scriptPath: string;
  args?: JsonObject;
  input?: JsonValue;
  metadata?: JsonObject;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentSkillScriptExecutionResult {
  skillId?: string;
  scriptPath?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface AgentSkillSandbox {
  runScript(request: AgentSkillScriptExecutionRequest): Promise<AgentSkillScriptExecutionResult> | AgentSkillScriptExecutionResult;
}

export interface AgentSkillRunScriptRequest {
  runId: string;
  threadId?: string;
  skillId: string;
  scriptPath: string;
  args?: JsonObject;
  input?: JsonValue;
  metadata?: JsonObject;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentSkillRunScriptResult extends AgentSkillScriptExecutionResult {
  skillId: string;
  scriptPath: string;
}

export interface AgentSkillScriptToolOptions {
  name?: string;
  modelName?: string;
  description?: string;
  timeoutMs?: number;
}

export interface DockerAgentSkillSandboxOptions {
  image: string;
  dockerBinary?: string;
  command?: string[];
  network?: 'none' | string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  user?: string;
  tmpfsSize?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface DockerAgentSkillSandboxCommandInput extends DockerAgentSkillSandboxOptions {
  skillRoot: string;
  scriptPath: string;
  timeoutMs?: number;
}

export interface DockerAgentSkillSandboxCommand {
  file: string;
  args: string[];
  timeoutMs: number;
}

export interface AgentSkillRegistry {
  listSkills(): AgentSkillManifest[];
  selectSkills(context: SystemPromptContext): AgentSkillSelection[];
  buildSystemPrompt(context: SystemPromptContext): Promise<string | undefined>;
  listSkillResources(skillId: string): AgentSkillResource[];
  readSkillResource(skillId: string, resourcePath: string, options?: AgentSkillResourceReadOptions): Promise<AgentSkillResourceContent>;
  listSkillScripts(skillId: string): AgentSkillResource[];
  runSkillScript(request: AgentSkillRunScriptRequest): Promise<AgentSkillRunScriptResult>;
}

const skillMdFileName = 'SKILL.md';
const defaultMaxSkillBytes = 16_000;
const defaultMaxPromptBytes = 48_000;
const defaultMaxLoadedSkills = 3;
const defaultScriptTimeoutMs = 30_000;
const defaultDockerMaxOutputBytes = 256_000;
const allowedResourceRoots = new Set(['references', 'assets']);

export async function loadAgentSkillsFromDirectory(
  rootDir: string,
  options: LoadAgentSkillsOptions = {}
): Promise<AgentSkillManifest[]> {
  const entries = await readdir(rootDir, {
    withFileTypes: true
  });
  const skills: AgentSkillManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillRoot = path.join(rootDir, entry.name);
    skills.push(await loadSkillManifest(skillRoot, entry.name, options));
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export async function createAgentSkillRegistry(options: CreateAgentSkillRegistryOptions = {}): Promise<AgentSkillRegistry> {
  const loadedSkills: AgentSkillManifest[] = [
    ...(options.skills ?? [])
  ];

  for (const rootDir of options.rootDirs ?? []) {
    loadedSkills.push(...await loadAgentSkillsFromDirectory(rootDir, {
      ...options,
      allowScripts: options.allowScripts ?? Boolean(options.scriptSandbox)
    }));
  }

  const byId = new Map<string, AgentSkillManifest>();
  for (const skill of loadedSkills) {
    if (byId.has(skill.id)) {
      throw new Error(`Agent skill "${skill.id}" is already registered`);
    }

    byId.set(skill.id, skill);
    if (skill.scripts.length > 0 && !options.scriptSandbox) {
      throw new Error(`Agent skill "${skill.id}" contains scripts, but no scriptSandbox was configured`);
    }

    await emitAudit(options.auditSink, {
      type: 'skill.indexed',
      timestamp: new Date().toISOString(),
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      digest: skill.digest
    });
  }

  const maxLoadedSkills = options.maxLoadedSkills ?? defaultMaxLoadedSkills;
  const maxSkillBytes = options.maxSkillBytes ?? defaultMaxSkillBytes;
  const maxPromptBytes = options.maxPromptBytes ?? defaultMaxPromptBytes;

  return {
    listSkills() {
      return [...byId.values()];
    },

    selectSkills(context) {
      return selectSkills([...byId.values()], context, maxLoadedSkills);
    },

    async buildSystemPrompt(context) {
      const selections = selectSkills([...byId.values()], context, maxLoadedSkills);
      if (selections.length === 0 || maxPromptBytes <= 0) {
        return undefined;
      }

      const sections: string[] = [SKILL_SECTION_HEADER];
      let remainingBytes = maxPromptBytes - byteLength(sections.join('\n\n'));

      for (const selection of selections) {
        await emitAudit(options.auditSink, {
          type: 'skill.selected',
          timestamp: new Date().toISOString(),
          runId: context.runId,
          threadId: context.threadId,
          skillId: selection.skill.id,
          score: selection.score,
          reason: selection.reason
        });

        if (remainingBytes <= 0) {
          break;
        }

        const loaded = await loadSkillInstructions(selection.skill, {
          maxSkillBytes: Math.min(maxSkillBytes, remainingBytes)
        });
        if (!loaded.instructions) {
          continue;
        }

        const section = `## ${selection.skill.name}\n${loaded.instructions}`;
        const fittingSection = truncateToBytes(section, remainingBytes);
        if (!fittingSection) {
          continue;
        }

        sections.push(fittingSection);
        remainingBytes -= byteLength(`\n\n${fittingSection}`);
        await emitAudit(options.auditSink, {
          type: 'skill.loaded',
          timestamp: new Date().toISOString(),
          runId: context.runId,
          threadId: context.threadId,
          skillId: selection.skill.id,
          digest: selection.skill.digest,
          bytes: byteLength(fittingSection),
          truncated: loaded.truncated || fittingSection.length < section.length
        });
      }

      const prompt = sections.join('\n\n');
      return prompt === sections[0] ? undefined : truncateToBytes(prompt, maxPromptBytes);
    },

    listSkillResources(skillId) {
      return getSkill(byId, skillId).references.concat(getSkill(byId, skillId).assets);
    },

    async readSkillResource(skillId, resourcePath, readOptions = {}) {
      const skill = getSkill(byId, skillId);
      const readableResources = [...skill.references, ...skill.assets] as Array<AgentSkillResource & { type: 'reference' | 'asset' }>;
      const resource = readableResources.find(item => item.path === normalizeResourcePath(resourcePath));
      if (!resource) {
        throw new Error(`Skill resource "${resourcePath}" is not registered for skill "${skillId}"`);
      }

      const absolutePath = resolveSkillResourcePath(skill.rootDir, resource.path);
      const file = await readFile(absolutePath);
      const encoding = readOptions.encoding ?? 'utf8';
      const content = encoding === 'base64' ? file.toString('base64') : file.toString('utf8');

      await emitAudit(options.auditSink, {
        type: 'skill.resource_read',
        timestamp: new Date().toISOString(),
        skillId: skill.id,
        resourcePath: resource.path,
        bytes: file.byteLength
      });

      return {
        skillId: skill.id,
        path: resource.path,
        type: resource.type,
        bytes: file.byteLength,
        encoding,
        content
      };
    },

    listSkillScripts(skillId) {
      return [...getSkill(byId, skillId).scripts];
    },

    async runSkillScript(request) {
      if (!options.scriptSandbox) {
        throw new Error('Agent skill script execution requires a configured scriptSandbox');
      }

      const skill = getSkill(byId, request.skillId);
      const scriptPath = normalizeScriptPath(request.scriptPath);
      const script = skill.scripts.find(item => item.path === scriptPath);
      if (!script) {
        throw new Error(`Skill script "${request.scriptPath}" is not registered for skill "${request.skillId}"`);
      }

      const startedAt = Date.now();
      await emitAudit(options.auditSink, {
        type: 'skill.script_started',
        timestamp: new Date().toISOString(),
        runId: request.runId,
        threadId: request.threadId,
        skillId: skill.id,
        scriptPath,
        timeoutMs: request.timeoutMs
      });

      try {
        const result = await options.scriptSandbox.runScript({
          runId: request.runId,
          threadId: request.threadId,
          skill,
          scriptPath,
          args: request.args,
          input: request.input,
          metadata: request.metadata,
          timeoutMs: request.timeoutMs,
          signal: request.signal
        });
        await emitAudit(options.auditSink, {
          type: 'skill.script_completed',
          timestamp: new Date().toISOString(),
          runId: request.runId,
          threadId: request.threadId,
          skillId: skill.id,
          scriptPath,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt
        });

        return {
          ...result,
          skillId: skill.id,
          scriptPath
        };
      } catch (error) {
        await emitAudit(options.auditSink, {
          type: 'skill.script_failed',
          timestamp: new Date().toISOString(),
          runId: request.runId,
          threadId: request.threadId,
          skillId: skill.id,
          scriptPath,
          message: error instanceof Error ? error.message : 'Agent skill script failed',
          durationMs: Date.now() - startedAt
        });
        throw error;
      }
    }
  };
}

export function createAgentSkillScriptTool(
  registry: AgentSkillRegistry,
  options: AgentSkillScriptToolOptions = {}
): ServerToolRuntimeDefinition {
  const timeoutMs = normalizeMaxScriptTimeoutMs(options.timeoutMs);

  return {
    name: options.name ?? 'skill_run_script',
    modelName: options.modelName ?? 'server__skill_run_script',
    description: options.description ?? 'Run an Agent Skill script inside the configured sandbox.',
    executionPolicy: 'server',
    timeoutMs,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skillId: {
          type: 'string',
          description: 'Agent Skill id containing the script to run.'
        },
        scriptPath: {
          type: 'string',
          description: 'Workspace-relative script path inside the selected skill directory.'
        },
        args: {
          type: 'object',
          description: 'Optional structured arguments passed to the skill script.'
        },
        input: {
          description: 'Optional JSON input value passed to the skill script.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Requested script timeout in milliseconds, clamped to the tool timeout.'
        }
      },
      required: ['skillId', 'scriptPath']
    },
    resultSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skillId: {
          type: 'string'
        },
        scriptPath: {
          type: 'string'
        },
        exitCode: {
          type: ['number', 'null']
        },
        stdout: {
          type: 'string'
        },
        stderr: {
          type: 'string'
        },
        timedOut: {
          type: 'boolean'
        },
        stdoutTruncated: {
          type: 'boolean'
        },
        stderrTruncated: {
          type: 'boolean'
        }
      },
      required: ['skillId', 'scriptPath', 'exitCode', 'stdout', 'stderr']
    },
    metadata: {
      policy: {
        risk: 'high',
        effects: ['execute'],
        scopes: ['skill:script:run']
      },
      skill: {
        kind: 'script_runner'
      }
    },
    execute: (args, context) => executeSkillScriptTool(registry, args, context, timeoutMs)
  };
}

export function createDockerAgentSkillSandbox(options: DockerAgentSkillSandboxOptions): AgentSkillSandbox {
  return {
    runScript(request) {
      const maxTimeoutMs = normalizeMaxScriptTimeoutMs(options.timeoutMs);
      const command = buildDockerAgentSkillSandboxCommand({
        ...options,
        skillRoot: request.skill.rootDir,
        scriptPath: request.scriptPath,
        timeoutMs: clampScriptTimeoutMs(request.timeoutMs ?? maxTimeoutMs, maxTimeoutMs) ?? maxTimeoutMs
      });
      return runDockerSandboxCommand(command, request, options.maxOutputBytes ?? defaultDockerMaxOutputBytes);
    }
  };
}

export function buildDockerAgentSkillSandboxCommand(input: DockerAgentSkillSandboxCommandInput): DockerAgentSkillSandboxCommand {
  const scriptPath = normalizeScriptPath(input.scriptPath);
  const skillRoot = path.resolve(input.skillRoot);
  if (skillRoot.includes(',')) {
    throw new Error('Docker sandbox skillRoot cannot contain commas when using --mount');
  }

  const dockerBinary = input.dockerBinary ?? 'docker';
  const network = input.network ?? 'none';
  const memory = input.memory ?? '256m';
  const cpus = input.cpus ?? '1';
  const pidsLimit = input.pidsLimit ?? 64;
  const user = input.user ?? '65534:65534';
  const tmpfsSize = input.tmpfsSize ?? '64m';
  const timeoutMs = input.timeoutMs ?? defaultScriptTimeoutMs;
  const command = input.command && input.command.length > 0 ? input.command : ['node'];

  return {
    file: dockerBinary,
    timeoutMs,
    args: [
      'run',
      '--rm',
      '--network',
      network,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(pidsLimit),
      '--memory',
      memory,
      '--cpus',
      cpus,
      '--user',
      user,
      '--mount',
      `type=bind,src=${skillRoot},dst=/skill,readonly`,
      '--tmpfs',
      `/workspace:rw,nosuid,nodev,noexec,size=${tmpfsSize}`,
      '--workdir',
      '/workspace',
      input.image,
      ...command,
      `/skill/${scriptPath}`
    ]
  };
}

async function executeSkillScriptTool(
  registry: AgentSkillRegistry,
  args: JsonObject,
  context: ToolExecutionContext,
  maxTimeoutMs: number
): Promise<JsonValue> {
  const skillId = readToolString(args, 'skillId');
  const scriptPath = readToolString(args, 'scriptPath');
  const rawArgs = args.args;
  if (rawArgs !== undefined && !isJsonObject(rawArgs)) {
    throw new Error('skill_run_script args must be an object when provided');
  }

  const result = await registry.runSkillScript({
    runId: context.runId,
    threadId: context.threadId,
    skillId,
    scriptPath,
    args: rawArgs,
    input: args.input,
    metadata: context.metadata,
    timeoutMs: clampScriptTimeoutMs(typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined, maxTimeoutMs),
    signal: context.signal
  });
  return compactJsonObject({
    skillId: result.skillId,
    scriptPath: result.scriptPath,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  });
}

async function runDockerSandboxCommand(
  command: DockerAgentSkillSandboxCommand,
  request: AgentSkillScriptExecutionRequest,
  maxOutputBytes: number
): Promise<AgentSkillScriptExecutionResult> {
  return new Promise((resolve, reject) => {
    const containerName = createDockerContainerName(request.runId);
    const child = spawn(command.file, withDockerContainerName(command.args, containerName), {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let cleanupPromise: Promise<void> | undefined;

    const stopContainer = () => {
      if (!cleanupPromise) {
        cleanupPromise = cleanupDockerContainer(command.file, containerName);
      }

      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopContainer();
    }, command.timeoutMs);

    const abort = () => {
      timedOut = true;
      stopContainer();
    };
    request.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const next = appendCapped(stdout, chunk, maxOutputBytes);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on('data', chunk => {
      const next = appendCapped(stderr, chunk, maxOutputBytes);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    child.on('error', error => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      void settleAfterCleanup(cleanupPromise, () => reject(error));
    });
    child.on('close', code => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      void settleAfterCleanup(cleanupPromise, () => resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated
      }));
    });
    child.stdin.end(JSON.stringify({
      args: request.args ?? {},
      input: request.input ?? null,
      metadata: request.metadata ?? {}
    }));
  });
}

async function loadSkillManifest(
  skillRoot: string,
  id: string,
  options: LoadAgentSkillsOptions
): Promise<AgentSkillManifest> {
  if (!options.allowScripts) {
    await assertNoScriptsPath(skillRoot);
  }
  const skillMdPath = path.join(skillRoot, skillMdFileName);
  const skillMdStat = await lstat(skillMdPath);
  if (skillMdStat.isSymbolicLink()) {
    throw new Error(`Agent skill "${id}" SKILL.md cannot be a symlink`);
  }

  if (!skillMdStat.isFile()) {
    throw new Error(`Agent skill "${id}" SKILL.md must be a file`);
  }

  const raw = await readFile(skillMdPath, 'utf8');
  if (byteLength(raw) > (options.maxSkillBytes ?? defaultMaxSkillBytes) * 4) {
    throw new Error(`Agent skill "${id}" SKILL.md is too large to index safely`);
  }

  const parsed = parseSkillMarkdown(raw);
  const name = readRequiredString(parsed.frontmatter, 'name', id);
  const description = readRequiredString(parsed.frontmatter, 'description', id);
  const keywords = readOptionalStringArray(parsed.frontmatter, 'keywords');
  validatePromptSafeText(name, `${id} name`);
  validatePromptSafeText(description, `${id} description`);
  for (const keyword of keywords ?? []) {
    validatePromptSafeText(keyword, `${id} keyword`);
  }

  return {
    id,
    name,
    description,
    rootDir: skillRoot,
    digest: await hashSkillDirectory(skillRoot, {
      includeScripts: Boolean(options.allowScripts)
    }),
    keywords,
    references: await listResources(skillRoot, 'references', 'reference'),
    assets: await listResources(skillRoot, 'assets', 'asset'),
    scripts: options.allowScripts ? await listResources(skillRoot, 'scripts', 'script') : [],
    metadata: readMetadata(parsed.frontmatter)
  };
}

async function assertNoScriptsPath(skillRoot: string): Promise<void> {
  const scriptsPath = path.join(skillRoot, 'scripts');
  try {
    await lstat(scriptsPath);
    throw new Error(`Agent skill "${path.basename(skillRoot)}" contains scripts/, which is not supported in the no-script MVP`);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

async function listResources(
  skillRoot: string,
  rootName: 'references' | 'assets' | 'scripts',
  type: AgentSkillResource['type']
): Promise<AgentSkillResource[]> {
  const root = path.join(skillRoot, rootName);
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`Agent skill resource root "${rootName}" cannot be a symlink`);
    }

    if (!rootStat.isDirectory()) {
      return [];
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const resources: AgentSkillResource[] = [];
  await walkFiles(root, async filePath => {
    const relativePath = toPosixPath(path.relative(skillRoot, filePath));
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Agent skill resource "${relativePath}" cannot be a symlink`);
    }

    resources.push({
      path: relativePath,
      type,
      bytes: fileStat.size
    });
  });
  return resources.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  const entries = (await readdir(root, {
    withFileTypes: true
  })).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Agent skill path "${entryPath}" cannot be a symlink`);
    }

    if (entryStat.isDirectory()) {
      await walkFiles(entryPath, visit);
      continue;
    }

    if (entryStat.isFile()) {
      await visit(entryPath);
    }
  }
}

async function hashSkillDirectory(skillRoot: string, options: { includeScripts?: boolean } = {}): Promise<string> {
  const hash = createHash('sha256');
  const includeIfExists = async (relativePath: string) => {
    const absolutePath = path.join(skillRoot, relativePath);
    try {
      const fileStat = await lstat(absolutePath);
      if (!fileStat.isFile()) {
        return;
      }

      updateHashEntry(hash, relativePath, await readFile(absolutePath));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  };

  await includeIfExists(skillMdFileName);
  const roots = options.includeScripts ? ['references', 'assets', 'scripts'] : ['references', 'assets'];
  for (const rootName of roots) {
    const root = path.join(skillRoot, rootName);
    try {
      const rootStat = await lstat(root);
      if (rootStat.isSymbolicLink()) {
        throw new Error(`Agent skill resource root "${rootName}" cannot be a symlink`);
      }

      if (!rootStat.isDirectory()) {
        continue;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }

      throw error;
    }

    await walkFiles(root, async filePath => {
      const relativePath = toPosixPath(path.relative(skillRoot, filePath));
      updateHashEntry(hash, relativePath, await readFile(filePath));
    });
  }

  return hash.digest('hex');
}

async function loadSkillInstructions(
  skill: AgentSkillManifest,
  options: Required<Pick<LoadAgentSkillsOptions, 'maxSkillBytes'>>
): Promise<{ instructions: string; truncated: boolean }> {
  const raw = await readFile(path.join(skill.rootDir, skillMdFileName), 'utf8');
  const body = parseSkillMarkdown(raw).body.trim();
  const instructions = truncateToBytes(body, options.maxSkillBytes);
  return {
    instructions,
    truncated: byteLength(body) > byteLength(instructions)
  };
}

function selectSkills(skills: AgentSkillManifest[], context: SystemPromptContext, maxLoadedSkills: number): AgentSkillSelection[] {
  const text = extractSearchText(context).toLowerCase();
  const enabled = readEnabledSkills(context.request.metadata);
  const selections: AgentSkillSelection[] = [];

  for (const skill of skills) {
    const score = scoreSkill(skill, text, enabled);
    if (score.score > 0) {
      selections.push({
        skill,
        score: score.score,
        reason: score.reason
      });
    }
  }

  return selections
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, Math.max(0, maxLoadedSkills));
}

function scoreSkill(
  skill: AgentSkillManifest,
  text: string,
  enabled: EnabledSkillPreferences
): { score: number; reason: string } {
  if (isSkillExplicitlyEnabled(skill, enabled)) {
    return {
      score: 100,
      reason: 'enabled_by_request_metadata'
    };
  }

  const searchable = [
    skill.id,
    skill.name,
    ...(skill.keywords ?? [])
  ];
  for (const term of searchable) {
    if (term && text.includes(term.toLowerCase())) {
      return {
        score: 20,
        reason: `matched_term:${term}`
      };
    }
  }

  const descriptionTerms = tokenize(skill.description);
  const matchedTerms = descriptionTerms.filter(term => text.includes(term));
  if (matchedTerms.length > 0) {
    return {
      score: matchedTerms.length,
      reason: `matched_description:${matchedTerms.slice(0, 3).join(',')}`
    };
  }

  return {
    score: 0,
    reason: 'not_selected'
  };
}

function extractSearchText(context: SystemPromptContext): string {
  return context.request.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content)
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

interface EnabledSkillPreferences {
  legacyNames: Set<string>;
  refsById: Map<string, Set<string>>;
}

function readEnabledSkills(metadata: JsonObject | undefined): EnabledSkillPreferences {
  const raw = metadata?.enabledSkills;
  const legacyNames = new Set(
    Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : []
  );
  const refsById = new Map<string, Set<string>>();
  const skillsMetadata = isJsonObject(metadata?.skills) ? metadata.skills : undefined;
  const rawRefs = Array.isArray(skillsMetadata?.enabled) ? skillsMetadata.enabled : [];
  for (const ref of rawRefs) {
    if (!isJsonObject(ref)) {
      continue;
    }

    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    const digest = typeof ref.digest === 'string' ? ref.digest.trim() : '';
    if (!id || !digest) {
      continue;
    }

    const digests = refsById.get(id) ?? new Set<string>();
    digests.add(digest);
    refsById.set(id, digests);
  }

  return {
    legacyNames,
    refsById
  };
}

function isSkillExplicitlyEnabled(skill: AgentSkillManifest, enabled: EnabledSkillPreferences): boolean {
  if (enabled.legacyNames.has(skill.id) || enabled.legacyNames.has(skill.name)) {
    return true;
  }

  return enabled.refsById.get(skill.id)?.has(skill.digest) ?? false;
}

function parseSkillMarkdown(raw: string): { frontmatter: JsonObject; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('Agent skill SKILL.md must start with YAML frontmatter');
  }

  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex < 0) {
    throw new Error('Agent skill SKILL.md frontmatter is not closed');
  }

  const frontmatterText = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + '\n---\n'.length);
  return {
    frontmatter: parseSimpleYaml(frontmatterText),
    body
  };
}

function parseSimpleYaml(source: string): JsonObject {
  const result: JsonObject = {};
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!keyMatch) {
      throw new Error(`Unsupported SKILL.md frontmatter line: ${line}`);
    }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2]?.trim() ?? '';
    if (!inlineValue) {
      const values: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(next);
        if (!itemMatch) {
          break;
        }

        values.push(stripYamlQuotes(itemMatch[1]));
        index += 1;
      }
      result[key] = values;
      continue;
    }

    result[key] = parseSimpleYamlValue(inlineValue);
  }

  return result;
}

function parseSimpleYamlValue(value: string): JsonValue {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner.split(',').map(item => stripYamlQuotes(item.trim()));
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return stripYamlQuotes(value);
}

function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function readRequiredString(frontmatter: JsonObject, key: string, skillId: string): string {
  const value = frontmatter[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Agent skill "${skillId}" frontmatter must include "${key}"`);
  }

  return value.trim();
}

function readOptionalStringArray(frontmatter: JsonObject, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Agent skill frontmatter "${key}" must be a string array`);
  }

  return value.map(item => item.trim()).filter(Boolean);
}

function readMetadata(frontmatter: JsonObject): JsonObject | undefined {
  const metadata: JsonObject = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'name' || key === 'description' || key === 'keywords') {
      continue;
    }

    metadata[key] = value;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function validatePromptSafeText(value: string, label: string): void {
  if (value.includes('<') || value.includes('>')) {
    throw new Error(`Agent skill ${label} cannot contain angle brackets`);
  }
}

function getSkill(skills: Map<string, AgentSkillManifest>, skillId: string): AgentSkillManifest {
  const skill = skills.get(skillId);
  if (!skill) {
    throw new Error(`Unknown agent skill "${skillId}"`);
  }

  return skill;
}

function resolveSkillResourcePath(skillRoot: string, resourcePath: string): string {
  const normalized = normalizeResourcePath(resourcePath);
  const [rootName] = normalized.split('/');
  if (!allowedResourceRoots.has(rootName)) {
    throw new Error(`Skill resource "${resourcePath}" must be under references/ or assets/`);
  }

  const resolved = path.resolve(skillRoot, ...normalized.split('/'));
  const resolvedRoot = path.resolve(skillRoot);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Skill resource "${resourcePath}" escapes the skill directory`);
  }

  return resolved;
}

function normalizeResourcePath(resourcePath: string): string {
  if (path.isAbsolute(resourcePath)) {
    throw new Error(`Skill resource path "${resourcePath}" cannot be absolute`);
  }

  const parts = resourcePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '..')) {
    throw new Error(`Skill resource path "${resourcePath}" is not allowed`);
  }

  return parts.join('/');
}

function normalizeScriptPath(scriptPath: string): string {
  if (path.isAbsolute(scriptPath)) {
    throw new Error(`Skill script path "${scriptPath}" cannot be absolute`);
  }

  const parts = scriptPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'scripts' || parts.some(part => part === '..')) {
    throw new Error(`Skill script path "${scriptPath}" must stay under scripts/`);
  }

  return parts.join('/');
}

function readToolString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`skill_run_script requires string "${key}"`);
  }

  return value;
}

function createDockerContainerName(runId: string): string {
  const runPart = runId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '');
  return `mido-skill-${runPart || 'run'}-${randomUUID().slice(0, 8)}`;
}

function withDockerContainerName(args: string[], containerName: string): string[] {
  if (args[0] !== 'run') {
    return args;
  }

  return [
    'run',
    '--name',
    containerName,
    ...args.slice(1)
  ];
}

async function cleanupDockerContainer(dockerBinary: string, containerName: string): Promise<void> {
  await runDockerCleanupCommand(dockerBinary, ['kill', containerName]);
  await runDockerCleanupCommand(dockerBinary, ['rm', '-f', containerName]);
}

function runDockerCleanupCommand(dockerBinary: string, args: string[]): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(dockerBinary, args, {
      stdio: 'ignore'
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('error', done);
    child.on('close', done);
  });
}

async function settleAfterCleanup(cleanupPromise: Promise<void> | undefined, settle: () => void): Promise<void> {
  if (cleanupPromise) {
    await cleanupPromise.catch(() => {});
  }

  settle();
}

function updateHashEntry(hash: ReturnType<typeof createHash>, relativePath: string, contents: Buffer): void {
  hash.update('entry');
  hash.update('\0');
  hash.update(String(Buffer.byteLength(relativePath, 'utf8')));
  hash.update('\0');
  hash.update(relativePath);
  hash.update('\0');
  hash.update(String(contents.byteLength));
  hash.update('\0');
  hash.update(contents);
  hash.update('\0');
}

function normalizeMaxScriptTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : defaultScriptTimeoutMs;
}

function clampScriptTimeoutMs(timeoutMs: number | undefined, maxTimeoutMs: number): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  const normalizedMax = normalizeMaxScriptTimeoutMs(maxTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return normalizedMax;
  }

  return Math.min(timeoutMs, normalizedMax);
}

function appendCapped(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
  if (byteLength(current) >= maxBytes) {
    return {
      value: current,
      truncated: true
    };
  }

  const remaining = maxBytes - byteLength(current);
  const nextChunk = truncateToBytes(chunk, remaining);
  return {
    value: current + nextChunk,
    truncated: nextChunk.length < chunk.length
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactJsonObject(values: Record<string, JsonValue | undefined>): JsonObject {
  const compacted: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }

  return compacted;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 4))];
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  if (byteLength(text) <= maxBytes) {
    return text;
  }

  let end = text.length;
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) {
    end -= 1;
  }

  return text.slice(0, end).trimEnd();
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

async function emitAudit(sink: AgentSkillAuditSink | undefined, event: AgentSkillAuditEvent): Promise<void> {
  if (sink) {
    await sink(event);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}
