import Foundation

public enum ToolExecutionPolicy: String, Codable, Equatable, Sendable {
  case server
  case clientAuto = "client_auto"
  case clientInteractive = "client_interactive"
}

public enum ToolRuntime: String, Codable, Equatable, Sendable {
  case server
  case client
}

public enum RunFinishReason: String, Codable, Equatable, Sendable {
  case completed
  case awaitingClientTool = "awaiting_client_tool"
  case cancelled
}

public enum TraceKind: String, Codable, Equatable, Sendable {
  case run
  case model
  case tool
  case state
  case transport
}

public enum ModelCallStatus: String, Codable, Equatable, Sendable {
  case running
  case completed
  case error
  case cancelled
}

public enum MessageRole: String, Codable, Equatable, Sendable {
  case system
  case user
  case assistant
  case tool
  case summary
}

public struct TextPart: Codable, Equatable, Sendable {
  public let type: String
  public var text: String

  public init(text: String) {
    self.type = "text"
    self.text = text
  }
}

public struct ReasoningPart: Codable, Equatable, Sendable {
  public let type: String
  public var text: String

  public init(text: String) {
    self.type = "reasoning"
    self.text = text
  }
}

public struct ToolCallPart: Codable, Equatable, Sendable {
  public let type: String
  public var toolCallId: String
  public var toolId: String?
  public var toolName: String
  public var modelName: String?
  public var args: JSONObject
  public var executionPolicy: ToolExecutionPolicy

  public init(
    toolCallId: String,
    toolId: String? = nil,
    toolName: String,
    modelName: String? = nil,
    args: JSONObject,
    executionPolicy: ToolExecutionPolicy
  ) {
    self.type = "tool-call"
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.args = args
    self.executionPolicy = executionPolicy
  }
}

public struct ToolResultPart: Codable, Equatable, Sendable {
  public let type: String
  public var toolCallId: String
  public var toolId: String?
  public var toolName: String
  public var output: JSONValue
  public var isError: Bool?

  public init(toolCallId: String, toolId: String? = nil, toolName: String, output: JSONValue, isError: Bool? = nil) {
    self.type = "tool-result"
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.output = output
    self.isError = isError
  }
}

public enum MessagePart: Codable, Equatable, Sendable {
  case text(TextPart)
  case reasoning(ReasoningPart)
  case toolCall(ToolCallPart)
  case toolResult(ToolResultPart)

  private enum CodingKeys: String, CodingKey {
    case type
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "text":
      self = .text(try TextPart(from: decoder))
    case "reasoning":
      self = .reasoning(try ReasoningPart(from: decoder))
    case "tool-call":
      self = .toolCall(try ToolCallPart(from: decoder))
    case "tool-result":
      self = .toolResult(try ToolResultPart(from: decoder))
    default:
      throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown message part type \(type)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case let .text(value):
      try value.encode(to: encoder)
    case let .reasoning(value):
      try value.encode(to: encoder)
    case let .toolCall(value):
      try value.encode(to: encoder)
    case let .toolResult(value):
      try value.encode(to: encoder)
    }
  }
}

public struct AgentMessage: Codable, Equatable, Sendable {
  public var id: String
  public var role: MessageRole
  public var content: [MessagePart]
  public var createdAt: String

  public init(id: String = createID("msg"), role: MessageRole, content: [MessagePart], createdAt: String = nowISO()) {
    self.id = id
    self.role = role
    self.content = content
    self.createdAt = createdAt
  }

  public static func text(role: MessageRole, text: String, id: String = createID("msg"), createdAt: String = nowISO()) -> AgentMessage {
    AgentMessage(id: id, role: role, content: [.text(TextPart(text: text))], createdAt: createdAt)
  }
}

public struct ToolDefinition: Codable, Equatable, Sendable {
  public var toolId: String?
  public var name: String
  public var modelName: String?
  public var description: String
  public var inputSchema: JSONSchema
  public var resultSchema: JSONSchema
  public var executionPolicy: ToolExecutionPolicy
  public var timeoutMs: Double?
  public var metadata: JSONObject?

  public init(
    toolId: String? = nil,
    name: String,
    modelName: String? = nil,
    description: String,
    inputSchema: JSONSchema,
    resultSchema: JSONSchema,
    executionPolicy: ToolExecutionPolicy,
    timeoutMs: Double? = nil,
    metadata: JSONObject? = nil
  ) {
    self.toolId = toolId
    self.name = name
    self.modelName = modelName
    self.description = description
    self.inputSchema = inputSchema
    self.resultSchema = resultSchema
    self.executionPolicy = executionPolicy
    self.timeoutMs = timeoutMs
    self.metadata = metadata
  }

