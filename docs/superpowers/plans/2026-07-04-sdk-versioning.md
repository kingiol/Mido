# SDK Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lockstep SDK versioning system so TypeScript and Swift SDK consumers can identify compatible Mido releases.

**Architecture:** Keep the root `package.json.version` as the SDK version source of truth, generate checked-in TypeScript and Swift runtime constants from it, and verify package/version drift with a repo-local Node script. Use Git tags plus a root Swift package wrapper for Swift Package Manager, while keeping the existing `packages/client-ios` package usable for local development.

**Tech Stack:** TypeScript, Swift 6, pnpm workspaces, Node.js ESM scripts, Vitest, Swift Package Manager, GitHub Actions.

## Global Constraints

- Use lockstep SemVer across all public Mido SDK packages in this pass.
- Keep `package.json.version` at the repository root as the canonical SDK version source.
- Keep `MIDO_PROTOCOL_VERSION` fixed at `mido.protocol.v1`.
- Do not introduce independent per-package versioning.
- Do not change the wire protocol shape only to add versioning.
- Do not add a runtime dependency for version management.
- Keep `packages/client-ios/Package.swift` working for local Swift package tests.
- Add a root `Package.swift` wrapper for versioned Swift Package Manager consumers.
- Do not bump the SDK version number as part of this implementation; a release owner should run `pnpm version:set <semver>` when choosing the next release.

---

## File Structure

- Create `packages/protocol-core/src/version.ts`: TypeScript runtime version constants.
- Create `packages/client-ios/Sources/MidoClient/Version.swift`: Swift runtime version constants.
- Create `packages/client-ios/Tests/MidoClientTests/VersionTests.swift`: Swift version constant test.
- Create `tests/sdk-version.test.ts`: TypeScript version export and manifest consistency tests.
- Create `Package.swift`: root Swift package wrapper for versioned repository tags.
- Create `scripts/versioning.mjs`: version set/check script.
- Create `.github/workflows/release-check.yml`: release validation workflow.
- Create `.github/workflows/publish-sdk.yml`: target tag driven SDK publish workflow.
- Create `scripts/release-target.mjs`: map Git tags to SDK release targets.
- Modify `package.json`: add `version:set`, `version:check`, and `release:check` scripts.
- Modify each public package entrypoint to export `MIDO_SDK_VERSION` and `MIDO_PROTOCOL_VERSION`.
- Modify `packages/mcp-core/src/index.ts`: use `MIDO_SDK_VERSION` as the default MCP client version.
- Modify `README.md`: document versioned npm and Swift installation plus compatibility matrix.

### Task 1: Runtime Version Constants

**Files:**
- Create: `packages/protocol-core/src/version.ts`
- Create: `packages/client-ios/Sources/MidoClient/Version.swift`
- Create: `packages/client-ios/Tests/MidoClientTests/VersionTests.swift`
- Create: `tests/sdk-version.test.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Modify: `packages/protocol-agui/src/index.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `packages/client-web/src/index.tsx`
- Modify: `packages/toolkit-core/src/index.ts`
- Modify: `packages/conformance/src/index.ts`
- Modify: `packages/evaluator/src/index.ts`

**Interfaces:**
- Consumes: root `package.json.version`
- Produces: `MIDO_SDK_VERSION: string`, `MIDO_PROTOCOL_VERSION: 'mido.protocol.v1'`, `MidoSDKVersion.sdk`, `MidoSDKVersion.proto`

- [ ] **Step 1: Write the failing TypeScript version export test**

