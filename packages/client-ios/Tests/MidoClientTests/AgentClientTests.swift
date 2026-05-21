import XCTest
@testable import MidoClient

final class AgentClientTests: XCTestCase {
  func testStreamingTextUpdatesTranscriptAndConversation() async throws {
    let transport = CapturingTransport(
      startEvents: [
        .runStarted(RunStartedEvent(eventId: "event_1", sequence: 1, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, threadId: "thread_test")),
        .textStart(TextStartEvent(eventId: "event_2", sequence: 2, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, textId: "text_1", role: .assistant)),
        .textDelta(TextDeltaEvent(eventId: "event_3", sequence: 3, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, textId: "text_1", delta: "Hello")),
        .textDelta(TextDeltaEvent(eventId: "event_4", sequence: 4, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, textId: "text_1", delta: " world")),
        .textEnd(TextEndEvent(eventId: "event_5", sequence: 5, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, textId: "text_1", text: "Hello world")),
        .runFinished(RunFinishedEvent(eventId: "event_6", sequence: 6, runId: "run_test", messageId: "msg_assistant", timestamp: timestamp, finishReason: .completed))
      ]
    )
    let client = AgentClient(transport: transport, threadId: "thread_test")

    try await client.sendMessage("Say hello", options: SendMessageOptions(runId: "run_test"))

    let snapshot = await client.getSnapshot()
    XCTAssertEqual(snapshot.status, .finished)
    XCTAssertEqual(snapshot.textTranscript, "Hello world")
    XCTAssertEqual(snapshot.conversationMessages.last?.content, [.text(TextPart(text: "Hello world"))])
  }