  public func normalized() -> ToolDefinition {
    var copy = self
    copy.toolId = copy.toolId ?? createToolID(executionPolicy: copy.executionPolicy, name: copy.name)
    copy.modelName = copy.modelName ?? createToolModelName(executionPolicy: copy.executionPolicy, name: copy.name)
    return copy
  }
}

public struct RunContextBudget: Codable, Equatable, Sendable {
  public var maxInputTokens: Double?
  public var reserveOutputTokens: Double?
  public var triggerRatio: Double?
  public var targetRatio: Double?

  public init(maxInputTokens: Double? = nil, reserveOutputTokens: Double? = nil, triggerRatio: Double? = nil, targetRatio: Double? = nil) {
    self.maxInputTokens = maxInputTokens
    self.reserveOutputTokens = reserveOutputTokens
    self.triggerRatio = triggerRatio
    self.targetRatio = targetRatio
  }
}

public struct ToolCallEnvelope: Codable, Equatable, Sendable {
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

  public init(
    runId: String,
    messageId: String,
    toolCallId: String,
    toolId: String,
    toolName: String,
    modelName: String,
    toolRuntime: ToolRuntime,
    executionPolicy: ToolExecutionPolicy,
    timeoutMs: Double? = nil,
    args: JSONObject,
    createdAt: String
  ) {
    self.runId = runId
    self.messageId = messageId
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.toolRuntime = toolRuntime
    self.executionPolicy = executionPolicy
    self.timeoutMs = timeoutMs
    self.args = args
    self.createdAt = createdAt
  }
}

public struct ToolResultEnvelope: Codable, Equatable, Sendable {
  public var runId: String
  public var messageId: String
  public var toolCallId: String
  public var toolId: String?
  public var toolName: String
  public var modelName: String?
  public var output: JSONValue
  public var submittedAt: String
  public var isError: Bool?

  public init(
    runId: String,
    messageId: String,
    toolCallId: String,
    toolId: String? = nil,
    toolName: String,
    modelName: String? = nil,
    output: JSONValue,
    submittedAt: String = nowISO(),
    isError: Bool? = nil
  ) {
    self.runId = runId
    self.messageId = messageId
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.output = output
    self.submittedAt = submittedAt
    self.isError = isError
  }
}

public struct RunStartRequest: Codable, Equatable, Sendable {
  public var runId: String?
  public var threadId: String?
  public var messages: [AgentMessage]
  public var clientTools: [ToolDefinition]?
  public var contextBudget: RunContextBudget?
  public var state: JSONObject?
  public var metadata: JSONObject?

  public init(
    runId: String? = nil,
    threadId: String? = nil,
    messages: [AgentMessage],
    clientTools: [ToolDefinition]? = nil,
    contextBudget: RunContextBudget? = nil,
    state: JSONObject? = nil,
    metadata: JSONObject? = nil
  ) {
    self.runId = runId
    self.threadId = threadId
    self.messages = messages
    self.clientTools = clientTools
    self.contextBudget = contextBudget
    self.state = state
    self.metadata = metadata
  }
}

public struct RunResumeRequest: Codable, Equatable, Sendable {
  public var runId: String
  public var toolResult: ToolResultEnvelope
  public var stateDelta: JSONObject?

  public init(runId: String, toolResult: ToolResultEnvelope, stateDelta: JSONObject? = nil) {
    self.runId = runId
    self.toolResult = toolResult
    self.stateDelta = stateDelta
  }
}

public struct RunCancelRequest: Codable, Equatable, Sendable {
  public var runId: String
  public var reason: String?

  public init(runId: String, reason: String? = nil) {
    self.runId = runId
    self.reason = reason
  }
}

public struct TraceMetadata: Codable, Equatable, Sendable {
  public var traceId: String
  public var spanId: String
  public var parentSpanId: String?
  public var name: String
  public var kind: TraceKind
  public var startedAt: String?
  public var endedAt: String?
  public var durationMs: Double?
  public var attributes: JSONObject?

  public init(
    traceId: String,
    spanId: String,
    parentSpanId: String? = nil,
    name: String,
    kind: TraceKind,
    startedAt: String? = nil,
    endedAt: String? = nil,
    durationMs: Double? = nil,
    attributes: JSONObject? = nil
  ) {
    self.traceId = traceId
    self.spanId = spanId
    self.parentSpanId = parentSpanId
    self.name = name
    self.kind = kind
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.durationMs = durationMs
    self.attributes = attributes
  }
}

