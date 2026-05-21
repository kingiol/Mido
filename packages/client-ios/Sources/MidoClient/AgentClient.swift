import Foundation

public protocol AgentTransport: Sendable {
  func startRun(_ request: RunStartRequest) async throws -> AsyncThrowingStream<CoreEvent, Error>
  func resume(_ request: RunResumeRequest) async throws -> AsyncThrowingStream<CoreEvent, Error>
  func cancelRun(_ request: RunCancelRequest) async throws -> CoreEvent?
}

public extension AgentTransport {
  func cancelRun(_ request: RunCancelRequest) async throws -> CoreEvent? {
    nil
  }
}

public typealias ClientToolHandler = @Sendable (JSONObject, ClientToolExecutionContext) async throws -> JSONValue

public struct RegisteredClientTool: Sendable {
  public var definition: ToolDefinition
  public var execute: ClientToolHandler?

  public init(definition: ToolDefinition, execute: ClientToolHandler? = nil) {
    self.definition = definition
    self.execute = execute
  }
}

public struct ClientToolExecutionContext: Sendable {
  public var runId: String
  public var sharedState: JSONObject
  public var toolCall: ToolCallSnapshot

  public init(runId: String, sharedState: JSONObject, toolCall: ToolCallSnapshot) {
    self.runId = runId
    self.sharedState = sharedState
    self.toolCall = toolCall
  }
}

public enum ToolCallStatus: String, Codable, Equatable, Sendable {
  case pending
  case submitted
  case resolved
}

public struct ToolCallSnapshot: Codable, Equatable, Sendable {
  public var runId: String
  public var messageId: String
  public var toolCallId: String
  public var toolId: String
  public var toolName: String
  public var modelName: String
  public var toolRuntime: ToolRuntime
  public var executionPolicy: ToolExecutionPolicy
  public var timeoutMs: Double?
  public var args: JSONObject
  public var createdAt: String
  public var status: ToolCallStatus
  public var output: JSONValue?
  public var isError: Bool?
}

public enum AgentClientStatus: String, Codable, Equatable, Sendable {
  case idle
  case running
  case awaitingClientTool = "awaiting_client_tool"
  case finished
  case cancelled
  case error
}

public struct AgentClientSnapshot: Codable, Equatable, Sendable {
  public var threadId: String?
  public var runId: String?
  public var status: AgentClientStatus
  public var events: [CoreEvent]
  public var conversationMessages: [AgentMessage]
  public var sharedState: JSONObject
  public var textTranscript: String
  public var toolCalls: [ToolCallSnapshot]
  public var pendingInteractiveTools: [ToolCallSnapshot]
  public var error: RunErrorInfo?
}

public struct SendMessageOptions: Sendable {
  public var runId: String?
  public var threadId: String?
  public var systemPrompt: String?
  public var state: JSONObject?
  public var metadata: JSONObject?

  public init(runId: String? = nil, threadId: String? = nil, systemPrompt: String? = nil, state: JSONObject? = nil, metadata: JSONObject? = nil) {
    self.runId = runId
    self.threadId = threadId
    self.systemPrompt = systemPrompt
    self.state = state
    self.metadata = metadata
  }
}

public struct RetryRunOptions: Sendable {
  public var runId: String?

  public init(runId: String? = nil) {
    self.runId = runId
  }
}

public struct ClearConversationOptions: Sendable {
  public var threadId: String?

  public init(threadId: String? = nil) {
    self.threadId = threadId
  }
}

private struct NormalizedRegisteredClientTool: Sendable {
  var definition: ToolDefinition
  var execute: ClientToolHandler?
}

