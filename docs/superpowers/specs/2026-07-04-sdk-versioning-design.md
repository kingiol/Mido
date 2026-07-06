# SDK Versioning Design

## Goal

Mido needs a predictable versioning and release model so third-party developers can install compatible server, web, native, protocol, and tooling SDKs without guessing which package versions work together.

The first versioning pass should make release identity explicit, keep cross-SDK compatibility easy to understand, and avoid introducing package-level independence before the protocol and public surface are stable.

## Current Context

- The repository is a pnpm workspace with public TypeScript packages under `packages/*`.
- Each TypeScript package currently has `"version": "0.1.0"` in its own `package.json`.
- The iOS SDK is a Swift Package under `packages/client-ios`; Swift Package Manager derives library versions from Git tags, not from `Package.swift`.
- The README currently shows iOS installation from the `main` branch, which is useful during development but weak for third-party production integration.
- There is no existing release automation, changelog system, or version consistency check.

## Non-Goals

- Do not split the iOS SDK into a separate repository in this pass.
- Do not introduce independent per-package versioning yet.
- Do not change the wire protocol shape only to add versioning.
- Do not publish packages automatically from local developer machines without CI checks.
- Do not make the client SDK responsible for authentication, tenant identity, or server policy.

## Recommended Approach

Use lockstep SemVer across all public Mido SDK packages for the initial external release path.

All public packages should share the same release version:

- `@mido-agent/protocol-core`
- `@mido-agent/protocol-agui`
- `@mido-agent/mcp-core`
- `@mido-agent/server-sdk`
- `@mido-agent/client-core`
- `@mido-agent/client-web`
- `@mido-agent/toolkit-core`
- `@mido-agent/conformance`
- `@mido-agent/evaluator`
- `MidoClient` Swift Package

This keeps the third-party rule simple: use the same Mido version across server and client SDKs unless the compatibility matrix says otherwise.

## Version Model

Mido should track three related but distinct versions.

| Version | Example | Owner | Changes When |
| --- | --- | --- | --- |
| SDK version | `0.2.0` | Release process | A package release is cut |
| Protocol version | `mido.protocol.v1` | `@mido-agent/protocol-core` | The wire contract changes incompatibly |
| Schema/artifact version | `mido.run-artifact.v1` | Feature-specific packages | Stored or generated artifact shape changes |

The SDK version answers "which package release am I using?"

The protocol version answers "can this client and server speak the same wire contract?"

The schema/artifact version answers "can this saved artifact be parsed by this SDK?"

## Version Source Of Truth

Use the root `package.json.version` as the canonical SDK version source for this repository.

Reasons:

- It already exists.
- It is easy for npm-oriented release tools to update.
- It avoids adding a second top-level `VERSION` file that can drift.
- It lets a single consistency script verify every package manifest against the root version.

Generated runtime constants should be checked into source so packages expose the release identity after build:

```ts
export const MIDO_SDK_VERSION = '0.2.0';
export const MIDO_PROTOCOL_VERSION = 'mido.protocol.v1';
```

```swift
public enum MidoSDKVersion {
  public static let sdk = "0.2.0"
  public static let proto = "mido.protocol.v1"
}
```

## Release Tags

Use target-specific Git tags to publish one SDK at a time through GitHub Actions.

```text
server-sdk-v0.2.0
client-web-v0.2.0
v0.2.0
```

For npm packages, tags use `<target>-v<semver>` and publish the matching package.

For Swift Package Manager, the iOS SDK must keep a SemVer-compatible tag:

```swift
.package(url: "https://github.com/kingiol/Mido.git", from: "0.2.0")
```

The publish workflow should therefore treat `v0.2.0` as the `MidoClient` release tag. Custom Swift tags such as `client-ios-v0.2.0` are not suitable for third-party `from:` dependencies because SwiftPM resolves package versions from SemVer-compatible Git tags.

Because the Swift package currently lives under `packages/client-ios`, this design should add a root `Package.swift` wrapper that exposes `MidoClient` from the existing source path. That lets SPM users depend on the repository root tag without requiring a separate iOS repository.

## Tooling

Add small repo-local scripts before introducing heavier automation:

- `pnpm version:set <semver>` updates the root package version, all workspace package versions, and generated runtime version files.
- `pnpm version:check` verifies that all package versions and generated constants match the root version.
- `pnpm release:check` runs `version:check`, `pnpm lint`, `pnpm test`, `pnpm build`, and `swift test --package-path packages/client-ios`.
- `scripts/release-target.mjs` maps release tags to SDK targets and verifies that the requested target version matches the checked-in source version.

After the local versioning loop is stable, add Changesets for changelog and npm publishing.

Changesets should run in fixed/lockstep mode for `@mido-agent/*` packages. The evaluator and toolkit packages can move to independent versioning later if they become meaningfully decoupled.

## Documentation Changes

The README should make versioned installation the default:

```bash
pnpm add @mido-agent/server-sdk@0.2.0 @mido-agent/client-core@0.2.0
```

```swift
.package(url: "https://github.com/kingiol/Mido.git", from: "0.2.0")
```

Add a short compatibility table:

| Mido SDK | Protocol | Server SDK | Web Client | iOS Client |
| --- | --- | --- | --- | --- |
| `0.2.x` | `mido.protocol.v1` | `0.2.x` | `0.2.x` | `0.2.x` |

The docs should also state that `main` branch installation is for development only.

## Validation

The versioning work is done when:

- Every public TypeScript package version matches the root package version.
- Every generated TypeScript and Swift version constant matches the root package version.
- The root Swift package wrapper can be resolved by `swift package describe`.
- GitHub Actions can resolve `server-sdk-v0.1.0` to `@mido-agent/server-sdk` and `v0.1.0` to `MidoClient`.
- `swift test --package-path packages/client-ios` still passes.
- `pnpm version:check` fails on any version drift.
- `pnpm release:check` passes locally.
- README installation examples use versioned dependencies instead of `main`.

## Risks

- Swift Package Manager expects tags at repository root. The root `Package.swift` wrapper must be tested before documenting `from: "0.2.0"`.
- Swift Package Manager does not support arbitrary target-prefixed tags for normal `from:` dependencies. The iOS release tag must remain SemVer-compatible.
- npm package manifests may still use `workspace:*` internally during local development. Publishing needs either pnpm publish behavior validation or explicit prepack checks so external packages do not receive unresolved workspace dependencies.
- Lockstep versioning can over-release packages that did not change. This is acceptable early because compatibility clarity is more valuable than package-level precision.
- Runtime version constants can drift if edited manually. `version:check` must validate generated files.

## Future Options

Independent package versioning can be introduced later when:

- `mido.protocol.v1` has proven stable across multiple releases.
- `toolkit-core`, `evaluator`, or adapters can evolve without requiring synchronized client/server updates.
- The compatibility matrix is generated from release metadata instead of hand-maintained docs.
