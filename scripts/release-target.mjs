#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const semverPattern = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;

const targets = {
  'protocol-core': {
    kind: 'npm',
    packageName: '@mido-agent/protocol-core',
    packagePath: 'packages/protocol-core',
    tagPrefix: 'protocol-core-v'
  },
  'protocol-agui': {
    kind: 'npm',
    packageName: '@mido-agent/protocol-agui',
    packagePath: 'packages/protocol-agui',
    tagPrefix: 'protocol-agui-v'
  },
  'mcp-core': {
    kind: 'npm',
    packageName: '@mido-agent/mcp-core',
    packagePath: 'packages/mcp-core',
    tagPrefix: 'mcp-core-v'
  },
  'server-sdk': {
    kind: 'npm',
    packageName: '@mido-agent/server-sdk',
    packagePath: 'packages/server-sdk',
    tagPrefix: 'server-sdk-v'
  },
  'client-core': {
    kind: 'npm',
    packageName: '@mido-agent/client-core',
    packagePath: 'packages/client-core',
    tagPrefix: 'client-core-v'
  },
  'client-web': {
    kind: 'npm',
    packageName: '@mido-agent/client-web',
    packagePath: 'packages/client-web',
    tagPrefix: 'client-web-v'
  },
  'toolkit-core': {
    kind: 'npm',
    packageName: '@mido-agent/toolkit-core',
    packagePath: 'packages/toolkit-core',
    tagPrefix: 'toolkit-core-v'
  },
  conformance: {
    kind: 'npm',
    packageName: '@mido-agent/conformance',
    packagePath: 'packages/conformance',
    tagPrefix: 'conformance-v'
  },
  evaluator: {
    kind: 'npm',
    packageName: '@mido-agent/evaluator',
    packagePath: 'packages/evaluator',
    tagPrefix: 'evaluator-v'
  },
  'client-ios': {
    kind: 'swift',
    packageName: 'MidoClient',
    packagePath: 'packages/client-ios',
    tagPrefix: 'v'
  }
};

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readRootVersion() {
  return parseJson(join(repoRoot, 'package.json')).version;
}

function assertSemver(version) {
  if (!new RegExp(`^${semverPattern}$`).test(version)) {
    throw new Error(`Expected a SemVer version, received "${version}"`);
  }
}

function targetTag(target, version) {
  const config = targets[target];
  if (!config) {
    throw new Error(`Unknown release target "${target}"`);
  }
  return `${config.tagPrefix}${version}`;
}

function parseTag(tag) {
  const swiftMatch = tag.match(new RegExp(`^v(${semverPattern})$`));
  if (swiftMatch) {
    return { target: 'client-ios', version: swiftMatch[1] };
  }

  for (const [target, config] of Object.entries(targets)) {
    if (config.kind !== 'npm') {
      continue;
    }
    const match = tag.match(new RegExp(`^${config.tagPrefix}(${semverPattern})$`));
    if (match) {
      return { target, version: match[1] };
    }
  }

  throw new Error(`Unsupported release tag "${tag}"`);
}

function resolveRelease(args) {
  if (args.length === 1) {
    return parseTag(args[0]);
  }

  if (args.length === 2) {
    const [target, version] = args;
    if (!targets[target]) {
      throw new Error(`Unknown release target "${target}"`);
    }
    assertSemver(version);
    return { target, version };
  }

  throw new Error('Usage: node scripts/release-target.mjs <resolve|verify> <tag|target version>');
}

function verifyVersion(target, version) {
  const config = targets[target];
  if (!config) {
    throw new Error(`Unknown release target "${target}"`);
  }
  assertSemver(version);

  const rootVersion = readRootVersion();
  if (rootVersion !== version) {
    throw new Error(`Root package version is ${rootVersion}, expected ${version}`);
  }

  if (config.kind === 'npm') {
    const packageJson = parseJson(join(repoRoot, config.packagePath, 'package.json'));
    if (packageJson.name !== config.packageName) {
      throw new Error(`${config.packagePath}/package.json name is ${packageJson.name}, expected ${config.packageName}`);
    }
    if (packageJson.version !== version) {
      throw new Error(`${config.packageName} version is ${packageJson.version}, expected ${version}`);
    }
    return;
  }

  const versionSwift = readFileSync(join(repoRoot, 'packages/client-ios/Sources/MidoClient/Version.swift'), 'utf8');
  const sdkVersion = versionSwift.match(/sdk = "([^"]+)"/)?.[1];
  if (sdkVersion !== version) {
    throw new Error(`MidoSDKVersion.sdk is ${sdkVersion ?? 'missing'}, expected ${version}`);
  }
}

function releaseInfo(target, version) {
  const config = targets[target];
  verifyVersion(target, version);

  return {
    target,
    version,
    kind: config.kind,
    package_name: config.packageName,
    package_path: config.packagePath,
    tag: targetTag(target, version),
    npm_filter: config.kind === 'npm' ? config.packageName : ''
  };
}

function writeGitHubOutput(info) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(info).map(([key, value]) => `${key}=${value}`);
  const outputPath = process.env.GITHUB_OUTPUT;
  const existing = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(outputPath, `${prefix}${lines.join('\n')}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'list') {
    console.log(JSON.stringify(targets, null, 2));
    return;
  }

  if (command !== 'resolve' && command !== 'verify') {
    throw new Error('Usage: node scripts/release-target.mjs <list|resolve|verify> <tag|target version>');
  }

  const { target, version } = resolveRelease(args);
  const info = releaseInfo(target, version);

  if (command === 'resolve') {
    writeGitHubOutput(info);
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`Release target ${info.target} ${info.version} verified`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