public struct ModelUsage: Codable, Equatable, Sendable {
  public var inputTokens: Double?
  public var outputTokens: Double?
  public var totalTokens: Double?

  public init(inputTokens: Double? = nil, outputTokens: Double? = nil, totalTokens: Double? = nil) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.totalTokens = totalTokens
  }
}

public enum CoreEventType: String, Codable, Equatable, Sendable {
  case runStarted = "RUN_STARTED"
  case textStart = "TEXT_START"
  case textDelta = "TEXT_DELTA"
  case textEnd = "TEXT_END"
  case reasoningDelta = "REASONING_DELTA"
  case toolCallStart = "TOOL_CALL_START"
  case toolCallArgs = "TOOL_CALL_ARGS"
  case toolCallEnd = "TOOL_CALL_END"
  case toolResult = "TOOL_RESULT"
  case modelCallStart = "MODEL_CALL_START"
  case modelCallEnd = "MODEL_CALL_END"
  case stateDelta = "STATE_DELTA"
  case runFinished = "RUN_FINISHED"
  case runError = "RUN_ERROR"
}

public struct RunStartedEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var threadId: String?

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, threadId: String? = nil) {
    self.type = .runStarted
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.threadId = threadId
  }
}

public struct TextStartEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var textId: String
  public var role: MessageRole

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, textId: String, role: MessageRole) {
    self.type = .textStart
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.textId = textId
    self.role = role
  }
}

public struct TextDeltaEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var textId: String
  public var delta: String

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, textId: String, delta: String) {
    self.type = .textDelta
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.textId = textId
    self.delta = delta
  }
}

public struct TextEndEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var textId: String
  public var text: String

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, textId: String, text: String) {
    self.type = .textEnd
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.textId = textId
    self.text = text
  }
}

public struct ReasoningDeltaEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var reasoningId: String
  public var delta: String

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, reasoningId: String, delta: String) {
    self.type = .reasoningDelta
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.reasoningId = reasoningId
    self.delta = delta
  }
}

public struct ToolCallStartEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var toolCallId: String
  public var toolId: String
  public var toolName: String
  public var modelName: String
  public var toolRuntime: ToolRuntime
  public var executionPolicy: ToolExecutionPolicy
  public var timeoutMs: Double?

  public init(
    eventId: String,
    sequence: Int,
    runId: String,
    messageId: String,
    timestamp: String,
    trace: TraceMetadata? = nil,
    toolCallId: String,
    toolId: String,
    toolName: String,
    modelName: String,
    toolRuntime: ToolRuntime,
    executionPolicy: ToolExecutionPolicy,
    timeoutMs: Double? = nil
  ) {
    self.type = .toolCallStart
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.toolRuntime = toolRuntime
    self.executionPolicy = executionPolicy
    self.timeoutMs = timeoutMs
  }
}

public struct ToolCallArgsEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var toolCallId: String
  public var toolId: String?
  public var delta: String?
  public var args: JSONObject?

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, toolCallId: String, toolId: String? = nil, delta: String? = nil, args: JSONObject? = nil) {
    self.type = .toolCallArgs
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.delta = delta
    self.args = args
  }
}

public struct ToolCallEndEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var toolCallId: String
  public var toolId: String
  public var toolName: String
  public var modelName: String
  public var toolRuntime: ToolRuntime
  public var executionPolicy: ToolExecutionPolicy
  public var timeoutMs: Double?
  public var args: JSONObject

  public init(
    eventId: String,
    sequence: Int,
    runId: String,
    messageId: String,
    timestamp: String,
    trace: TraceMetadata? = nil,
    toolCallId: String,
    toolId: String,
    toolName: String,
    modelName: String,
    toolRuntime: ToolRuntime,
    executionPolicy: ToolExecutionPolicy,
    timeoutMs: Double? = nil,
    args: JSONObject
  ) {
    self.type = .toolCallEnd
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.toolRuntime = toolRuntime
    self.executionPolicy = executionPolicy
    self.timeoutMs = timeoutMs
    self.args = args
  }
}