Create `tests/sdk-version.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIDO_PROTOCOL_VERSION as aguiProtocolVersion,
  MIDO_SDK_VERSION as aguiSdkVersion
} from '@mido/protocol-agui';
import {
  MIDO_PROTOCOL_VERSION as clientCoreProtocolVersion,
  MIDO_SDK_VERSION as clientCoreSdkVersion
} from '@mido/client-core';
import {
  MIDO_PROTOCOL_VERSION as clientWebProtocolVersion,
  MIDO_SDK_VERSION as clientWebSdkVersion
} from '@mido/client-web';
import {
  MIDO_PROTOCOL_VERSION as conformanceProtocolVersion,
  MIDO_SDK_VERSION as conformanceSdkVersion
} from '@mido/conformance';
import {
  MIDO_PROTOCOL_VERSION as evaluatorProtocolVersion,
  MIDO_SDK_VERSION as evaluatorSdkVersion
} from '@mido/evaluator';
import {
  MIDO_PROTOCOL_VERSION as mcpProtocolVersion,
  MIDO_SDK_VERSION as mcpSdkVersion
} from '@mido/mcp-core';
import {
  MIDO_PROTOCOL_VERSION,
  MIDO_SDK_VERSION
} from '@mido/protocol-core';
import {
  MIDO_PROTOCOL_VERSION as serverProtocolVersion,
  MIDO_SDK_VERSION as serverSdkVersion
} from '@mido/server-sdk';
import {
  MIDO_PROTOCOL_VERSION as toolkitProtocolVersion,
  MIDO_SDK_VERSION as toolkitSdkVersion
} from '@mido/toolkit-core';

const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };

describe('SDK version exports', () => {
  it('exports the root SDK version from every public TypeScript package', () => {
    expect([
      MIDO_SDK_VERSION,
      aguiSdkVersion,
      clientCoreSdkVersion,
      clientWebSdkVersion,
      conformanceSdkVersion,
      evaluatorSdkVersion,
      mcpSdkVersion,
      serverSdkVersion,
      toolkitSdkVersion
    ]).toEqual(Array(9).fill(rootPackageJson.version));
  });

  it('exports the stable protocol version from every public TypeScript package', () => {
    expect([
      MIDO_PROTOCOL_VERSION,
      aguiProtocolVersion,
      clientCoreProtocolVersion,
      clientWebProtocolVersion,
      conformanceProtocolVersion,
      evaluatorProtocolVersion,
      mcpProtocolVersion,
      serverProtocolVersion,
      toolkitProtocolVersion
    ]).toEqual(Array(9).fill('mido.protocol.v1'));
  });
});
```

- [ ] **Step 2: Run the TypeScript test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/sdk-version.test.ts
```

Expected: FAIL with missing export errors for `MIDO_SDK_VERSION` and `MIDO_PROTOCOL_VERSION`.

- [ ] **Step 3: Write the failing Swift version test**

Create `packages/client-ios/Tests/MidoClientTests/VersionTests.swift`:

```swift
import Testing
@testable import MidoClient

