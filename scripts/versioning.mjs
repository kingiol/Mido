#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const protocolVersion = 'mido.protocol.v1';
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const files = {
  rootPackageJson: join(repoRoot, 'package.json'),
  protocolVersionTs: join(repoRoot, 'packages/protocol-core/src/version.ts'),
  swiftVersion: join(repoRoot, 'packages/client-ios/Sources/MidoClient/Version.swift')
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  const contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const trailingNewlines = contents.match(/\n*$/)?.[0] || '\n';
  writeFileSync(path, `${JSON.stringify(value, null, 2)}${trailingNewlines || '\n'}`);
}

function workspacePackageJsonPaths() {
  const packagesDir = join(repoRoot, 'packages');
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(packagesDir, entry.name, 'package.json'))
    .filter(path => existsSync(path))
    .sort();
}

function rootVersion() {
  return readJson(files.rootPackageJson).version;
}

function assertSemver(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`Expected a SemVer version, received "${version}"`);
  }
}

function writeVersionFiles(version) {
  writeFileSync(
    files.protocolVersionTs,
    `export const MIDO_SDK_VERSION = '${version}';\nexport const MIDO_PROTOCOL_VERSION = '${protocolVersion}';\n`
  );

  writeFileSync(
    files.swiftVersion,
    `public enum MidoSDKVersion {\n  public static let sdk = "${version}"\n  public static let proto = "${protocolVersion}"\n}\n`
  );
}

function setVersion(version) {
  assertSemver(version);

  const rootPackage = readJson(files.rootPackageJson);
  rootPackage.version = version;
  writeJson(files.rootPackageJson, rootPackage);

  for (const packageJsonPath of workspacePackageJsonPaths()) {
    const packageJson = readJson(packageJsonPath);
    packageJson.version = version;
    writeJson(packageJsonPath, packageJson);
  }

  writeVersionFiles(version);
  console.log(`Set Mido SDK version to ${version}`);
}

function extractSingleMatch(path, pattern, label) {
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${label} in ${path}`);
  }
  return match[1];
}

function checkVersion() {
  const expected = rootVersion();
  assertSemver(expected);

  const errors = [];

  for (const packageJsonPath of workspacePackageJsonPaths()) {
    const packageJson = readJson(packageJsonPath);
    if (packageJson.version !== expected) {
      errors.push(`${packageJsonPath} has version ${packageJson.version}, expected ${expected}`);
    }
  }

  const tsSdkVersion = extractSingleMatch(
    files.protocolVersionTs,
    /MIDO_SDK_VERSION = '([^']+)'/,
    'MIDO_SDK_VERSION'
  );
  const tsProtocolVersion = extractSingleMatch(
    files.protocolVersionTs,
    /MIDO_PROTOCOL_VERSION = '([^']+)'/,
    'MIDO_PROTOCOL_VERSION'
  );
  const swiftSdkVersion = extractSingleMatch(
    files.swiftVersion,
    /sdk = "([^"]+)"/,
    'MidoSDKVersion.sdk'
  );
  const swiftProtocolVersion = extractSingleMatch(
    files.swiftVersion,
    /proto = "([^"]+)"/,
    'MidoSDKVersion.proto'
  );

  if (tsSdkVersion !== expected) {
    errors.push(`${files.protocolVersionTs} has SDK version ${tsSdkVersion}, expected ${expected}`);
  }
  if (swiftSdkVersion !== expected) {
    errors.push(`${files.swiftVersion} has SDK version ${swiftSdkVersion}, expected ${expected}`);
  }
  if (tsProtocolVersion !== protocolVersion) {
    errors.push(`${files.protocolVersionTs} has protocol version ${tsProtocolVersion}, expected ${protocolVersion}`);
  }
  if (swiftProtocolVersion !== protocolVersion) {
    errors.push(`${files.swiftVersion} has protocol version ${swiftProtocolVersion}, expected ${protocolVersion}`);
  }

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }

  console.log(`Mido SDK version check passed for ${expected}`);
}

const [command, version] = process.argv.slice(2);

if (command === 'set' && version) {
  setVersion(version);
} else if (command === 'check') {
  checkVersion();
} else {
  console.error('Usage: node scripts/versioning.mjs <set <semver>|check>');
  process.exitCode = 1;
}