public struct ToolResultEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var toolCallId: String
  public var toolId: String?
  public var toolName: String
  public var modelName: String?
  public var toolRuntime: ToolRuntime?
  public var output: JSONValue
  public var isError: Bool?

  public init(
    eventId: String,
    sequence: Int,
    runId: String,
    messageId: String,
    timestamp: String,
    trace: TraceMetadata? = nil,
    toolCallId: String,
    toolId: String? = nil,
    toolName: String,
    modelName: String? = nil,
    toolRuntime: ToolRuntime? = nil,
    output: JSONValue,
    isError: Bool? = nil
  ) {
    self.type = .toolResult
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.toolCallId = toolCallId
    self.toolId = toolId
    self.toolName = toolName
    self.modelName = modelName
    self.toolRuntime = toolRuntime
    self.output = output
    self.isError = isError
  }
}

public struct ModelCallStartEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var modelCallId: String
  public var provider: String?
  public var model: String?

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, modelCallId: String, provider: String? = nil, model: String? = nil) {
    self.type = .modelCallStart
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.modelCallId = modelCallId
    self.provider = provider
    self.model = model
  }
}

public struct ModelCallEndEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var modelCallId: String
  public var status: ModelCallStatus
  public var finishReason: String?
  public var provider: String?
  public var model: String?
  public var providerRequestId: String?
  public var usage: ModelUsage?

  public init(
    eventId: String,
    sequence: Int,
    runId: String,
    messageId: String,
    timestamp: String,
    trace: TraceMetadata? = nil,
    modelCallId: String,
    status: ModelCallStatus,
    finishReason: String? = nil,
    provider: String? = nil,
    model: String? = nil,
    providerRequestId: String? = nil,
    usage: ModelUsage? = nil
  ) {
    self.type = .modelCallEnd
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.modelCallId = modelCallId
    self.status = status
    self.finishReason = finishReason
    self.provider = provider
    self.model = model
    self.providerRequestId = providerRequestId
    self.usage = usage
  }
}

public struct StateDeltaEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var delta: JSONObject

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, delta: JSONObject) {
    self.type = .stateDelta
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.delta = delta
  }
}

public struct RunFinishedEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var finishReason: RunFinishReason
  public var pendingToolCallId: String?
  public var pendingToolCallIds: [String]?

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, finishReason: RunFinishReason, pendingToolCallId: String? = nil, pendingToolCallIds: [String]? = nil) {
    self.type = .runFinished
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.finishReason = finishReason
    self.pendingToolCallId = pendingToolCallId
    self.pendingToolCallIds = pendingToolCallIds
  }
}

public struct RunErrorInfo: Codable, Equatable, Sendable {
  public var code: String
  public var message: String
  public var retryable: Bool?
  public var details: JSONObject?

  public init(code: String, message: String, retryable: Bool? = nil, details: JSONObject? = nil) {
    self.code = code
    self.message = message
    self.retryable = retryable
    self.details = details
  }
}

public struct RunErrorEvent: Codable, Equatable, Sendable {
  public let type: CoreEventType
  public var eventId: String
  public var sequence: Int
  public var runId: String
  public var messageId: String
  public var timestamp: String
  public var trace: TraceMetadata?
  public var error: RunErrorInfo

  public init(eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String, trace: TraceMetadata? = nil, error: RunErrorInfo) {
    self.type = .runError
    self.eventId = eventId
    self.sequence = sequence
    self.runId = runId
    self.messageId = messageId
    self.timestamp = timestamp
    self.trace = trace
    self.error = error
  }
}

public enum CoreEvent: Codable, Equatable, Sendable {
  case runStarted(RunStartedEvent)
  case textStart(TextStartEvent)
  case textDelta(TextDeltaEvent)
  case textEnd(TextEndEvent)
  case reasoningDelta(ReasoningDeltaEvent)
  case toolCallStart(ToolCallStartEvent)
  case toolCallArgs(ToolCallArgsEvent)
  case toolCallEnd(ToolCallEndEvent)
  case toolResult(ToolResultEvent)
  case modelCallStart(ModelCallStartEvent)
  case modelCallEnd(ModelCallEndEvent)
  case stateDelta(StateDeltaEvent)
  case runFinished(RunFinishedEvent)
  case runError(RunErrorEvent)