@Suite("SDK version")
struct VersionTests {
  @Test("exports SDK and protocol version constants")
  func exportsVersionConstants() {
    #expect(MidoSDKVersion.sdk == "0.1.0")
    #expect(MidoSDKVersion.proto == "mido.protocol.v1")
  }
}
```

- [ ] **Step 4: Run the Swift test to verify it fails**

Run:

```bash
swift test --package-path packages/client-ios --filter VersionTests
```

Expected: FAIL with `cannot find 'MidoSDKVersion' in scope`.

- [ ] **Step 5: Add TypeScript version constants**

Create `packages/protocol-core/src/version.ts`:

```ts
export const MIDO_SDK_VERSION = '0.1.0';
export const MIDO_PROTOCOL_VERSION = 'mido.protocol.v1';
```

Add this export near the top of `packages/protocol-core/src/index.ts`:

```ts
export { MIDO_PROTOCOL_VERSION, MIDO_SDK_VERSION } from './version.js';
```

- [ ] **Step 6: Re-export version constants from public TypeScript packages**

Add this export to each file listed below:

```ts
export { MIDO_PROTOCOL_VERSION, MIDO_SDK_VERSION } from '@mido/protocol-core';
```

Files:

```text
packages/protocol-agui/src/index.ts
packages/mcp-core/src/index.ts
packages/server-sdk/src/index.ts
packages/client-core/src/index.ts
packages/client-web/src/index.tsx
packages/toolkit-core/src/index.ts
packages/conformance/src/index.ts
packages/evaluator/src/index.ts
```

- [ ] **Step 7: Use the SDK version as the default MCP client version**

In `packages/mcp-core/src/index.ts`, change the protocol-core import to include `MIDO_SDK_VERSION`:

```ts
import { MIDO_SDK_VERSION, nowIso, stableStringify, type JsonObject, type JsonValue, type JSONSchema } from '@mido/protocol-core';
```

Then replace:

```ts
const DEFAULT_CLIENT_VERSION = '0.1.0';
```

with:

```ts
const DEFAULT_CLIENT_VERSION = MIDO_SDK_VERSION;
```

- [ ] **Step 8: Add Swift version constants**

Create `packages/client-ios/Sources/MidoClient/Version.swift`:

```swift
public enum MidoSDKVersion {
  public static let sdk = "0.1.0"
  public static let proto = "mido.protocol.v1"
}
```

- [ ] **Step 9: Run tests to verify the task passes**

Run:

```bash
pnpm exec vitest run tests/sdk-version.test.ts
```

Expected: PASS.

Run:

```bash
swift test --package-path packages/client-ios --filter VersionTests
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/protocol-core/src/version.ts packages/protocol-core/src/index.ts packages/protocol-agui/src/index.ts packages/mcp-core/src/index.ts packages/server-sdk/src/index.ts packages/client-core/src/index.ts packages/client-web/src/index.tsx packages/toolkit-core/src/index.ts packages/conformance/src/index.ts packages/evaluator/src/index.ts packages/client-ios/Sources/MidoClient/Version.swift packages/client-ios/Tests/MidoClientTests/VersionTests.swift tests/sdk-version.test.ts
git commit -m "feat: expose SDK version constants"
```

### Task 2: Root Swift Package Wrapper

**Files:**
- Create: `Package.swift`

**Interfaces:**
- Consumes: existing `packages/client-ios/Sources/MidoClient` and `packages/client-ios/Tests/MidoClientTests`
- Produces: root-level Swift Package Manager manifest for tag-based consumers

- [ ] **Step 1: Verify the root Swift package is currently absent**

Run:

```bash
swift package describe --type json
```

Expected: FAIL with a package manifest not found error.

- [ ] **Step 2: Add the root Swift package manifest**

Create `Package.swift` at the repository root:

```swift
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "Mido",
  platforms: [
    .iOS(.v15),
    .macOS(.v13)
  ],
  products: [
    .library(
      name: "MidoClient",
      targets: ["MidoClient"]
    )
  ],
  targets: [
    .target(
      name: "MidoClient",
      path: "packages/client-ios/Sources/MidoClient"
    ),
    .testTarget(
      name: "MidoClientTests",
      dependencies: ["MidoClient"],
      path: "packages/client-ios/Tests/MidoClientTests"
    )
  ],
  swiftLanguageModes: [.v6]
)
```

- [ ] **Step 3: Verify the root Swift package resolves**

Run:

```bash
swift package describe --type json
```

Expected: PASS and JSON output containing `"name" : "Mido"`.

Run:

```bash
swift test
```

Expected: PASS for the root package wrapper.

Run:

```bash
swift test --package-path packages/client-ios
```

Expected: PASS for the existing nested package.

- [ ] **Step 4: Commit**

```bash
git add Package.swift
git commit -m "feat: add root Swift package wrapper"
```

### Task 3: Version Set And Check Script

**Files:**
- Create: `scripts/versioning.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: root `package.json.version`
- Produces: `pnpm version:set <semver>`, `pnpm version:check`, `pnpm release:check`

- [ ] **Step 1: Verify the check command is missing**

Run:

```bash
pnpm version:check
```

Expected: FAIL with `Missing script: version:check`.

- [ ] **Step 2: Add the versioning script**

Create `scripts/versioning.mjs`:

```js
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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
```

- [ ] **Step 3: Add package scripts**

Modify the root `package.json` scripts object to include:

```json
"version:set": "node scripts/versioning.mjs set",
"version:check": "node scripts/versioning.mjs check",
"release:check": "pnpm version:check && pnpm lint && pnpm test && pnpm build && swift package describe --type json >/dev/null && swift test --package-path packages/client-ios"
```

- [ ] **Step 4: Verify version check passes**

Run:

```bash
pnpm version:check
```

Expected: PASS with `Mido SDK version check passed for 0.1.0`.

- [ ] **Step 5: Verify version set is idempotent for the current version**

Run:

```bash
pnpm version:set 0.1.0
```

Expected: PASS with `Set Mido SDK version to 0.1.0`.

Run:

```bash
pnpm version:check
```

Expected: PASS with `Mido SDK version check passed for 0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/versioning.mjs package.json packages/*/package.json packages/protocol-core/src/version.ts packages/client-ios/Sources/MidoClient/Version.swift
git commit -m "feat: add SDK version management script"
```

### Task 4: Versioned Installation Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: public package names and root Swift package wrapper from earlier tasks
- Produces: third-party installation guidance and compatibility matrix

- [ ] **Step 1: Add a versioned installation section**

Add this section before `## Core design` in `README.md`:

````md
## Versioned installation

Use the same Mido SDK version across server and client packages unless the compatibility matrix says otherwise.

```bash
pnpm add @mido/server-sdk@0.1.0 @mido/client-core@0.1.0
pnpm add @mido/client-web@0.1.0
```

For Swift Package Manager, depend on a repository tag:

