import Foundation
import MidoClient
import SwiftUI

enum DemoMode: String, CaseIterable, Identifiable {
  case mock
  case localServer

  var id: String { rawValue }

  var title: String {
    switch self {
    case .mock:
      return "Mock"
    case .localServer:
      return "Local"
    }
  }
}

enum DemoSheet: Identifiable {
  case settings

  var id: String {
    "settings"
  }
}

struct MessageRow: Identifiable, Equatable {
  let id = UUID()
  var role: String
  var text: String
}

@MainActor
final class DemoAgentStore: ObservableObject, @unchecked Sendable {
  @Published private(set) var snapshot: AgentClientSnapshot?
  @Published var inputText = ""
  @Published var mode: DemoMode = .mock {
    didSet {
      guard oldValue != mode else {
        return
      }
      Task {
        await rebuildClient()
      }
    }
  }
  @Published var baseURLString = "http://127.0.0.1:3030"
  @Published var activeSheet: DemoSheet?
  @Published var errorMessage: String?
  @Published private(set) var isSending = false

  let presets = [
    "weather here",
    "delete draft",
    "hello mido"
  ]

  private var client: AgentClient?
  private var subscriptionID: UUID?

  var statusTitle: String {
    switch snapshot?.status {
    case .running:
      return "Streaming"
    case .awaitingClientTool:
      return "Approval needed"
    case .finished:
      return "Finished"
    case .cancelled:
      return "Cancelled"
    case .error:
      return "Error"
    case .idle, .none:
      return "Ready"
    }
  }

  var hasEmptyTranscript: Bool {
    let transcript = snapshot?.textTranscript ?? ""
    let pendingTools = snapshot?.pendingInteractiveTools ?? []
    return transcript.isEmpty && pendingTools.isEmpty && messageRows.isEmpty
  }

  var messageRows: [MessageRow] {
    (snapshot?.conversationMessages ?? []).compactMap { message in
      let text = message.content.compactMap { part -> String? in
        if case let .text(textPart) = part {
          return textPart.text
        }
        return nil
      }.joined(separator: "\n")

      guard !text.isEmpty else {
        return nil
      }

      return MessageRow(role: message.role.rawValue, text: text)
    }
  }

  var liveTranscriptText: String? {
    visibleLiveTranscriptText(
      transcript: snapshot?.textTranscript ?? "",
      conversationMessages: snapshot?.conversationMessages ?? []
    )
  }

  var errorBinding: Binding<Bool> {
    Binding(
      get: { self.errorMessage != nil },
      set: { isPresented in
        if !isPresented {
          self.errorMessage = nil
        }
      }
    )
  }

  func configureIfNeeded() async {
    guard client == nil else {
      return
    }
    await rebuildClient()
  }

  func rebuildClient() async {
    if let client, let subscriptionID {
      await client.unsubscribe(subscriptionID)
    }

    do {
      let transport = try makeTransport()
      let agentClient = AgentClient(
        transport: transport,
        systemPrompt: "You are running inside the Mido iOS demo."
      )
      let subscriptionID = await agentClient.subscribe { [weak self] snapshot in
        Task { @MainActor [weak self] in
          self?.snapshot = snapshot
        }
      }

      try await registerDemoTools(on: agentClient)

      self.client = agentClient
      self.subscriptionID = subscriptionID
      self.snapshot = await agentClient.getSnapshot()
      self.errorMessage = nil
    } catch {
      self.client = nil
      self.subscriptionID = nil
      self.errorMessage = error.localizedDescription
    }
  }

  func sendCurrentMessage() async {
    let message = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else {
      return
    }

    inputText = ""
    await send(message)
  }

  func sendPreset(_ preset: String) async {
    inputText = ""
    await send(preset)
  }

  func approve(_ toolCall: ToolCallSnapshot) async {
    do {
      try await client?.approveToolCall(toolCall.toolCallId)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func reject(_ toolCall: ToolCallSnapshot) async {
    do {
      try await client?.rejectToolCall(toolCall.toolCallId, reason: "Rejected in the iOS demo")
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func clearConversation() async {
    do {
      try await client?.clearConversation()
      snapshot = await client?.getSnapshot()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func send(_ message: String) async {
    if client == nil {
      await rebuildClient()
    }

    guard let client else {
      return
    }

    isSending = true
    defer {
      isSending = false
    }

    do {
      try await client.sendMessage(message)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func makeTransport() throws -> any AgentTransport {
    switch mode {
    case .mock:
      return DemoMockTransport()
    case .localServer:
      guard let baseURL = URL(string: normalizedBaseURLString()) else {
        throw DemoStoreError.invalidBaseURL(baseURLString)
      }

      guard
        let runURL = URL(string: "api/run", relativeTo: baseURL)?.absoluteURL,
        let resumeURL = URL(string: "api/resume", relativeTo: baseURL)?.absoluteURL,
        let cancelURL = URL(string: "api/cancel", relativeTo: baseURL)?.absoluteURL
      else {
        throw DemoStoreError.invalidBaseURL(baseURLString)
      }

      return URLSessionSSETransport(runURL: runURL, resumeURL: resumeURL, cancelURL: cancelURL)
    }
  }

  private func normalizedBaseURLString() -> String {
    let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.hasSuffix("/") ? trimmed : "\(trimmed)/"
  }

  private func registerDemoTools(on client: AgentClient) async throws {
    try await client.registerClientTool(RegisteredClientTool(
      definition: ToolDefinition(
        name: "deviceLocation",
        description: "Read the current demo city.",
        inputSchema: ["type": "object", "additionalProperties": true],
        resultSchema: [
          "type": "object",
          "required": ["city"],
          "properties": [
            "city": ["type": "string"],
            "source": ["type": "string"]
          ]
        ],
        executionPolicy: .clientAuto
      ),
      execute: { _, _ in
        ["city": "Shanghai", "source": "ios-demo"]
      }
    ))

    try await client.registerClientTool(RegisteredClientTool(
      definition: ToolDefinition(
        name: "deleteDraft",
        description: "Delete a draft after approval.",
        inputSchema: [
          "type": "object",
          "required": ["id"],
          "properties": [
            "id": ["type": "string"]
          ]
        ],
        resultSchema: ["type": "object", "additionalProperties": true],
        executionPolicy: .clientInteractive
      ),
      execute: { args, _ in
        ["deleted": true, "id": args["id"] ?? "draft-demo"]
      }
    ))
  }
}

func visibleLiveTranscriptText(transcript: String, conversationMessages: [AgentMessage]) -> String? {
  guard !transcript.isEmpty else {
    return nil
  }

  guard let lastMessage = conversationMessages.last, lastMessage.role == .assistant else {
    return transcript
  }

  return textContent(in: lastMessage) == transcript ? nil : transcript
}

private func textContent(in message: AgentMessage) -> String {
  message.content.compactMap { part -> String? in
    if case let .text(textPart) = part {
      return textPart.text
    }
    return nil
  }.joined(separator: "\n")
}

enum DemoStoreError: LocalizedError {
  case invalidBaseURL(String)

  var errorDescription: String? {
    switch self {
    case let .invalidBaseURL(value):
      return "Invalid server URL: \(value)"
    }
  }
}