  private enum CodingKeys: String, CodingKey {
    case type
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(CoreEventType.self, forKey: .type)
    switch type {
    case .runStarted:
      self = .runStarted(try RunStartedEvent(from: decoder))
    case .textStart:
      self = .textStart(try TextStartEvent(from: decoder))
    case .textDelta:
      self = .textDelta(try TextDeltaEvent(from: decoder))
    case .textEnd:
      self = .textEnd(try TextEndEvent(from: decoder))
    case .reasoningDelta:
      self = .reasoningDelta(try ReasoningDeltaEvent(from: decoder))
    case .toolCallStart:
      self = .toolCallStart(try ToolCallStartEvent(from: decoder))
    case .toolCallArgs:
      self = .toolCallArgs(try ToolCallArgsEvent(from: decoder))
    case .toolCallEnd:
      self = .toolCallEnd(try ToolCallEndEvent(from: decoder))
    case .toolResult:
      self = .toolResult(try ToolResultEvent(from: decoder))
    case .modelCallStart:
      self = .modelCallStart(try ModelCallStartEvent(from: decoder))
    case .modelCallEnd:
      self = .modelCallEnd(try ModelCallEndEvent(from: decoder))
    case .stateDelta:
      self = .stateDelta(try StateDeltaEvent(from: decoder))
    case .runFinished:
      self = .runFinished(try RunFinishedEvent(from: decoder))
    case .runError:
      self = .runError(try RunErrorEvent(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case let .runStarted(value):
      try value.encode(to: encoder)
    case let .textStart(value):
      try value.encode(to: encoder)
    case let .textDelta(value):
      try value.encode(to: encoder)
    case let .textEnd(value):
      try value.encode(to: encoder)
    case let .reasoningDelta(value):
      try value.encode(to: encoder)
    case let .toolCallStart(value):
      try value.encode(to: encoder)
    case let .toolCallArgs(value):
      try value.encode(to: encoder)
    case let .toolCallEnd(value):
      try value.encode(to: encoder)
    case let .toolResult(value):
      try value.encode(to: encoder)
    case let .modelCallStart(value):
      try value.encode(to: encoder)
    case let .modelCallEnd(value):
      try value.encode(to: encoder)
    case let .stateDelta(value):
      try value.encode(to: encoder)
    case let .runFinished(value):
      try value.encode(to: encoder)
    case let .runError(value):
      try value.encode(to: encoder)
    }
  }
}

public extension CoreEvent {
  var runId: String {
    base.runId
  }

  var messageId: String {
    base.messageId
  }

  var eventId: String {
    base.eventId
  }

  var sequence: Int {
    base.sequence
  }

  var timestamp: String {
    base.timestamp
  }

  private var base: (eventId: String, sequence: Int, runId: String, messageId: String, timestamp: String) {
    switch self {
    case let .runStarted(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .textStart(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .textDelta(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .textEnd(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .reasoningDelta(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .toolCallStart(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .toolCallArgs(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .toolCallEnd(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .toolResult(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .modelCallStart(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .modelCallEnd(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .stateDelta(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .runFinished(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    case let .runError(event):
      return (event.eventId, event.sequence, event.runId, event.messageId, event.timestamp)
    }
  }
}

public func createID(_ prefix: String) -> String {
  "\(prefix)_\(UUID().uuidString.lowercased())"
}

public func nowISO() -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date())
}

public func inferToolRuntime(executionPolicy: ToolExecutionPolicy) -> ToolRuntime {
  executionPolicy == .server ? .server : .client
}

public func createToolID(executionPolicy: ToolExecutionPolicy, name: String) -> String {
  "\(inferToolRuntime(executionPolicy: executionPolicy).rawValue):\(name)"
}

public func createToolModelName(executionPolicy: ToolExecutionPolicy, name: String) -> String {
  "\(inferToolRuntime(executionPolicy: executionPolicy).rawValue)__\(sanitizeToolModelName(name))"
}

func validateToolDefinition(_ definition: ToolDefinition) throws {
  let normalized = definition.normalized()
  guard let modelName = normalized.modelName, modelName.range(of: #"^[a-zA-Z0-9_-]{1,64}$"#, options: .regularExpression) != nil else {
    throw MidoClientError.invalidToolDefinition("Invalid tool modelName \"\(normalized.modelName ?? "")\". Use letters, numbers, \"_\" or \"-\", and keep it under 64 characters.")
  }

  if let timeoutMs = normalized.timeoutMs, !timeoutMs.isFinite || timeoutMs < 0 {
    throw MidoClientError.invalidToolDefinition("Invalid timeoutMs for tool \"\(normalized.name)\". Use a finite number greater than or equal to 0.")
  }
}

private func sanitizeToolModelName(_ name: String) -> String {
  let sanitized = name
    .map { character in
      character.isLetter || character.isNumber || character == "_" || character == "-" ? character : "_"
    }
    .reduce(into: "") { result, character in
      if character == "_", result.last == "_" {
        return
      }
      result.append(character)
    }
    .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
  return sanitized.isEmpty ? "tool" : sanitized
}
