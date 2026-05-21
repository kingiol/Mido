import Foundation
import MidoClient

actor DemoMockTransport: AgentTransport {
  func startRun(_ request: RunStartRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    let runId = request.runId ?? createID("run")
    let messageId = "msg_mock_assistant"
    let userText = latestUserText(in: request).lowercased()

    if userText.contains("delete") || userText.contains("draft") {
      return eventStream([
        .runStarted(RunStartedEvent(eventId: createID("evt"), sequence: 1, runId: runId, messageId: messageId, timestamp: nowISO(), threadId: request.threadId)),
        .toolCallStart(ToolCallStartEvent(
          eventId: createID("evt"),
          sequence: 2,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          toolCallId: "tool_call_delete",
          toolId: "client:deleteDraft",
          toolName: "deleteDraft",
          modelName: "client__deleteDraft",
          toolRuntime: .client,
          executionPolicy: .clientInteractive
        )),
        .toolCallEnd(ToolCallEndEvent(
          eventId: createID("evt"),
          sequence: 3,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          toolCallId: "tool_call_delete",
          toolId: "client:deleteDraft",
          toolName: "deleteDraft",
          modelName: "client__deleteDraft",
          toolRuntime: .client,
          executionPolicy: .clientInteractive,
          args: ["id": "draft-demo"]
        )),
        .runFinished(RunFinishedEvent(
          eventId: createID("evt"),
          sequence: 4,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          finishReason: .awaitingClientTool,
          pendingToolCallId: "tool_call_delete",
          pendingToolCallIds: ["tool_call_delete"]
        ))
      ])
    }

    if userText.contains("weather") || userText.contains("location") {
      return eventStream([
        .runStarted(RunStartedEvent(eventId: createID("evt"), sequence: 1, runId: runId, messageId: messageId, timestamp: nowISO(), threadId: request.threadId)),
        .toolCallStart(ToolCallStartEvent(
          eventId: createID("evt"),
          sequence: 2,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          toolCallId: "tool_call_location",
          toolId: "client:deviceLocation",
          toolName: "deviceLocation",
          modelName: "client__deviceLocation",
          toolRuntime: .client,
          executionPolicy: .clientAuto
        )),
        .toolCallEnd(ToolCallEndEvent(
          eventId: createID("evt"),
          sequence: 3,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          toolCallId: "tool_call_location",
          toolId: "client:deviceLocation",
          toolName: "deviceLocation",
          modelName: "client__deviceLocation",
          toolRuntime: .client,
          executionPolicy: .clientAuto,
          args: [:]
        )),
        .runFinished(RunFinishedEvent(
          eventId: createID("evt"),
          sequence: 4,
          runId: runId,
          messageId: messageId,
          timestamp: nowISO(),
          finishReason: .awaitingClientTool,
          pendingToolCallId: "tool_call_location",
          pendingToolCallIds: ["tool_call_location"]
        ))
      ])
    }

    return textStream(
      runId: runId,
      messageId: messageId,
      threadId: request.threadId,
      text: "Mock reply: \(latestUserText(in: request))"
    )
  }

  func resume(_ request: RunResumeRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    let messageId = request.toolResult.messageId
    let text: String

    if request.toolResult.isError == true {
      text = "Tool call cancelled."
    } else if request.toolResult.toolName == "deviceLocation" {
      let city = request.toolResult.output.objectValue?["city"]?.stringValue ?? "Shanghai"
      text = "Weather for \(city): clear skies with a light breeze."
    } else if request.toolResult.toolName == "deleteDraft" {
      text = "Draft deleted."
    } else {
      text = "Tool result received."
    }

    var events: [CoreEvent] = [
      .toolResult(ToolResultEvent(
        eventId: createID("evt"),
        sequence: 5,
        runId: request.runId,
        messageId: messageId,
        timestamp: nowISO(),
        toolCallId: request.toolResult.toolCallId,
        toolId: request.toolResult.toolId,
        toolName: request.toolResult.toolName,
        modelName: request.toolResult.modelName,
        toolRuntime: .client,
        output: request.toolResult.output,
        isError: request.toolResult.isError
      ))
    ]
    events.append(contentsOf: textEvents(runId: request.runId, messageId: "msg_mock_final", startSequence: 6, text: text))
    return eventStream(events)
  }

  func cancelRun(_ request: RunCancelRequest) async throws -> CoreEvent? {
    .runFinished(RunFinishedEvent(
      eventId: createID("evt"),
      sequence: 99,
      runId: request.runId,
      messageId: "msg_mock_cancelled",
      timestamp: nowISO(),
      finishReason: .cancelled
    ))
  }

  private func textStream(runId: String, messageId: String, threadId: String?, text: String) -> AsyncThrowingStream<CoreEvent, Error> {
    var events: [CoreEvent] = [
      .runStarted(RunStartedEvent(eventId: createID("evt"), sequence: 1, runId: runId, messageId: messageId, timestamp: nowISO(), threadId: threadId))
    ]
    events.append(contentsOf: textEvents(runId: runId, messageId: messageId, startSequence: 2, text: text))
    return eventStream(events)
  }

  private func textEvents(runId: String, messageId: String, startSequence: Int, text: String) -> [CoreEvent] {
    let textId = "text_mock_\(startSequence)"
    return [
      .textStart(TextStartEvent(eventId: createID("evt"), sequence: startSequence, runId: runId, messageId: messageId, timestamp: nowISO(), textId: textId, role: .assistant)),
      .textDelta(TextDeltaEvent(eventId: createID("evt"), sequence: startSequence + 1, runId: runId, messageId: messageId, timestamp: nowISO(), textId: textId, delta: text)),
      .textEnd(TextEndEvent(eventId: createID("evt"), sequence: startSequence + 2, runId: runId, messageId: messageId, timestamp: nowISO(), textId: textId, text: text)),
      .runFinished(RunFinishedEvent(eventId: createID("evt"), sequence: startSequence + 3, runId: runId, messageId: messageId, timestamp: nowISO(), finishReason: .completed))
    ]
  }
}

private func latestUserText(in request: RunStartRequest) -> String {
  request.messages.last(where: { $0.role == .user })?.content.compactMap { part in
    if case let .text(textPart) = part {
      return textPart.text
    }
    return nil
  }.joined(separator: "\n") ?? ""
}

private func eventStream(_ events: [CoreEvent]) -> AsyncThrowingStream<CoreEvent, Error> {
  AsyncThrowingStream { continuation in
    for event in events {
      continuation.yield(event)
    }
    continuation.finish()
  }
}
