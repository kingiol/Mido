# MidoClient

Swift 6 client SDK for iOS apps using Mido's server-owned agent loop.

## Install

Add this repository as a Swift Package dependency and link the `MidoClient` product into your app target.

```swift
.package(url: "https://github.com/kingiol/Mido.git", branch: "main")
```

## Usage

```swift
import MidoClient

let transport = URLSessionSSETransport(
  runURL: URL(string: "https://example.com/api/run")!,
  resumeURL: URL(string: "https://example.com/api/resume")!,
  cancelURL: URL(string: "https://example.com/api/cancel")
)

let client = AgentClient(transport: transport)

try await client.registerClientTool(RegisteredClientTool(
  definition: ToolDefinition(
    name: "getLocation",
    description: "Read the current city.",
    inputSchema: ["type": "object", "additionalProperties": true],
    resultSchema: [
      "type": "object",
      "required": ["city"],
      "properties": ["city": ["type": "string"]]
    ],
    executionPolicy: .clientAuto
  ),
  execute: { _, _ in ["city": "Shanghai"] }
))

try await client.sendMessage("weather here")
let snapshot = await client.getSnapshot()
```

`client_auto` tools execute locally and resume the server run. `client_interactive` tools appear in `snapshot.pendingInteractiveTools` so the app can ask the user to approve or reject them.

## Verify

```bash
swift test --package-path packages/client-ios
```
