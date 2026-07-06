import { spawn } from 'node:child_process';

import type { JsonObject, JsonValue } from '@mido-agent/protocol-core';

import { createTool } from '../tool.js';
import type { CreateWorkspaceToolsOptions, ToolkitToolDefinition } from '../types.js';
import { isJsonObject, readOptionalNumber, readOptionalString, readOptionalStringArray, readRequiredString } from '../validation.js';
import { resolveExistingWorkspacePath, type WorkspaceRoot } from './paths.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 128_000;

export function createWorkspaceCommandTool(roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): ToolkitToolDefinition {
  const policy = options.executionPolicy ?? {};

  return createTool({
    name: 'workspace_run_command',
    description: 'Run an allowlisted command in an allowed workspace root.',
    executionPolicy: policy.execute ?? 'client_interactive',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable command name or path. It must be allowed by commandAllowlist when configured.' },
        args: {
          type: 'array',
          description: 'Command-line arguments passed to the executable without shell expansion.',
          items: { type: 'string', description: 'Single command-line argument.' }
        },
        cwd: { type: 'string', description: 'Workspace-relative directory to run in. Defaults to the workspace root.' },
        root: { type: 'string', description: 'Optional workspace root path or name when multiple roots are available.' },
        timeoutMs: { type: 'number', description: 'Maximum command runtime in milliseconds. Defaults to the configured command timeout.' },
        env: {
          type: 'object',
          description: 'Additional environment variables allowed by envAllowlist when configured.',
          additionalProperties: { type: 'string' }
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    policy: { risk: 'high', effects: ['execute'], scopes: ['workspace:command:run'] },
    timeoutMs: options.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    execute: async args => runWorkspaceCommand(args, roots, options)
  });
}

async function runWorkspaceCommand(args: JsonObject, roots: WorkspaceRoot[], options: CreateWorkspaceToolsOptions): Promise<JsonObject> {
  const command = readRequiredString(args.command, 'command');
  const commandArgs = readOptionalStringArray(args.args, 'args') ?? [];
  const allowlist = options.commandAllowlist;
  if (allowlist && !allowlist.includes(command)) {
    throw new Error(`Command "${command}" is not in commandAllowlist`);
  }

  const cwdArgs: JsonObject = { path: readOptionalString(args.cwd, 'cwd') ?? '.' };
  const root = readOptionalString(args.root, 'root');
  if (root !== undefined) {
    cwdArgs.root = root;
  }
  const cwd = await resolveExistingWorkspacePath(cwdArgs, roots);
  const timeoutMs = readOptionalNumber(args.timeoutMs, 'timeoutMs') ?? options.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxCommandOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  const env = createAllowedEnv(args.env, options.envAllowlist);

  return new Promise<JsonObject>((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: cwd.realPath,
      env: { ...process.env, ...env },
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, chunk.toString(), maxOutputBytes);
    });
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, chunk.toString(), maxOutputBytes);
    });
    child.on('error', reject);
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolvePromise({
        command,
        args: commandArgs,
        cwd: cwd.relativePath,
        exitCode,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated: Buffer.byteLength(stdout, 'utf8') >= maxOutputBytes,
        stderrTruncated: Buffer.byteLength(stderr, 'utf8') >= maxOutputBytes
      });
    });
  });
}

function createAllowedEnv(value: JsonValue | undefined, allowlist: string[] | undefined): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new Error('env must be an object');
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') {
      throw new Error(`env.${key} must be a string`);
    }
    if (allowlist && !allowlist.includes(key)) {
      throw new Error(`env.${key} is not in envAllowlist`);
    }

    env[key] = rawValue;
  }
  return env;
}

function appendLimited(current: string, next: string, maxBytes: number): string {
  const combined = `${current}${next}`;
  const buffer = Buffer.from(combined, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return combined;
  }

  return buffer.subarray(0, maxBytes).toString('utf8');
}