public actor AgentClient {
  private let transport: any AgentTransport
  private var systemPrompt: String?
  private var listeners: [UUID: @Sendable (AgentClientSnapshot) -> Void] = [:]
  private var tools: [String: NormalizedRegisteredClientTool] = [:]
  private var toolCalls: [String: ToolCallSnapshot] = [:]
  private var toolCallOrder: [String] = []
  private var autoExecutions = Set<String>()
  private var streamedTextIds = Set<String>()
  private var pendingConversationCommit = false
  private var pendingAssistantMessageId: String?
  private var lastRunRequest: RunStartRequest?
  private var lastRunShouldCommitConversation = false
  private var snapshot: AgentClientSnapshot

  public init(transport: any AgentTransport, threadId: String? = nil, systemPrompt: String? = nil) {
    self.transport = transport
    self.systemPrompt = systemPrompt
    self.snapshot = AgentClientSnapshot(
      threadId: threadId ?? createID("thread"),
      runId: nil,
      status: .idle,
      events: [],
      conversationMessages: [],
      sharedState: [:],
      textTranscript: "",
      toolCalls: [],
      pendingInteractiveTools: [],
      error: nil
    )
  }

  @discardableResult
  public func registerClientTool(_ tool: RegisteredClientTool) throws -> ToolDefinition {
    if tool.definition.executionPolicy == .server {
      throw MidoClientError.invalidToolDefinition("Client runtime cannot register server tool \"\(tool.definition.name)\"")
    }

    if tool.definition.executionPolicy == .clientAuto && tool.execute == nil {
      throw MidoClientError.invalidToolDefinition("Auto client tool \"\(tool.definition.name)\" must define an execute handler")
    }

    let normalized = tool.definition.normalized()
    try validateToolDefinition(normalized)
    tools[normalized.toolId ?? createToolID(executionPolicy: normalized.executionPolicy, name: normalized.name)] = NormalizedRegisteredClientTool(
      definition: normalized,
      execute: tool.execute
    )
    return normalized
  }

  public func unregisterClientTool(_ toolId: String) -> Bool {
    tools.removeValue(forKey: toolId) != nil
  }

  public func setSystemPrompt(_ prompt: String?) {
    systemPrompt = prompt
  }

  public func startRun(_ request: RunStartRequest) async throws {
    var runRequest = request
    let runId = runRequest.runId ?? createID("run")
    runRequest.runId = runId
    runRequest.messages = withClientSystemPrompts(runRequest.messages, prompts: [systemPrompt])
    lastRunRequest = runRequest
    lastRunShouldCommitConversation = false

    resetForRun(runId: runId)
    patchSnapshot(runId: runId, status: .running)
    try await consumeRunStream(runRequest, mode: .start)
  }

  public func sendMessage(_ text: String, options: SendMessageOptions = SendMessageOptions()) async throws {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedText.isEmpty {
      return
    }

    if snapshot.status == .running || snapshot.status == .awaitingClientTool {
      throw MidoClientError.invalidToolState("Cannot send a new message while a run is active")
    }

    let threadId = options.threadId ?? snapshot.threadId ?? createID("thread")
    let userMessage = AgentMessage.text(role: .user, text: trimmedText)
    let conversationMessages = snapshot.conversationMessages + [userMessage]
    let runId = options.runId ?? createID("run")
    let requestMessages = withClientSystemPrompts(conversationMessages, prompts: [systemPrompt, options.systemPrompt])
    let runRequest = RunStartRequest(
      runId: runId,
      threadId: threadId,
      messages: requestMessages,
      state: options.state,
      metadata: options.metadata
    )

    lastRunRequest = runRequest
    lastRunShouldCommitConversation = true
    pendingConversationCommit = true
    resetForRun(
      runId: runId,
      threadId: threadId,
      conversationMessages: conversationMessages,
      sharedState: options.state ?? snapshot.sharedState
    )
    patchSnapshot(threadId: threadId, runId: runId, status: .running)

    try await consumeRunStream(runRequest, mode: .start)
    commitPendingConversation()
  }

  public func submitToolResult(_ toolCallId: String, output: JSONValue) async throws {
    try await resumeWithToolResult(toolCallId: toolCallId, output: output)
    commitPendingConversation()
  }

  public func approveToolCall(_ toolCallId: String) async throws {
    try await executeInteractiveTool(toolCallId)
    commitPendingConversation()
  }

  public func rejectToolCall(_ toolCallId: String, reason: String = "User rejected client tool execution") async throws {
    _ = try getPendingInteractiveToolCall(toolCallId)
    try await resumeWithToolResult(
      toolCallId: toolCallId,
      output: ["code": "client_tool_rejected", "message": .string(reason)],
      isError: true
    )
    commitPendingConversation()
  }

  public func cancelRun(reason: String = "User cancelled the run") async throws {
    guard let runId = snapshot.runId, snapshot.status == .running || snapshot.status == .awaitingClientTool else {
      return
    }

    if let event = try await transport.cancelRun(RunCancelRequest(runId: runId, reason: reason)) {
      applyEvent(event)
    } else {
      applyLocalCancelledEvent(runId: runId)
    }
  }

  public func retryLastRun(options: RetryRunOptions = RetryRunOptions()) async throws {
    if snapshot.status == .running || snapshot.status == .awaitingClientTool {
      throw MidoClientError.invalidToolState("Cannot retry while a run is active")
    }

    guard var runRequest = lastRunRequest else {
      throw MidoClientError.invalidToolState("No run is available to retry")
    }

    runRequest.runId = options.runId ?? createID("run")
    lastRunRequest = runRequest
    pendingConversationCommit = lastRunShouldCommitConversation
    resetForRun(
      runId: runRequest.runId,
      threadId: runRequest.threadId ?? snapshot.threadId,
      conversationMessages: snapshot.conversationMessages,
      sharedState: runRequest.state ?? snapshot.sharedState
    )
    patchSnapshot(threadId: runRequest.threadId ?? snapshot.threadId, runId: runRequest.runId, status: .running)
    try await consumeRunStream(runRequest, mode: .start)
    commitPendingConversation()
  }

  public func clearConversation(options: ClearConversationOptions = ClearConversationOptions()) throws {
    if snapshot.status == .running || snapshot.status == .awaitingClientTool {
      throw MidoClientError.invalidToolState("Cannot clear the conversation while a run is active")
    }

    pendingConversationCommit = false
    pendingAssistantMessageId = nil
    toolCalls.removeAll()
    toolCallOrder.removeAll()
    autoExecutions.removeAll()
    streamedTextIds.removeAll()
    snapshot = AgentClientSnapshot(
      threadId: options.threadId ?? createID("thread"),
      runId: nil,
      status: .idle,
      events: [],
      conversationMessages: [],
      sharedState: [:],
      textTranscript: "",
      toolCalls: [],
      pendingInteractiveTools: [],
      error: nil
    )
    notify()
  }

  @discardableResult
  public func subscribe(_ listener: @escaping @Sendable (AgentClientSnapshot) -> Void) -> UUID {
    let id = UUID()
    listeners[id] = listener
    return id
  }

  public func unsubscribe(_ id: UUID) {
    listeners.removeValue(forKey: id)
  }

  public func getSnapshot() -> AgentClientSnapshot {
    snapshot
  }

  private enum StreamMode {
    case start
    case resume
  }

  private func consumeRunStream(_ request: RunStartRequest, mode: StreamMode) async throws {
    let stream = try await transport.startRun(withRegisteredClientTools(request))
    try await consume(stream)
  }

  private func consumeRunStream(_ request: RunResumeRequest, mode: StreamMode) async throws {
    let stream = try await transport.resume(request)
    try await consume(stream)
  }

  private func consume(_ stream: AsyncThrowingStream<CoreEvent, Error>) async throws {
    for try await event in stream {
      applyEvent(event)
    }

    if snapshot.status != .cancelled {
      try await flushAutoTools()
    }
  }

  private func flushAutoTools() async throws {
    let pendingAutoTools = toolCalls.values.filter {
      $0.executionPolicy == .clientAuto && $0.status == .pending && !autoExecutions.contains($0.toolCallId)
    }

    for toolCall in pendingAutoTools {
      guard tools[toolCall.toolId]?.execute != nil else {
        patchSnapshot(
          status: .error,
          error: RunErrorInfo(
            code: "client_tool_missing_handler",
            message: "No execute handler registered for auto tool \"\(toolCall.toolName)\""
          )
        )
        return
      }

      do {
        autoExecutions.insert(toolCall.toolCallId)
        try await executeClientTool(toolCall)
      } catch {
        try await resumeWithToolResult(
          toolCallId: toolCall.toolCallId,
          output: [
            "code": error is TimeoutError ? "tool_timeout" : "client_tool_execution_failed",
            "message": .string(error.localizedDescription)
          ],
          isError: true
        )
      }
      autoExecutions.remove(toolCall.toolCallId)
    }
  }

  private func executeInteractiveTool(_ toolCallId: String) async throws {
    let toolCall = try getPendingInteractiveToolCall(toolCallId)
    guard tools[toolCall.toolId]?.execute != nil else {
      throw MidoClientError.invalidToolDefinition("Interactive client tool \"\(toolCall.toolName)\" must define an execute handler to be approved")
    }

    do {
      try await executeClientTool(toolCall)
    } catch {
      try await resumeWithToolResult(
        toolCallId: toolCall.toolCallId,
        output: [
          "code": error is TimeoutError ? "tool_timeout" : "client_tool_execution_failed",
          "message": .string(error.localizedDescription)
        ],
        isError: true
      )
    }
  }

  private func executeClientTool(_ toolCall: ToolCallSnapshot) async throws {
    guard let tool = tools[toolCall.toolId], let execute = tool.execute else {
      throw MidoClientError.missingTool("No execute handler registered for client tool \"\(toolCall.toolName)\"")
    }

    let output = try await withTimeout(timeoutMs: tool.definition.timeoutMs) {
      try await execute(
        toolCall.args,
        ClientToolExecutionContext(
          runId: self.snapshot.runId ?? toolCall.runId,
          sharedState: self.snapshot.sharedState,
          toolCall: toolCall
        )
      )
    }
    try JSONSchemaValidator.validate(output, schema: tool.definition.resultSchema, label: "\(tool.definition.name) tool result")
    try await resumeWithToolResult(toolCallId: toolCall.toolCallId, output: output)
  }

  private func getPendingInteractiveToolCall(_ toolCallId: String) throws -> ToolCallSnapshot {
    guard let toolCall = toolCalls[toolCallId] else {
      throw MidoClientError.unknownToolCall("Unknown tool call \"\(toolCallId)\"")
    }

    if toolCall.executionPolicy != .clientInteractive {
      throw MidoClientError.invalidToolState("Tool call \"\(toolCallId)\" is not interactive")
    }

    if toolCall.status != .pending {
      throw MidoClientError.invalidToolState("Tool call \"\(toolCallId)\" is not pending")
    }

    return toolCall
  }

  private func resumeWithToolResult(toolCallId: String, output: JSONValue, isError: Bool? = nil) async throws {
    guard var toolCall = toolCalls[toolCallId] else {
      throw MidoClientError.unknownToolCall("Unknown tool call \"\(toolCallId)\"")
    }

    if toolCall.status == .resolved {
      if toolCall.output.map(canonicalJSONString) == canonicalJSONString(output) {
        return
      }
      throw MidoClientError.invalidToolState("Tool call \"\(toolCallId)\" has already been resolved with a different output")
    }

    guard let tool = tools[toolCall.toolId] else {
      throw MidoClientError.missingTool("Tool \"\(toolCall.toolName)\" is not registered on the client")
    }

    if isError != true {
      try JSONSchemaValidator.validate(output, schema: tool.definition.resultSchema, label: "\(tool.definition.name) tool result")
    }

    toolCall.status = .submitted
    toolCalls[toolCallId] = toolCall
    rebuildToolCollections()
    notify()

    let runId = snapshot.runId ?? toolCall.runId
    let request = RunResumeRequest(
      runId: runId,
      toolResult: ToolResultEnvelope(
        runId: runId,
        messageId: toolCall.messageId,
        toolCallId: toolCallId,
        toolId: toolCall.toolId,
        toolName: toolCall.toolName,
        modelName: toolCall.modelName,
        output: output,
        isError: isError
      )
    )

    try await consumeRunStream(request, mode: .resume)
  }

  private func commitPendingConversation() {
    guard pendingConversationCommit, snapshot.status == .finished else {
      return
    }

    pendingConversationCommit = false
    guard !snapshot.textTranscript.isEmpty else {
      return
    }

    snapshot.conversationMessages.append(
      AgentMessage.text(
        role: .assistant,
        text: snapshot.textTranscript,
        id: pendingAssistantMessageId ?? createID("msg")
      )
    )
    pendingAssistantMessageId = nil
    notify()
  }

  private func applyEvent(_ event: CoreEvent) {
    snapshot.runId = event.runId
    snapshot.events.append(event)

    switch event {
    case let .runStarted(event):
      patchSnapshot(threadId: event.threadId ?? snapshot.threadId, runId: event.runId, status: .running)
    case let .textDelta(event):
      streamedTextIds.insert(event.textId)
      patchSnapshot(textTranscript: snapshot.textTranscript + event.delta)
    case let .textEnd(event):
      pendingAssistantMessageId = event.messageId
      if !streamedTextIds.contains(event.textId) {
        patchSnapshot(textTranscript: snapshot.textTranscript + event.text)
      }
    case let .toolCallEnd(event):
      if toolCalls[event.toolCallId] == nil {
        toolCallOrder.append(event.toolCallId)
      }
      toolCalls[event.toolCallId] = ToolCallSnapshot(
        runId: event.runId,
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        modelName: event.modelName,
        toolRuntime: event.toolRuntime,
        executionPolicy: event.executionPolicy,
        timeoutMs: event.timeoutMs,
        args: event.args,
        createdAt: event.timestamp,
        status: .pending,
        output: nil,
        isError: nil
      )
      rebuildToolCollections()
    case let .toolResult(event):
      if var existing = toolCalls[event.toolCallId] {
        existing.status = .resolved
        existing.output = event.output
        existing.isError = event.isError
        toolCalls[event.toolCallId] = existing
        rebuildToolCollections()
      }
    case let .stateDelta(event):
      snapshot.sharedState.merge(event.delta) { _, new in new }
      notify()
    case let .runFinished(event):
      switch event.finishReason {
      case .awaitingClientTool:
        patchSnapshot(status: .awaitingClientTool)
      case .cancelled:
        patchSnapshot(status: .cancelled)
      case .completed:
        patchSnapshot(status: .finished)
      }
    case let .runError(event):
      patchSnapshot(status: .error, error: event.error)
    default:
      notify()
    }
  }

  private func rebuildToolCollections() {
    let values = toolCallOrder.compactMap { toolCalls[$0] }
    snapshot.toolCalls = values
    snapshot.pendingInteractiveTools = values.filter { $0.executionPolicy == .clientInteractive && $0.status == .pending }
  }

  private func resetForRun(
    runId: String?,
    threadId: String? = nil,
    conversationMessages: [AgentMessage]? = nil,
    sharedState: JSONObject? = nil
  ) {
    toolCalls.removeAll()
    toolCallOrder.removeAll()
    autoExecutions.removeAll()
    streamedTextIds.removeAll()
    pendingAssistantMessageId = nil
    snapshot = AgentClientSnapshot(
      threadId: threadId ?? snapshot.threadId,
      runId: runId,
      status: .idle,
      events: [],
      conversationMessages: conversationMessages ?? snapshot.conversationMessages,
      sharedState: sharedState ?? [:],
      textTranscript: "",
      toolCalls: [],
      pendingInteractiveTools: [],
      error: nil
    )
    notify()
  }

  private func patchSnapshot(
    threadId: String? = nil,
    runId: String? = nil,
    status: AgentClientStatus? = nil,
    textTranscript: String? = nil,
    error: RunErrorInfo? = nil
  ) {
    if let threadId {
      snapshot.threadId = threadId
    }
    if let runId {
      snapshot.runId = runId
    }
    if let status {
      snapshot.status = status
    }
    if let textTranscript {
      snapshot.textTranscript = textTranscript
    }
    if let error {
      snapshot.error = error
    }
    notify()
  }

  private func withRegisteredClientTools(_ request: RunStartRequest) -> RunStartRequest {
    let clientTools = tools.values
      .map(\.definition)
      .filter { $0.executionPolicy != .server }

    guard !clientTools.isEmpty else {
      return request
    }

    var copy = request
    copy.clientTools = (copy.clientTools ?? []) + clientTools
    return copy
  }

  private func applyLocalCancelledEvent(runId: String) {
    guard snapshot.status != .cancelled, snapshot.status != .finished else {
      return
    }

    applyEvent(.runFinished(RunFinishedEvent(
      eventId: createID("evt"),
      sequence: (snapshot.events.last?.sequence ?? 0) + 1,
      runId: runId,
      messageId: createID("msg"),
      timestamp: nowISO(),
      finishReason: .cancelled
    )))
  }

  private func notify() {
    for listener in listeners.values {
      listener(snapshot)
    }
  }
}

private func withClientSystemPrompts(_ messages: [AgentMessage], prompts: [String?]) -> [AgentMessage] {
  let combined = prompts
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n")

  guard !combined.isEmpty else {
    return messages
  }

  return [AgentMessage.text(role: .system, text: combined)] + messages
}

private struct TimeoutError: Error {}

private func withTimeout<T: Sendable>(timeoutMs: Double?, operation: @escaping @Sendable () async throws -> T) async throws -> T {
  guard let timeoutMs, timeoutMs > 0 else {
    return try await operation()
  }

  return try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask {
      try await operation()
    }
    group.addTask {
      try await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))
      throw TimeoutError()
    }

    guard let result = try await group.next() else {
      throw TimeoutError()
    }
    group.cancelAll()
    return result
  }
}