  func testAutoToolExecutesAndResumesRun() async throws {
    let transport = CapturingTransport(
      startEvents: [
        .runStarted(RunStartedEvent(eventId: "event_1", sequence: 1, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, threadId: "thread_test")),
        .toolCallEnd(ToolCallEndEvent(eventId: "event_2", sequence: 2, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, toolCallId: "tool_call_1", toolId: "client:getLocation", toolName: "getLocation", modelName: "client__getLocation", toolRuntime: .client, executionPolicy: .clientAuto, args: [:])),
        .runFinished(RunFinishedEvent(eventId: "event_3", sequence: 3, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, finishReason: .awaitingClientTool, pendingToolCallId: "tool_call_1"))
      ],
      resumeEvents: [
        .toolResult(ToolResultEvent(eventId: "event_4", sequence: 4, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, toolCallId: "tool_call_1", toolId: "client:getLocation", toolName: "getLocation", modelName: "client__getLocation", toolRuntime: .client, output: ["city": "Shanghai"])),
        .textEnd(TextEndEvent(eventId: "event_5", sequence: 5, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, textId: "text_1", text: "It is sunny.")),
        .runFinished(RunFinishedEvent(eventId: "event_6", sequence: 6, runId: "run_tool", messageId: "msg_assistant", timestamp: timestamp, finishReason: .completed))
      ]
    )
    let client = AgentClient(transport: transport, threadId: "thread_test")
    try await client.registerClientTool(RegisteredClientTool(
      definition: ToolDefinition(
        name: "getLocation",
        description: "Read current city.",
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

    try await client.sendMessage("weather here", options: SendMessageOptions(runId: "run_tool"))

    let resumeRequests = await transport.resumeRequests()
    XCTAssertEqual(resumeRequests.count, 1)
    XCTAssertEqual(resumeRequests[0].toolResult.toolCallId, "tool_call_1")
    XCTAssertEqual(resumeRequests[0].toolResult.output, ["city": "Shanghai"])
    let snapshot = await client.getSnapshot()
    XCTAssertEqual(snapshot.status, .finished)
  }

  func testInteractiveToolRejectionResumesWithErrorResult() async throws {
    let transport = CapturingTransport(
      startEvents: [
        .runStarted(RunStartedEvent(eventId: "event_1", sequence: 1, runId: "run_delete", messageId: "msg_assistant", timestamp: timestamp, threadId: "thread_test")),
        .toolCallEnd(ToolCallEndEvent(eventId: "event_2", sequence: 2, runId: "run_delete", messageId: "msg_assistant", timestamp: timestamp, toolCallId: "tool_call_1", toolId: "client:deleteDraft", toolName: "deleteDraft", modelName: "client__deleteDraft", toolRuntime: .client, executionPolicy: .clientInteractive, args: ["id": "draft_1"])),
        .runFinished(RunFinishedEvent(eventId: "event_3", sequence: 3, runId: "run_delete", messageId: "msg_assistant", timestamp: timestamp, finishReason: .awaitingClientTool, pendingToolCallId: "tool_call_1"))
      ],
      resumeEvents: [
        .runFinished(RunFinishedEvent(eventId: "event_4", sequence: 4, runId: "run_delete", messageId: "msg_assistant", timestamp: timestamp, finishReason: .completed))
      ]
    )
    let client = AgentClient(transport: transport, threadId: "thread_test")
    try await client.registerClientTool(RegisteredClientTool(
      definition: ToolDefinition(
        name: "deleteDraft",
        description: "Delete a draft after approval.",
        inputSchema: ["type": "object", "required": ["id"], "properties": ["id": ["type": "string"]]],
        resultSchema: ["type": "object", "additionalProperties": true],
        executionPolicy: .clientInteractive
      ),
      execute: { _, _ in ["deleted": true] }
    ))

    try await client.startRun(RunStartRequest(runId: "run_delete", threadId: "thread_test", messages: [userMessage("delete draft")]))
    let awaitingSnapshot = await client.getSnapshot()
    XCTAssertEqual(awaitingSnapshot.pendingInteractiveTools.count, 1)

    try await client.rejectToolCall("tool_call_1", reason: "User denied deletion")

    let resumeRequests = await transport.resumeRequests()
    XCTAssertEqual(resumeRequests.first?.toolResult.isError, true)
    XCTAssertEqual(resumeRequests.first?.toolResult.output, ["code": "client_tool_rejected", "message": "User denied deletion"])
  }

  func testRegisteredClientToolsAreAdvertisedWithoutHandlers() async throws {
    let transport = CapturingTransport(startEvents: [
      .runFinished(RunFinishedEvent(eventId: "event_1", sequence: 1, runId: "run_tools", messageId: "msg_assistant", timestamp: timestamp, finishReason: .completed))
    ])
    let client = AgentClient(transport: transport)
    try await client.registerClientTool(RegisteredClientTool(
      definition: ToolDefinition(
        name: "getBattery",
        description: "Read battery level.",
        inputSchema: ["type": "object", "additionalProperties": true],
        resultSchema: ["type": "number"],
        executionPolicy: .clientAuto
      ),
      execute: { _, _ in 0.8 }
    ))

    try await client.startRun(RunStartRequest(runId: "run_tools", messages: [userMessage("battery")]))

    let startRequests = await transport.startRequests()
    XCTAssertEqual(startRequests.first?.clientTools?.first?.toolId, "client:getBattery")
    XCTAssertNoThrow(try JSONEncoder.mido.encode(startRequests.first?.clientTools))
  }
}

private let timestamp = "2026-04-28T00:00:00.000Z"

private func userMessage(_ text: String) -> AgentMessage {
  AgentMessage.text(role: .user, text: text, id: "msg_user", createdAt: timestamp)
}

private actor CapturingTransport: AgentTransport {
  private var capturedStartRequests: [RunStartRequest] = []
  private var capturedResumeRequests: [RunResumeRequest] = []
  private let startEvents: [CoreEvent]
  private let resumeEvents: [CoreEvent]

  init(startEvents: [CoreEvent], resumeEvents: [CoreEvent] = []) {
    self.startEvents = startEvents
    self.resumeEvents = resumeEvents
  }

  func startRun(_ request: RunStartRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    capturedStartRequests.append(request)
    return eventStream(startEvents)
  }

  func resume(_ request: RunResumeRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    capturedResumeRequests.append(request)
    return eventStream(resumeEvents)
  }

  func startRequests() -> [RunStartRequest] {
    capturedStartRequests
  }

  func resumeRequests() -> [RunResumeRequest] {
    capturedResumeRequests
  }
}

private func eventStream(_ events: [CoreEvent]) -> AsyncThrowingStream<CoreEvent, Error> {
  AsyncThrowingStream { continuation in
    for event in events {
      continuation.yield(event)
    }
    continuation.finish()
  }
}