```swift
.package(url: "https://github.com/kingiol/Mido.git", from: "0.1.0")
```

Use `main` only for local development or testing unreleased changes.

| Mido SDK | Protocol | Server SDK | Web Client | iOS Client |
| --- | --- | --- | --- | --- |
| `0.1.x` | `mido.protocol.v1` | `0.1.x` | `0.1.x` | `0.1.x` |
````

- [ ] **Step 2: Update the iOS Swift Package section**

Replace this snippet in `README.md`:

```swift
// Package.swift
.package(url: "https://github.com/kingiol/Mido.git", branch: "main")
```

with:

```swift
// Package.swift
.package(url: "https://github.com/kingiol/Mido.git", from: "0.1.0")
```

Add this sentence after the snippet:

```md
For unreleased development builds, use `branch: "main"` only when you intentionally want the latest repository state instead of a tagged SDK release.
```

- [ ] **Step 3: Verify README no longer recommends `main` as the default**

Run:

```bash
rg -n 'branch: "main"|Versioned installation|mido.protocol.v1' README.md
```

Expected: output includes `Versioned installation` and `mido.protocol.v1`; any `branch: "main"` mention is explicitly described as development-only.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document SDK versioned installation"
```

### Task 5: Release Check And Publish Workflows

**Files:**
- Create: `.github/workflows/release-check.yml`
- Create: `.github/workflows/publish-sdk.yml`
- Create: `scripts/release-target.mjs`
- Create: `tests/release-target.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `pnpm release:check`
- Produces: a CI workflow that validates version consistency, TypeScript checks, test suite, builds, and Swift package tests; a publish workflow that maps target tags to SDK publish jobs

- [ ] **Step 1: Verify the workflow is absent**

Run:

```bash
test ! -f .github/workflows/release-check.yml
```

Expected: PASS.

- [ ] **Step 2: Add the release check workflow**

Create `.github/workflows/release-check.yml`:

```yaml
name: Release Check

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  release-check:
    runs-on: macos-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Enable Corepack
        run: corepack enable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run release check
        run: pnpm release:check
```

- [ ] **Step 3: Run local release check**

Run:

```bash
pnpm release:check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-check.yml package.json
git commit -m "ci: add SDK release check workflow"
```

- [ ] **Step 5: Add target-driven publish workflow**

Create `.github/workflows/publish-sdk.yml` so these tags publish one SDK at a time:

```text
server-sdk-v0.2.0 -> @mido/server-sdk
client-web-v0.2.0 -> @mido/client-web
v0.2.0 -> MidoClient Swift Package
```

The iOS tag must stay SemVer-compatible because Swift Package Manager resolves `from:` dependencies from SemVer Git tags.

### Task 6: Final Versioning Validation

**Files:**
- Read: `package.json`
- Read: `packages/*/package.json`
- Read: `packages/protocol-core/src/version.ts`
- Read: `packages/client-ios/Sources/MidoClient/Version.swift`
- Read: `README.md`

**Interfaces:**
- Consumes: all earlier tasks
- Produces: final verification evidence

- [ ] **Step 1: Run version check**

Run:

```bash
pnpm version:check
```

Expected: PASS with `Mido SDK version check passed for 0.1.0`.

- [ ] **Step 2: Run TypeScript version tests**

Run:

```bash
pnpm exec vitest run tests/sdk-version.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Swift version tests through both manifests**

Run:

```bash
swift test --package-path packages/client-ios --filter VersionTests
```

Expected: PASS.

Run:

```bash
swift test --filter VersionTests
```

Expected: PASS.

- [ ] **Step 4: Run full release check**

Run:

```bash
pnpm release:check
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only the files listed in this plan are changed, unless the release check generated ignored build artifacts.

- [ ] **Step 6: Commit verification note if docs changed during validation**

If validation causes README or workflow corrections, commit them:

```bash
git add README.md .github/workflows/release-check.yml package.json
git commit -m "docs: refine SDK versioning release checks"
```

## Self-Review

- Spec coverage: the plan implements lockstep SDK versioning, generated runtime constants, Swift tag support through a root manifest, version drift checks, release validation, and README compatibility guidance.
- Placeholder scan: the plan contains concrete paths, commands, expected results, and code blocks for every implementation step.
- Type consistency: TypeScript uses `MIDO_SDK_VERSION` and `MIDO_PROTOCOL_VERSION`; Swift uses `MidoSDKVersion.sdk` and `MidoSDKVersion.proto`; the version script writes those exact names.
